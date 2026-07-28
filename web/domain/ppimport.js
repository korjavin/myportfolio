// Portfolio Performance importer. Pure module (ARCHITECTURE.md §1): no window,
// document, fetch or indexedDB, no I/O — it takes the file *text* and returns
// §4 records plus a per-row report. The caller writes the records through the
// §3 port.
//
// Two input formats, auto-detected:
//
//   .xml   PP's unencrypted client file (XStream-serialised object graph)
//   .csv   PP's transaction export (one file per account/securities account)
//
// Why the numbers survive: PP's own fixed-point scales are the ones §5 pins —
// amounts 1e2, shares 1e8, quotes 1e8. In the XML they are already *integers in
// those scales*, so importing them is a string->int parse with no arithmetic and
// no rounding anywhere. The one exception is PP's <exchangeRate>, which is a
// BigDecimal of arbitrary precision and therefore genuinely has to be rounded to
// our fx scale; that rounding is reported when it loses a digit.
//
// The three rules this module exists to enforce:
//
//   1. Nothing is dropped silently. Every source row either becomes a record,
//      is merged into one (PP writes a trade twice — see below), or produces a
//      report entry naming its location. counts.sourceRows always equals
//      imported + merged + skipped.
//   2. Import is idempotent. Every recordId is derived from PP's own uuid, or
//      from a hash of the row's content — never from insertion order — so
//      re-importing the same file re-derives the same ids and put()s overwrite
//      instead of duplicating.
//   3. Where PP's model and ours disagree the mismatch is reported, not guessed
//      around. Security transfers (myportfolio-g7e.10) are refused, not faked.
//
// No XML parser dependency, and deliberately no DOMParser either: DOMParser
// exists in browsers but not in Node, so using it would mean the tests exercise
// a different parser than production. The scanner below is ~70 lines and runs
// identically in both.

import { RECORD } from './schema.js';
import { parseFixed, DECIMALS } from './money.js';

// PP applied its share/quote precision migrations when loading a file at
// version < 49 (ClientFactory.upgradeModel: shares 6->8 digits, quotes 4->8).
// Below that the integers in the file are on *different scales*, and importing
// them as-is would silently produce a portfolio wrong by 10^4. Refused rather
// than migrated: opening and re-saving in any current PP upgrades the file.
// ponytail: version floor instead of porting PP's migration chain. If old
// archives ever matter, port the scale-only migrations, not all of upgradeModel.
const MIN_CLIENT_VERSION = 49;

// PP transaction type -> §4 transaction type. The refund/charge types have no
// §4 counterpart of their own; they are PP's sign-flipped twins of the base
// type, so they map to the base type with a negative `amount` — which every
// §4 consumer already handles, since CASH_SIGN multiplies the amount. That is a
// reinterpretation, so each one still gets a report entry.
const ACCOUNT_TX_TYPES = {
  DEPOSIT: { type: 'deposit' },
  REMOVAL: { type: 'removal' },
  INTEREST: { type: 'interest' },
  INTEREST_CHARGE: { type: 'interest', negate: true },
  DIVIDENDS: { type: 'dividend' },
  FEES: { type: 'fee' },
  FEES_REFUND: { type: 'fee', negate: true },
  TAXES: { type: 'tax' },
  TAX_REFUND: { type: 'tax', negate: true },
  TRANSFER_IN: { type: 'transfer_in' },
  TRANSFER_OUT: { type: 'transfer_out' },
  // BUY/SELL are handled from their cross-entry, not from this table.
};

// §4: "Security transfers are not representable in v1 — there is no way to
// express carried-over cost basis". PP's portfolio transfers and its deliveries
// are exactly that, so they are refused with a report entry.
const UNSUPPORTED_PORTFOLIO_TX = {
  TRANSFER_IN: 'moves shares between securities accounts',
  TRANSFER_OUT: 'moves shares between securities accounts',
  DELIVERY_INBOUND: 'delivers shares in without a cash leg',
  DELIVERY_OUTBOUND: 'delivers shares out without a cash leg',
};

const G7E10 = 'carried-over cost basis is not representable in v1 (myportfolio-g7e.10);'
  + ' the row was not imported so no gain number is silently wrong';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// Every entry carries a location the UI can point at: {path} into the XML, or
// {row, line} into the CSV. `raw` is the source text of the row where there is
// one, so "we could not read this" can show *what* it could not read.
function createReport() {
  const entries = [];
  const counts = { sourceRows: 0, imported: 0, merged: 0, skipped: 0 };
  return {
    entries,
    counts,
    add(severity, code, location, message, raw) {
      entries.push({ severity, code, location, message, ...(raw === undefined ? {} : { raw }) });
    },
    get ok() { return !entries.some((e) => e.severity === 'error'); },
  };
}

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

// FNV-1a, 64-bit. Only needs to be collision-free across one portfolio's few
// thousand rows; 64 bits gives that with ~11 orders of magnitude of headroom.
// Not a security primitive and not used as one.
function hash64(s) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// §4's newRecordId() is `<type>_<ms>_<rand>` — deliberately random, which is
// exactly wrong for import: a second import would mint new ids and double the
// portfolio. These ids keep the shape but derive the tail, so the same input
// always yields the same recordId.
const idFrom = (type, key) => `${type}_pp_${key}`;
const idHashed = (type, key) => idFrom(type, hash64(key));

// ---------------------------------------------------------------------------
// XML: scanner
// ---------------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

const ATTR_RE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(s) {
  const attrs = {};
  if (!s) return attrs;
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(s);
  while (m) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
    m = ATTR_RE.exec(s);
  }
  return attrs;
}

// Finds the '>' that closes the tag starting at `lt`, ignoring any '>' that
// sits inside a quoted attribute value (PP puts URLs in bookmark patterns).
function tagEnd(src, lt) {
  let quote = null;
  for (let i = lt + 1; i < src.length; i += 1) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

// Minimal XML -> tree. Enough for XStream output: elements, attributes, text,
// comments, CDATA, prolog. No namespaces (PP emits none), no DTD, no entity
// declarations.
function parseXml(src) {
  const doc = { name: '#doc', attrs: {}, children: [], text: '' };
  const stack = [doc];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end < 0) throw new SyntaxError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) throw new SyntaxError('unterminated CDATA');
      top().text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      if (end < 0) throw new SyntaxError('unterminated declaration');
      i = end + 1;
      continue;
    }

    const gt = tagEnd(src, lt);
    if (gt < 0) throw new SyntaxError(`unterminated tag at offset ${lt}`);
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      if (stack.length < 2) throw new SyntaxError(`unexpected </${name}>`);
      const open = stack.pop();
      if (open.name !== name) throw new SyntaxError(`</${name}> closes <${open.name}>`);
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([\w.:-]+)([\s\S]*)$/.exec(body);
    if (!m) throw new SyntaxError(`malformed tag <${raw}>`);
    const node = { name: m[1], attrs: parseAttrs(m[2]), children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) throw new SyntaxError(`unclosed <${top().name}>`);
  const root = doc.children.find((c) => c.name);
  if (!root) throw new SyntaxError('no root element');
  return root;
}

// ---------------------------------------------------------------------------
// XML: XStream reference resolution
// ---------------------------------------------------------------------------
//
// PP saves .xml with XStream's XPATH_RELATIVE_REFERENCES (ClientFactory's
// PlainWriter defaults idReferences=false), so a shared object appears once and
// every other occurrence is `reference="../../foo/bar[2]"` — a path relative to
// the *referencing element*. ID_REFERENCES (`id="7"` / `reference="7"`) is the
// opt-in alternative; both are handled.
//
// This is not optional detail: in a real file the top-level <accounts> and
// <portfolios> lists are often nothing but references into objects defined five
// levels deep inside somebody's crossEntry. Without resolution the importer
// sees an empty portfolio.

function indexTree(root) {
  const byPath = new Map();
  const byId = new Map();
  const walk = (node, path) => {
    node.path = path;
    byPath.set(path, node);
    if (node.attrs.id !== undefined) byId.set(node.attrs.id, node);
    const seen = new Map();
    for (const child of node.children) {
      const n = (seen.get(child.name) ?? 0) + 1;
      seen.set(child.name, n);
      walk(child, `${path}/${child.name}[${n}]`);
    }
  };
  walk(root, `/${root.name}[1]`);
  return { byPath, byId };
}

const STEP_RE = /^([\w.:-]+)(?:\[(\d+)\])?$/;

function resolveRelative(node, ref, index) {
  let path = node.path;
  for (const step of ref.split('/')) {
    if (step === '' || step === '.') continue;
    if (step === '..') {
      const cut = path.lastIndexOf('/');
      if (cut < 0) return null;
      path = path.slice(0, cut);
      continue;
    }
    const m = STEP_RE.exec(step);
    if (!m) return null;
    path = `${path}/${m[1]}[${m[2] ?? '1'}]`;
  }
  return index.byPath.get(path) ?? null;
}

// Follows `reference` attributes to the element that actually holds the data.
// Returns null when a reference dangles, so callers surface it instead of
// reading undefined fields off a placeholder.
function deref(node, ctx) {
  let current = node;
  for (let hops = 0; current && current.attrs.reference !== undefined; hops += 1) {
    if (hops > 32) return null; // reference cycle; PP never writes one
    const ref = current.attrs.reference;
    const target = /^\d+$/.test(ref)
      ? (ctx.index.byId.get(ref) ?? resolveRelative(current, ref, ctx.index))
      : resolveRelative(current, ref, ctx.index);
    if (!target) {
      ctx.report.add('error', 'pp_unresolved_reference', { path: current.path },
        `reference="${ref}" does not resolve to any element`);
      return null;
    }
    current = target;
  }
  return current;
}

const childrenNamed = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);

function childNamed(node, name, ctx) {
  if (!node) return null;
  const c = node.children.find((x) => x.name === name);
  return c ? deref(c, ctx) : null;
}

function textOf(node, name, ctx) {
  const c = childNamed(node, name, ctx);
  if (!c) return null;
  const t = c.text.trim();
  return t === '' ? null : t;
}

// Deref every member of a list, dropping (and reporting) the ones that dangle.
const derefAll = (nodes, ctx) => nodes.map((n) => deref(n, ctx)).filter(Boolean);

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

// PP's XML integers are already on our scales, so this is a parse and a range
// check — never arithmetic. A value that is not a plain integer means the file
// is not what we think it is, so it is reported rather than coerced.
function intOf(raw, location, field, ctx, fallback = null) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw)) {
    ctx.report.add('warning', 'pp_bad_number', location, `${field} is not an integer: ${JSON.stringify(raw)}`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    ctx.report.add('warning', 'pp_bad_number', location, `${field} exceeds the safe integer range: ${raw}`);
    return fallback;
  }
  return n;
}

const dayOf = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);

// ---------------------------------------------------------------------------
// XML importer
// ---------------------------------------------------------------------------

function importXml(text, options, report) {
  const records = [];
  let root;
  try {
    root = parseXml(text);
  } catch (err) {
    report.add('error', 'xml_unparseable', {}, `could not parse the file as XML: ${err.message}`);
    return records;
  }
  if (root.name !== 'client') {
    report.add('error', 'xml_not_a_client_file', { path: root.path ?? `/${root.name}` },
      `expected a Portfolio Performance <client> file, found <${root.name}>`);
    return records;
  }

  const index = indexTree(root);
  const ctx = { index, report };

  const version = Number(textOf(root, 'version', ctx));
  if (!Number.isFinite(version)) {
    report.add('error', 'pp_version_missing', { path: root.path },
      'the file has no <version>; it is not a Portfolio Performance client file');
    return records;
  }
  if (version < MIN_CLIENT_VERSION) {
    report.add('error', 'pp_version_unsupported', { path: root.path },
      `file format version ${version} stores shares and quotes on pre-v${MIN_CLIENT_VERSION} scales, `
      + 'so importing it would be wrong by a factor of 10000. Open and re-save the file in a current '
      + 'Portfolio Performance to upgrade it, then import again.');
    return records;
  }

  const baseCurrency = textOf(root, 'baseCurrency', ctx);

  // --- registries ---------------------------------------------------------
  // Keyed by the resolved DOM node, which *is* the object identity in an
  // XStream graph: every reference to an account resolves to the same node, so
  // node identity dedupes without comparing fields.
  const securityIds = new Map();
  const accountIds = new Map();
  const securityNodes = new Map(); // id -> node, for the price pass

  function securityId(node) {
    if (!node) return null;
    const known = securityIds.get(node);
    if (known) return known;
    const uuid = textOf(node, 'uuid', ctx);
    const name = textOf(node, 'name', ctx);
    const isin = textOf(node, 'isin', ctx);
    const ticker = textOf(node, 'tickerSymbol', ctx);
    const id = uuid
      ? idFrom(RECORD.security, uuid)
      : idHashed(RECORD.security, `security|${isin ?? ''}|${ticker ?? ''}|${name ?? ''}`);
    securityIds.set(node, id);
    securityNodes.set(id, node);
    records.push({
      recordType: RECORD.security,
      recordId: id,
      name: name ?? ticker ?? isin ?? '(unnamed security)',
      ...(isin ? { isin } : {}),
      ...(ticker ? { ticker } : {}),
      currency: textOf(node, 'currencyCode', ctx) ?? baseCurrency,
      // PP has no per-security asset class — it classifies through taxonomies,
      // which §4 defers past v1. Left null rather than guessed at.
      assetClass: null,
      // PP's <feed> ids (YAHOO, PORTFOLIO-REPORT, ...) are not §7 providers, so
      // the symbol carries over and the provider has to be chosen by the user.
      quote: { provider: null, symbol: ticker ?? null },
    });
    return id;
  }

  function accountId(node, kind) {
    if (!node) return null;
    const known = accountIds.get(node);
    if (known) return known;
    const uuid = textOf(node, 'uuid', ctx);
    const name = textOf(node, 'name', ctx);
    const id = uuid
      ? idFrom(RECORD.account, uuid)
      : idHashed(RECORD.account, `account|${kind}|${name ?? ''}`);
    accountIds.set(node, id);
    const currency = kind === 'securities'
      ? textOf(childNamed(node, 'referenceAccount', ctx), 'currencyCode', ctx) ?? baseCurrency
      : textOf(node, 'currencyCode', ctx) ?? baseCurrency;
    records.push({
      recordType: RECORD.account,
      recordId: id,
      name: name ?? '(unnamed account)',
      kind,
      currency,
      closed: textOf(node, 'isRetired', ctx) === 'true',
    });
    return id;
  }

  // --- transactions -------------------------------------------------------

  const emittedTx = new Set();   // transaction nodes already turned into a record
  const emittedTrade = new Map(); // buysell crossEntry node -> recordId
  const dupCounts = new Map();

  function txRecordId(node, key) {
    const uuid = textOf(node, 'uuid', ctx);
    if (uuid) return idFrom(RECORD.transaction, uuid);
    // No uuid (PP added them at file version 50). Two genuinely identical rows
    // — same day, same security, same amount — are a real thing and must stay
    // two records, so identical keys get an occurrence suffix. That is not
    // insertion-order keying: the *set* of ids is the same whichever identical
    // row is seen first, because the rows are identical.
    const n = (dupCounts.get(key) ?? 0) + 1;
    dupCounts.set(key, n);
    return idHashed(RECORD.transaction, n === 1 ? key : `${key}#${n}`);
  }

  // <units><unit type="FEE"><amount currency="EUR" amount="2715"/></unit>...
  function unitsOf(node, currency, location) {
    const out = { fees: 0, taxes: 0, fx: null };
    const container = childNamed(node, 'units', ctx);
    for (const unitRef of childrenNamed(container, 'unit')) {
      const unit = deref(unitRef, ctx);
      if (!unit) continue;
      const kind = unit.attrs.type;
      const amountEl = childNamed(unit, 'amount', ctx);
      const value = intOf(amountEl?.attrs.amount ?? null, location, `unit ${kind} amount`, ctx, 0);
      if (kind === 'FEE' || kind === 'TAX') {
        const unitCurrency = amountEl?.attrs.currency ?? currency;
        if (currency && unitCurrency && unitCurrency !== currency) {
          report.add('warning', 'pp_unit_currency_mismatch', location,
            `${kind} unit is in ${unitCurrency} but the transaction is in ${currency}; summed as ${currency}`);
        }
        out[kind === 'FEE' ? 'fees' : 'taxes'] += value;
      } else if (kind === 'GROSS_VALUE') {
        const rate = textOf(unit, 'exchangeRate', ctx);
        if (rate) {
          // The one genuinely lossy conversion in the whole importer: PP's
          // exchange rate is a BigDecimal, §5 pins fx at 1e8.
          const frac = /\.(\d+)$/.exec(rate);
          if (frac && frac[1].length > DECIMALS.fx) {
            report.add('warning', 'pp_fx_rounded', location,
              `exchange rate ${rate} has more than ${DECIMALS.fx} decimals and was rounded to our fx scale`);
          }
          try {
            out.fx = parseFixed(rate, DECIMALS.fx);
          } catch (err) {
            report.add('warning', 'pp_bad_number', location, `exchange rate ${JSON.stringify(rate)}: ${err.message}`);
          }
        }
      } else if (kind) {
        report.add('warning', 'pp_unknown_unit', location,
          `unit type ${kind} is not one of FEE/TAX/GROSS_VALUE and was ignored`);
      }
    }
    return out;
  }

  // A PP trade is one object written twice: an <account-transaction> on the cash
  // side and a <portfolio-transaction> on the securities side, both pointing at
  // the same <crossEntry class="buysell">. §4 models it as ONE record, so the
  // cross-entry node is the dedupe key — reaching it from either side yields the
  // same record, and the second sighting is counted as merged, not dropped.
  function emitTrade(crossEntry, ppType, location) {
    if (emittedTrade.has(crossEntry)) {
      report.counts.merged += 1;
      return;
    }
    const portfolioTx = childNamed(crossEntry, 'portfolioTransaction', ctx);
    const cashAccount = childNamed(crossEntry, 'account', ctx);
    if (!portfolioTx) {
      report.add('warning', 'pp_trade_incomplete', location,
        `${ppType} cross-entry has no <portfolioTransaction>, so its share count is unknown; not imported`);
      report.counts.skipped += 1;
      return;
    }
    const txLocation = { path: portfolioTx.path };
    const currency = textOf(portfolioTx, 'currencyCode', ctx) ?? baseCurrency;
    const date = dayOf(textOf(portfolioTx, 'date', ctx));
    const amount = intOf(textOf(portfolioTx, 'amount', ctx), txLocation, 'amount', ctx);
    const shares = intOf(textOf(portfolioTx, 'shares', ctx), txLocation, 'shares', ctx);
    const secId = securityId(childNamed(portfolioTx, 'security', ctx));
    const acctId = accountId(cashAccount, 'cash');
    const note = textOf(portfolioTx, 'note', ctx);
    const { fees, taxes, fx } = unitsOf(portfolioTx, currency, txLocation);

    if (!date || amount === null || shares === null || !secId || !acctId) {
      report.add('warning', 'pp_trade_incomplete', txLocation,
        `${ppType} is missing ${[!date && 'date', amount === null && 'amount', shares === null && 'shares',
          !secId && 'security', !acctId && 'cash account'].filter(Boolean).join(', ')}; not imported`);
      report.counts.skipped += 1;
      return;
    }

    const key = [ppType, acctId, secId, date, shares, amount, fees, taxes, currency, note ?? ''].join('|');
    const recordId = txRecordId(portfolioTx, key);
    records.push({
      recordType: RECORD.transaction,
      recordId,
      // §4: `amount` is the cash that actually moved — gross + fees + taxes on a
      // buy, gross - fees - taxes on a sell. That is exactly what PP stores in
      // <amount>, which is the whole reason import round-trips.
      type: ppType === 'BUY' ? 'buy' : 'sell',
      accountId: acctId,
      securityId: secId,
      date,
      shares,
      amount,
      ...(fees ? { fees } : {}),
      ...(taxes ? { taxes } : {}),
      currency,
      ...(fx ? { fx } : {}),
      ...(note ? { note } : {}),
    });
    emittedTrade.set(crossEntry, recordId);
    report.counts.imported += 1;
  }

  function emitAccountTransaction(node, ownerAccountNode) {
    const location = { path: node.path };
    const ppType = textOf(node, 'type', ctx);
    report.counts.sourceRows += 1;

    if (ppType === 'BUY' || ppType === 'SELL') {
      const crossEntry = childNamed(node, 'crossEntry', ctx);
      if (!crossEntry || crossEntry.attrs.class !== 'buysell') {
        report.add('warning', 'pp_trade_incomplete', location,
          `${ppType} on a cash account has no buysell cross-entry, so its shares and security are unknown; not imported`);
        report.counts.skipped += 1;
        return;
      }
      emitTrade(crossEntry, ppType, location);
      return;
    }

    const mapping = ACCOUNT_TX_TYPES[ppType];
    if (!mapping) {
      report.add('warning', 'pp_unmapped_transaction_type', location,
        `Portfolio Performance transaction type ${JSON.stringify(ppType)} has no §4 equivalent; not imported`);
      report.counts.skipped += 1;
      return;
    }

    const currency = textOf(node, 'currencyCode', ctx) ?? baseCurrency;
    const date = dayOf(textOf(node, 'date', ctx));
    const rawAmount = intOf(textOf(node, 'amount', ctx), location, 'amount', ctx);
    const acctId = accountId(ownerAccountNode, 'cash');
    if (!date || rawAmount === null || !acctId) {
      report.add('warning', 'pp_row_incomplete', location,
        `${ppType} is missing ${[!date && 'date', rawAmount === null && 'amount', !acctId && 'account']
          .filter(Boolean).join(', ')}; not imported`);
      report.counts.skipped += 1;
      return;
    }

    if (mapping.negate) {
      report.add('warning', 'pp_type_reinterpreted', location,
        `${ppType} has no §4 type of its own; imported as a "${mapping.type}" with a negative amount, `
        + 'which moves the cash the same way PP does');
    }
    const amount = mapping.negate ? -rawAmount : rawAmount;
    const secNode = childNamed(node, 'security', ctx);
    const secId = secNode ? securityId(secNode) : null;
    const shares = intOf(textOf(node, 'shares', ctx), location, 'shares', ctx, 0);
    const note = textOf(node, 'note', ctx);
    const { fees, taxes, fx } = unitsOf(node, currency, location);

    // §4: a transfer is two records, one per leg, linked by counterAccountId —
    // and the counter leg is NOT booked from this record. PP writes both legs
    // too, so each is imported from its own account and the pairing is kept.
    let counterAccountId = null;
    if (mapping.type === 'transfer_in' || mapping.type === 'transfer_out') {
      const crossEntry = childNamed(node, 'crossEntry', ctx);
      const from = childNamed(crossEntry, 'accountFrom', ctx);
      const to = childNamed(crossEntry, 'accountTo', ctx);
      const counter = mapping.type === 'transfer_out' ? to : from;
      if (counter) counterAccountId = accountId(counter, 'cash');
      else {
        report.add('warning', 'pp_transfer_leg_unpaired', location,
          `${ppType} has no counter account in its cross-entry; imported without counterAccountId`);
      }
    }

    if (mapping.type === 'dividend' && !secId) {
      report.add('warning', 'pp_row_incomplete', location,
        'DIVIDENDS has no security; not imported (a dividend must be attributable to a holding)');
      report.counts.skipped += 1;
      return;
    }

    const key = [ppType, acctId, secId ?? '', date, shares, amount, fees, taxes, currency,
      counterAccountId ?? '', note ?? ''].join('|');
    records.push({
      recordType: RECORD.transaction,
      recordId: txRecordId(node, key),
      type: mapping.type,
      accountId: acctId,
      ...(secId ? { securityId: secId } : {}),
      date,
      ...(shares ? { shares } : {}),
      amount,
      ...(fees ? { fees } : {}),
      ...(taxes ? { taxes } : {}),
      currency,
      ...(fx ? { fx } : {}),
      ...(counterAccountId ? { counterAccountId } : {}),
      ...(note ? { note } : {}),
    });
    report.counts.imported += 1;
  }

  function emitPortfolioTransaction(node) {
    const location = { path: node.path };
    const ppType = textOf(node, 'type', ctx);
    report.counts.sourceRows += 1;

    if (ppType === 'BUY' || ppType === 'SELL') {
      const crossEntry = childNamed(node, 'crossEntry', ctx);
      if (!crossEntry || crossEntry.attrs.class !== 'buysell') {
        report.add('warning', 'pp_trade_incomplete', location,
          `${ppType} has no buysell cross-entry, so the cash account it settled against is unknown; not imported`);
        report.counts.skipped += 1;
        return;
      }
      emitTrade(crossEntry, ppType, location);
      return;
    }

    const why = UNSUPPORTED_PORTFOLIO_TX[ppType];
    if (why) {
      report.add('warning', 'security_transfer_unsupported', location,
        `${ppType} ${why}: ${G7E10}`);
    } else {
      report.add('warning', 'pp_unmapped_transaction_type', location,
        `Portfolio Performance securities-account transaction type ${JSON.stringify(ppType)} has no §4 equivalent; not imported`);
    }
    report.counts.skipped += 1;
  }

  // --- walk ---------------------------------------------------------------

  const accountNodes = derefAll(childrenNamed(childNamed(root, 'accounts', ctx), 'account'), ctx);
  const portfolioNodes = derefAll(childrenNamed(childNamed(root, 'portfolios', ctx), 'portfolio'), ctx);
  for (const node of accountNodes) accountId(node, 'cash');
  for (const node of portfolioNodes) accountId(node, 'securities');

  for (const account of accountNodes) {
    for (const tx of derefAll(childrenNamed(childNamed(account, 'transactions', ctx), 'account-transaction'), ctx)) {
      if (emittedTx.has(tx)) continue;
      emittedTx.add(tx);
      emitAccountTransaction(tx, account);
    }
  }
  for (const portfolio of portfolioNodes) {
    for (const tx of derefAll(childrenNamed(childNamed(portfolio, 'transactions', ctx), 'portfolio-transaction'), ctx)) {
      if (emittedTx.has(tx)) continue;
      emittedTx.add(tx);
      emitPortfolioTransaction(tx);
    }
  }

  // --- prices -------------------------------------------------------------
  // Securities defined outside <securities> (reachable only through a
  // transaction) are registered by then, so iterate the registry rather than
  // the list and no security's history is missed.
  for (const secNode of derefAll(childrenNamed(childNamed(root, 'securities', ctx), 'security'), ctx)) {
    securityId(secNode);
  }
  for (const [secId, node] of securityNodes) {
    const byYear = new Map();
    const addClose = (t, v, location) => {
      const date = dayOf(t);
      // §4 pins zero-padded "MM-DD" keys: an unpadded key sorts above every
      // well-formed one as a string and would win the latest-close race. PP
      // writes ISO dates, so this validates rather than formats.
      if (!date || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) {
        report.add('warning', 'pp_bad_price_date', location, `price date ${JSON.stringify(t)} is not YYYY-MM-DD`);
        return;
      }
      const close = intOf(v, location, 'price', ctx);
      if (close === null) return;
      const year = date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, {});
      byYear.get(year)[date.slice(5)] = close;
    };

    const prices = childNamed(node, 'prices', ctx);
    for (const p of childrenNamed(prices, 'price')) {
      const price = deref(p, ctx);
      if (price) addClose(price.attrs.t, price.attrs.v, { path: price.path });
    }
    // <latest> is PP's most recent fetched quote and is often the only price a
    // freshly-configured security has, so dropping it would leave the position
    // unvalued. Applied after the history so it wins for its own day.
    const latest = childNamed(node, 'latest', ctx);
    if (latest && latest.attrs.t) addClose(latest.attrs.t, latest.attrs.v, { path: latest.path });

    for (const [year, closes] of byYear) {
      records.push({
        recordType: RECORD.price,
        recordId: idHashed(RECORD.price, `${secId}|${year}`),
        securityId: secId,
        year,
        closes,
      });
    }
  }

  // Deliberately NOT emitted as a `settings` record. §4 makes settings a
  // singleton at a fixed recordId whose body also holds quoteProviders, and the
  // §3 port replaces a body wholesale — so writing {reportingCurrency} here
  // would silently wipe the user's quote configuration. Reported instead, for
  // the caller to merge.
  if (baseCurrency) {
    report.add('info', 'pp_base_currency', { path: root.path },
      `the file's base currency is ${baseCurrency}; set it as the reporting currency if it differs from yours`);
  }
  return records;
}

// ---------------------------------------------------------------------------
// CSV importer
// ---------------------------------------------------------------------------
//
// PP's transaction export (datatransfer/csv/exporter/CSVExporter#writeHeader) is
// 15 columns:
//   Date, Type, Value, Transaction Currency, Gross Amount, Currency Gross
//   Amount, Exchange Rate, Fees, Taxes, Shares, ISIN, WKN, Ticker Symbol,
//   Security Name, Note
// with the delimiter, the number format and *the column and type labels* all
// taken from PP's UI locale, and one file per account — the account name is the
// file name, not a column. All of that is handled or reported below.

const CSV_FIELDS = {
  date: ['date', 'datum'],
  type: ['type', 'typ'],
  value: ['value', 'wert'],
  currency: ['transaction currency', 'buchungswährung'],
  grossAmount: ['gross amount', 'bruttobetrag'],
  grossCurrency: ['currency gross amount', 'währung bruttobetrag'],
  exchangeRate: ['exchange rate', 'wechselkurs'],
  fees: ['fees', 'gebühren'],
  taxes: ['taxes', 'steuern'],
  shares: ['shares', 'stück'],
  isin: ['isin'],
  wkn: ['wkn'],
  ticker: ['ticker symbol', 'ticker-symbol'],
  securityName: ['security name', 'wertpapiername'],
  note: ['note', 'notiz'],
  // Not written by the transaction export, but present in PP's own CSV *import*
  // template — honoured when a hand-built file has them.
  account: ['cash account', 'konto'],
  counterAccount: ['offset account', 'gegenkonto'],
};

const CSV_EXPORT_ORDER = ['date', 'type', 'value', 'currency', 'grossAmount', 'grossCurrency',
  'exchangeRate', 'fees', 'taxes', 'shares', 'isin', 'wkn', 'ticker', 'securityName', 'note'];

// AccountTransaction.Type's isDebit flag, which is what the exporter uses to
// sign the Value column of a *cash account* export. BUY/SELL are deliberately
// absent: a securities-account export signs them the other way round
// (isLiquidation, so a buy is positive), which is why direction is taken from
// the type and never from the sign — see the Value handling below.
const PP_DEBIT = {
  REMOVAL: true, INTEREST_CHARGE: true, FEES: true, TAXES: true, TRANSFER_OUT: true,
  DEPOSIT: false, INTEREST: false, DIVIDENDS: false, FEES_REFUND: false, TAX_REFUND: false,
  TRANSFER_IN: false,
};

// Type column holds Type.toString(), i.e. the localised label from PP's
// model/labels*.properties. English and German cover PP's two primary locales;
// the raw enum name is accepted too, which is what PP's own CSV importer emits.
const CSV_TYPE_LABELS = {
  BUY: ['buy', 'kauf'],
  SELL: ['sell', 'verkauf'],
  DEPOSIT: ['deposit', 'einlage'],
  REMOVAL: ['withdrawal', 'entnahme'],
  INTEREST: ['interest', 'zinsen'],
  INTEREST_CHARGE: ['interest charge', 'zinsbelastung'],
  DIVIDENDS: ['dividend', 'dividende'],
  FEES: ['fees', 'gebühren'],
  FEES_REFUND: ['fees refund', 'gebührenerstattung'],
  TAXES: ['taxes', 'steuern'],
  TAX_REFUND: ['tax refund', 'steuerrückerstattung'],
  TRANSFER_IN: ['transfer (inbound)', 'umbuchung (eingang)', 'delivery (inbound)', 'einlieferung'],
  TRANSFER_OUT: ['transfer (outbound)', 'umbuchung (ausgang)', 'delivery (outbound)', 'auslieferung'],
};

const norm = (s) => String(s ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');

// RFC 4180 with a chosen delimiter. Returns rows of raw strings plus the 1-based
// line each row started on, so a report entry can point at the real file line
// even when a quoted note spans several.
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let dirty = false;
  const endField = () => { row.push(field); field = ''; dirty = true; };
  const endRow = () => {
    endField();
    rows.push({ cells: row, line: startLine });
    row = [];
    dirty = false;
    startLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') { quoted = true; dirty = true; continue; }
    if (c === delimiter) { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      line += 1;
      if (dirty || row.length) endRow(); else startLine = line;
      continue;
    }
    field += c;
    dirty = true;
  }
  if (dirty || row.length) endRow();
  return rows;
}

function detectDelimiter(firstLine) {
  const counts = [';', ',', '\t'].map((d) => {
    let n = 0;
    let quoted = false;
    for (const c of firstLine) {
      if (c === '"') quoted = !quoted;
      else if (c === d && !quoted) n += 1;
    }
    return { d, n };
  });
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ';';
}

// PP formats numbers with the UI locale's DecimalFormat, so "1.234,56" and
// "1,234.56" are the same value written by two installs. Resolved from the
// value itself where it is unambiguous, and otherwise from the delimiter:
// PP picks ';' as the list separator exactly when ',' is the decimal separator
// (TextUtil.getListSeparatorChar).
function localeNumber(raw, decimalSep, location, field, ctx) {
  const s = String(raw ?? '').replace(/[\s '’]/g, '');
  if (s === '' || s === '-') return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let sep;
  if (hasDot && hasComma) sep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (hasDot || hasComma) {
    const only = hasDot ? '.' : ',';
    const parts = s.split(only);
    // Two or more occurrences can only be grouping. A single one with exactly
    // three trailing digits is genuinely ambiguous ("1,234"), so the file's
    // delimiter decides and the guess is reported.
    if (parts.length > 2) sep = only === '.' ? ',' : '.';
    else if (parts[1].length === 3 && only !== decimalSep) sep = decimalSep;
    else if (parts[1].length === 3 && only === decimalSep) sep = only;
    else sep = only;
    if (parts.length === 2 && parts[1].length === 3 && only !== sep) {
      ctx.report.add('info', 'csv_ambiguous_number', location,
        `${field} ${JSON.stringify(raw)} is ambiguous; "${only}" read as a thousands separator `
        + `because the file's decimal separator is "${decimalSep}"`, ctx.currentRaw);
    }
  } else sep = decimalSep;

  const group = sep === '.' ? ',' : '.';
  const plain = s.split(group).join('').replace(sep, '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(plain)) {
    ctx.report.add('warning', 'csv_bad_number', location,
      `${field} is not a number: ${JSON.stringify(raw)}`, ctx.currentRaw);
    return null;
  }
  return plain;
}

function fixedFrom(raw, decimalSep, decimals, location, field, ctx) {
  const plain = localeNumber(raw, decimalSep, location, field, ctx);
  if (plain === null) return null;
  try {
    return parseFixed(plain, decimals);
  } catch (err) {
    ctx.report.add('warning', 'csv_bad_number', location, `${field}: ${err.message}`, ctx.currentRaw);
    return null;
  }
}

function importCsv(text, options, report) {
  const records = [];
  const ctx = { report };
  const body = text.replace(/^﻿/, '');
  const firstLine = body.slice(0, body.search(/\r?\n/) < 0 ? body.length : body.search(/\r?\n/));
  const delimiter = options.delimiter ?? detectDelimiter(firstLine);
  // Switzerland is the one locale where ';' does not imply a comma decimal
  // separator, so the value-level detection above carries that case.
  const decimalSep = options.decimalSeparator ?? (delimiter === ';' ? ',' : '.');

  const rows = parseCsv(body, delimiter);
  if (!rows.length) {
    report.add('error', 'csv_empty', {}, 'the file has no rows');
    return records;
  }

  const header = rows[0].cells.map(norm);
  const columns = {};
  for (const [field, labels] of Object.entries(CSV_FIELDS)) {
    const at = header.findIndex((h) => labels.includes(h));
    if (at >= 0) columns[field] = at;
  }
  if (columns.date === undefined || columns.type === undefined) {
    if (header.length === CSV_EXPORT_ORDER.length) {
      CSV_EXPORT_ORDER.forEach((field, at) => { columns[field] = at; });
      report.add('warning', 'csv_header_unrecognized', { row: 0, line: rows[0].line },
        `column headers ${JSON.stringify(rows[0].cells.join(delimiter))} are not in a locale this importer knows; `
        + "assuming Portfolio Performance's 15-column transaction export order. Check the imported rows.",
        rows[0].cells.join(delimiter));
    } else {
      report.add('error', 'csv_header_unrecognized', { row: 0, line: rows[0].line },
        `could not find a Date and Type column in ${JSON.stringify(rows[0].cells.join(delimiter))}. `
        + "This importer reads Portfolio Performance's transaction export, not its securities or price exports.",
        rows[0].cells.join(delimiter));
      return records;
    }
  }

  const defaultAccountName = options.accountName ?? 'Portfolio Performance import';
  if (columns.account === undefined) {
    report.add('info', 'csv_no_account_column', { row: 0, line: rows[0].line },
      "PP's transaction export names the account in the file name, not in a column, so every row was booked to "
      + `"${defaultAccountName}". Pass options.accountName to change it.`);
  }

  const accountIdByName = new Map();
  const accountRecordId = (name) => {
    const key = norm(name) || norm(defaultAccountName);
    let id = accountIdByName.get(key);
    if (id) return id;
    id = idHashed(RECORD.account, `csv-account|${key}`);
    accountIdByName.set(key, id);
    records.push({
      recordType: RECORD.account,
      recordId: id,
      name: name || defaultAccountName,
      kind: 'cash',
      currency: options.currency ?? null,
      closed: false,
    });
    return id;
  };

  const securityIdByKey = new Map();
  const securityRecordId = (isin, wkn, ticker, name, currency) => {
    const key = norm(isin) || norm(ticker) || norm(wkn) || norm(name);
    if (!key) return null;
    let id = securityIdByKey.get(key);
    if (id) return id;
    id = idHashed(RECORD.security, `csv-security|${key}`);
    securityIdByKey.set(key, id);
    records.push({
      recordType: RECORD.security,
      recordId: id,
      name: name || ticker || isin || wkn,
      ...(isin ? { isin } : {}),
      ...(ticker ? { ticker } : {}),
      currency: currency ?? null,
      assetClass: null,
      quote: { provider: null, symbol: ticker || null },
    });
    return id;
  };

  const dupCounts = new Map();
  let warnedTradeDuplication = false;
  const cell = (row, field) => (columns[field] === undefined ? '' : (row.cells[columns[field]] ?? '').trim());

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const raw = row.cells.join(delimiter);
    if (row.cells.every((c) => c.trim() === '')) continue;
    report.counts.sourceRows += 1;
    const location = { row: r, line: row.line };
    // So the number helpers can echo the offending line back at the user.
    ctx.currentRaw = raw;

    if (row.cells.length !== header.length) {
      report.add('warning', 'csv_row_width', location,
        `row has ${row.cells.length} columns, the header has ${header.length}; not imported`, raw);
      report.counts.skipped += 1;
      continue;
    }

    const label = norm(cell(row, 'type'));
    const ppType = Object.keys(CSV_TYPE_LABELS).find(
      (k) => k.toLowerCase() === label || CSV_TYPE_LABELS[k].includes(label),
    );
    if (!ppType) {
      report.add('warning', 'pp_unmapped_transaction_type', location,
        `transaction type ${JSON.stringify(cell(row, 'type'))} is not a Portfolio Performance type this `
        + 'importer knows; not imported', raw);
      report.counts.skipped += 1;
      continue;
    }

    const date = dayOf(cell(row, 'date'));
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      report.add('warning', 'csv_bad_date', location,
        `date ${JSON.stringify(cell(row, 'date'))} is not YYYY-MM-DD; not imported`, raw);
      report.counts.skipped += 1;
      continue;
    }

    const signedValue = fixedFrom(cell(row, 'value'), decimalSep, DECIMALS.amount, location, 'Value', ctx);
    if (signedValue === null) {
      report.add('warning', 'csv_row_incomplete', location, 'row has no readable Value; not imported', raw);
      report.counts.skipped += 1;
      continue;
    }
    const shares = fixedFrom(cell(row, 'shares'), decimalSep, DECIMALS.shares, location, 'Shares', ctx) ?? 0;
    const fees = fixedFrom(cell(row, 'fees'), decimalSep, DECIMALS.amount, location, 'Fees', ctx) ?? 0;
    const taxes = fixedFrom(cell(row, 'taxes'), decimalSep, DECIMALS.amount, location, 'Taxes', ctx) ?? 0;
    const fx = fixedFrom(cell(row, 'exchangeRate'), decimalSep, DECIMALS.fx, location, 'Exchange Rate', ctx);
    const currency = cell(row, 'currency') || options.currency || null;
    const note = cell(row, 'note');
    const acctId = accountRecordId(cell(row, 'account'));
    const secId = securityRecordId(cell(row, 'isin'), cell(row, 'wkn'), cell(row, 'ticker'),
      cell(row, 'securityName'), currency);

    if (ppType === 'BUY' || ppType === 'SELL') {
      // A trade appears in BOTH of PP's per-file exports — the cash account's
      // (writeAccountTransaction delegates to the portfolio side, so the shares
      // are there too) and the securities account's. The files carry no shared
      // identity, so importing both genuinely doubles the trade and no importer
      // can tell. Said out loud once rather than discovered later.
      if (!warnedTradeDuplication) {
        warnedTradeDuplication = true;
        report.add('info', 'csv_trade_appears_in_two_exports', location,
          "Portfolio Performance writes each trade into both the cash account's export and the securities "
          + "account's, and the two files share no transaction identity. Import one of them, not both, or "
          + 'the trades will be counted twice.');
      }
      if (!shares) {
        report.add('warning', 'csv_trade_without_shares', location,
          `${ppType} has no share count, so the position it moves is unknown; not imported`, raw);
        report.counts.skipped += 1;
        continue;
      }
      if (!secId) {
        report.add('warning', 'csv_row_incomplete', location,
          `${ppType} names no security (ISIN, ticker, WKN or name); not imported`, raw);
        report.counts.skipped += 1;
        continue;
      }
    }

    const mapping = ppType === 'BUY' ? { type: 'buy' } : ppType === 'SELL' ? { type: 'sell' }
      : ACCOUNT_TX_TYPES[ppType];
    if (!mapping) {
      report.add('warning', 'pp_unmapped_transaction_type', location,
        `Portfolio Performance type ${ppType} has no §4 equivalent; not imported`, raw);
      report.counts.skipped += 1;
      continue;
    }
    if (mapping.negate) {
      report.add('warning', 'pp_type_reinterpreted', location,
        `${ppType} has no §4 type of its own; imported as a "${mapping.type}" with a negative amount, `
        + 'which moves the cash the same way PP does', raw);
    }

    // §4 keeps `amount` a magnitude and takes direction from the type, which is
    // the only workable reading here: PP signs the Value column by *whose* view
    // the file is, so the same buy is -500.00 in the cash account's export and
    // +500.00 in the securities account's. The refund/charge types are the one
    // place a negative magnitude is meaningful — they are PP's sign-flipped
    // twins and §4 has no type of their own.
    const amount = mapping.negate ? -Math.abs(signedValue) : Math.abs(signedValue);

    // For the cash-account types the sign IS PP's own isDebit flag, so a
    // disagreement means the row is not what its Type column claims. Worth
    // saying; not worth overriding PP with.
    const expectedSign = PP_DEBIT[ppType] === undefined ? null : (PP_DEBIT[ppType] ? -1 : 1);
    if (expectedSign !== null && signedValue !== 0 && Math.sign(signedValue) !== expectedSign) {
      report.add('info', 'csv_sign_mismatch', location,
        `Value ${cell(row, 'value')} runs the opposite way to a ${ppType}; imported by type, not by sign`, raw);
    }

    const key = [ppType, acctId, secId ?? '', date, shares, amount, fees, taxes, currency ?? '', note].join('|');
    const n = (dupCounts.get(key) ?? 0) + 1;
    dupCounts.set(key, n);
    const counterAccount = cell(row, 'counterAccount');

    records.push({
      recordType: RECORD.transaction,
      recordId: idHashed(RECORD.transaction, n === 1 ? key : `${key}#${n}`),
      type: mapping.type,
      accountId: acctId,
      ...(secId ? { securityId: secId } : {}),
      date,
      ...(shares ? { shares } : {}),
      amount,
      ...(fees ? { fees } : {}),
      ...(taxes ? { taxes } : {}),
      currency,
      ...(fx ? { fx } : {}),
      ...(counterAccount ? { counterAccountId: accountRecordId(counterAccount) } : {}),
      ...(note ? { note } : {}),
    });
    report.counts.imported += 1;
  }

  return records;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function detectFormat(text) {
  return /^\s*(﻿)?</.test(text) ? 'xml' : 'csv';
}

/**
 * Parse a Portfolio Performance export into §4 records.
 *
 * @param {string} text  the file contents (.xml client file, or a CSV export)
 * @param {object} [options]
 *   format            'xml' | 'csv' — defaults to sniffing the first character
 *   accountName       CSV only: the account the rows belong to (PP puts it in
 *                     the file name, so the importer cannot know it)
 *   currency          CSV only: fallback currency when the file omits one
 *   delimiter         CSV only: override the sniffed delimiter
 *   decimalSeparator  CSV only: override the inferred decimal separator
 * @returns {{format: string, records: object[], report: object}}
 *   `records` are §3 bodies with `recordType` and a deterministic `recordId`;
 *   write them with records.put(r.recordType, r.recordId, r). Re-parsing the
 *   same input yields the same ids, so a second import writes zero new records.
 */
export function parsePP(text, options = {}) {
  const report = createReport();
  if (typeof text !== 'string') {
    report.add('error', 'not_text', {}, 'parsePP expects the file contents as a string');
    return { format: null, records: [], report };
  }
  const format = options.format ?? detectFormat(text);
  const records = format === 'xml'
    ? importXml(text, options, report)
    : importCsv(text, options, report);
  return { format, records, report };
}

/**
 * Yield the records in bounded batches so a large import is written as many
 * small port transactions instead of one that holds the store for a minute.
 * A 5-year, 10-security file is ~18k daily closes; §4's per-security-year
 * chunking already collapses those into a few dozen `price` records, so the
 * batches here are about the transaction rows.
 */
export function* batches(records, size = 250) {
  if (!(size > 0)) throw new RangeError(`batches: size must be positive, got ${size}`);
  for (let i = 0; i < records.length; i += size) yield records.slice(i, i + size);
}
