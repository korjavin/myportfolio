// Settings — reporting currency, quote providers, the accounts and securities
// the transaction form draws on, Portfolio Performance import, the sample
// portfolio (§12), and export.
//
// Import is `parsePP` (web/domain/ppimport.js) and nothing else: the parser
// mints deterministic ids from stable upstream keys, so re-importing the same
// file overwrites instead of doubling the portfolio (§4). This screen honours
// the id the parser chose — minting a fresh one here is exactly the bug that
// idempotence exists to prevent.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { parsePP } from '../../../domain/ppimport.js';
import { RECORD, SETTINGS_ID, ASSET_CLASSES } from '../../../domain/schema.js';
import {
    state, records, putSettings, putAccount, putSecurity, remove, refresh,
    importRecords, exportAll, reportingCurrency, DEFAULT_CURRENCY,
} from './store.js';
import { syncState, describeSync, syncNow, subscribeSync } from './sync.js';
import { formatPairingCode, toBase64 } from '../core/crypto.js';
import {
    MCP_PAIRING_TYPE, MCP_PAIRING_ID, readPairing, purgePairing, refreshResponder,
} from '../core/mcp-responder.js';

function generalCard(rerender) {
    const currency = ui.input(reportingCurrency(), { placeholder: DEFAULT_CURRENCY });

    const save = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Save', async () => {
        await putSettings({ reportingCurrency: currency.value.trim().toUpperCase() || DEFAULT_CURRENCY });
        rerender();
    });

    return ui.card(
        ui.sectionLabel('General'),
        ui.field('Reporting currency', currency),
        actionRow(save)
    );
}

// --- Quote providers -------------------------------------------------------

// §7: browser-direct with the user's own key is the default, so the server
// never learns which symbols you hold. `settings.quoteProviders` is a MAP and
// every provider in it is live at once — CoinGecko prices crypto with no key
// while Twelve Data prices stocks and ETFs with the user's own key, and a
// portfolio holding both BTC and VWCE needs both configured simultaneously.
// web/domain/quotes.js has always read it that way (it routes per security via
// `security.quote.provider` and looks the config up by name); this card is what
// had to catch up.
//
// Finnhub and Alpha Vantage are deliberately absent: quotes.js knows neither,
// so choosing one used to price nothing at all and say nothing about it.
// Offering a provider that silently does nothing is worse than not offering it.
// Yahoo is absent for a different reason — it blocks CORS, so it cannot be used
// browser-direct at all. features.settings.test.js pins this list against
// quotes.js's exported QUOTE_HOSTS so the two cannot drift apart again.
export const QUOTE_PROVIDERS = [
    {
        name: 'coingecko',
        label: 'CoinGecko',
        // The note deliberately does not promise that switching this off stops
        // CoinGecko being used: quotes.js prices any security routed to
        // `coingecko` whether or not the map lists it, because a provider that
        // needs no key can never be skipped for `no_api_key`. Listing it is
        // what the §7 CSP allowlist will be derived from (myportfolio-18h.9).
        note: 'Crypto. The free tier needs no key, so nothing but the choice is stored.',
        // Optional all the same: quotes.js sends a stored CoinGecko key as
        // `x_cg_demo_api_key`, which raises the keyless rate limit. The field
        // exists so that key is visible and editable rather than silently
        // carried — see mergeQuoteProviders.
        keyNote: 'Optional. A CoinGecko demo key only raises the free-tier rate limit.',
        needsKey: false,
    },
    {
        name: 'twelvedata',
        label: 'Twelve Data',
        note: 'Stocks and ETFs. Bring your own key — it never leaves this device. Blank turns it off.',
        needsKey: true,
    },
];

const KNOWN_PROVIDERS = new Set(QUOTE_PROVIDERS.map((p) => p.name));

function configOf(map, name) {
    const value = Object.hasOwn(map, name) ? map[name] : null;
    return value && typeof value === 'object' ? value : null;
}

/**
 * One row per provider this card renders, derived from the stored map. Pure, so
 * the DOM builder and the tests work from the same thing rather than from two
 * descriptions of it that can disagree.
 *
 * `keyField` says whether the row renders a credential input of its own. Only a
 * row that does may write `apiKey`, and only under its own name — that is the
 * structural half of the fix for 8cb4a3f, where one shared key field meant Save
 * could file one provider's credential under another's.
 *
 * Providers that are stored but no longer supported still get a row: an install
 * that configured Finnhub before it was dropped would otherwise be left with an
 * inert credential it can neither see nor delete. They render no key field, so
 * whatever they hold is carried through untouched until the row is switched off.
 */
export function quoteProviderRows(stored) {
    const map = stored && typeof stored === 'object' ? stored : {};
    const rows = QUOTE_PROVIDERS.map((provider) => {
        const config = configOf(map, provider.name);
        const apiKey = typeof config?.apiKey === 'string' ? config.apiKey : '';
        return {
            ...provider,
            apiKey,
            keyField: true,
            // A provider that requires a key and has none is not configured —
            // quotes.js would skip every one of its securities with
            // `no_api_key`, so the key field is also its on switch. One that
            // needs no key is configured by being in the map at all, and gets
            // an explicit toggle instead.
            enabled: provider.needsKey ? apiKey !== '' : Object.hasOwn(map, provider.name),
        };
    });

    for (const name of Object.keys(map)) {
        if (KNOWN_PROVIDERS.has(name)) continue;
        rows.push({
            name,
            label: name,
            note: 'Stored by an older version. quotes.js does not know it, so it prices nothing.',
            needsKey: false,
            keyField: false,
            apiKey: '',
            enabled: true,
            unsupported: true,
        });
    }
    return rows;
}

/**
 * Merge this card's rows into the stored provider map — never replace it.
 * Replacing is the bug: it made configuring an equity provider erase CoinGecko,
 * silently, so a portfolio holding both stopped pricing half of itself.
 *
 * Three invariants, all load-bearing:
 *
 *  - `apiKey` is written only from a row that rendered its own key field, and
 *    only under that row's own name. A row with no field of its own never
 *    touches the stored key at all. Both halves matter: 8cb4a3f filed one
 *    provider's credential under another's name, and quotes.js forwards a
 *    stored CoinGecko key as `x_cg_demo_api_key` — so a crossed key is not
 *    inert, it is handed to the wrong vendor on the next refresh.
 *  - Nothing is destroyed that the user cannot see. Clearing a key field is how
 *    a key is removed, which is why every provider that accepts one renders it
 *    rather than being quietly rewritten behind a password mask.
 *  - Anything else in a provider's config (`minIntervalMs`, whatever a later
 *    version adds) survives, because this card does not own those fields.
 *
 * A name absent from `edits` is left exactly as stored.
 */
export function mergeQuoteProviders(stored, edits) {
    const next = { ...(stored && typeof stored === 'object' ? stored : {}) };
    for (const edit of edits ?? []) {
        const name = edit?.name;
        if (!name) continue;
        if (!edit.enabled) {
            delete next[name];
            continue;
        }
        const config = { ...(configOf(next, name) ?? {}) };
        if (edit.keyField) {
            if (edit.apiKey) config.apiKey = edit.apiKey;
            else delete config.apiKey;
        }
        next[name] = config;
    }
    return next;
}

// The .wg-toggle primitive as markup. js/components/wg-toggle.js has the same
// ten lines, but it is a window-global IIFE that nothing loads — wiring a script
// tag and a precache entry to reuse it costs more than it saves.
function toggleControl(checked, ariaLabel) {
    const node = ui.el('label', 'wg-toggle');
    const input = ui.el('input', 'wg-toggle__input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', ariaLabel);
    const track = ui.el('span', 'wg-toggle__track');
    track.setAttribute('aria-hidden', 'true');
    const knob = ui.el('span', 'wg-toggle__knob');
    knob.setAttribute('aria-hidden', 'true');
    node.append(input, track, knob);
    return { node, input };
}

function settingsRow(title, note, control) {
    const row = ui.el('div', 'wg-settings-row');
    const content = ui.el('div', 'wg-settings-row__content');
    content.appendChild(ui.el('p', 'wg-settings-row__title', title));
    content.appendChild(ui.el('p', 'wg-settings-row__desc', note));
    const slot = ui.el('div', 'wg-settings-row__control');
    slot.appendChild(control);
    row.append(content, slot);
    return row;
}

function quotesCard(rerender) {
    const rows = quoteProviderRows(state.settings?.quoteProviders);
    const nodes = [];
    const reads = [];

    for (const row of rows) {
        // A provider that requires a key needs no switch — the key is the
        // switch. Everything else gets an explicit one, which is also the only
        // way to delete a provider this build no longer supports.
        const toggle = row.needsKey ? null : toggleControl(row.enabled, `Use ${row.label}`);
        if (toggle) nodes.push(settingsRow(row.label, row.note, toggle.node));

        // Rendered with the stored key in it, so saving an untouched form keeps
        // it. A field that rendered blank for secrecy would read back as "no
        // key" and delete the credential on the next Save.
        const key = row.keyField
            ? ui.input(row.apiKey, { type: 'password', placeholder: toggle ? 'Optional key' : 'API key' })
            : null;
        if (key) {
            nodes.push(ui.field(toggle ? `${row.label} key` : `${row.label} API key`, key));
            nodes.push(ui.el('p', 'wg-muted text-sm m-0', toggle ? row.keyNote : row.note));
        }

        reads.push(() => ({
            name: row.name,
            keyField: row.keyField,
            // Only ever this row's own field, never another's.
            apiKey: key ? key.value.trim() : '',
            enabled: toggle ? toggle.input.checked : Boolean(key && key.value.trim()),
        }));
    }

    const save = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Save providers', async () => {
        // Merged against what is stored NOW, not the snapshot this card was
        // rendered from: a sync landing while the form sat open must not be
        // undone by pressing Save.
        await putSettings({
            quoteProviders: mergeQuoteProviders(state.settings?.quoteProviders, reads.map((read) => read())),
        });
        rerender();
    });

    return ui.card(
        ui.sectionLabel('Quote providers'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Configure every provider your portfolio needs — each security is priced by its own, so '
            + 'crypto and equities do not compete for one slot. Credentials stay on this device (and, '
            + 'once you sign up, inside the vault); quotes are fetched browser-direct so the server '
            + 'never learns your symbols.'),
        ...nodes,
        actionRow(save)
    );
}

function actionRow(button) {
    const actions = ui.el('div', 'flex-row flex-between gap-sm mt-md');
    actions.appendChild(ui.el('span', 'flex-1'));
    actions.appendChild(button);
    return actions;
}

// --- Sync ------------------------------------------------------------------

// The full picture, including the states the ambient strip stays quiet about:
// offline, a write still waiting on the debounce, and — the one that actually
// catches a sync that quietly stopped — when this device last got through.
//
// This card repaints ITSELF on every sync change rather than waiting for the
// screen to be re-rendered. The vault attaches asynchronously a moment after
// first paint, so a card rendered once at boot sits there saying "this device
// only" while the app is in fact syncing — a stale sync indicator, which is the
// one thing this bead exists to prevent. Repainting only this subtree also
// means a flush landing three seconds after a keystroke does not rebuild the
// form the user is typing into.
function syncCard(rerender) {
    const card = ui.card(ui.sectionLabel('Sync'));
    const body = ui.el('div');
    card.appendChild(body);

    const paint = () => {
        const snapshot = syncState();
        const desc = describeSync(snapshot, { online: navigator.onLine });
        const actions = snapshot.connected
            ? [{ label: 'Sync now', onClick: async () => { await syncNow(refresh); rerender(); } }]
            : [];
        // syncNotice returns its own card; unwrap it rather than nesting two.
        const children = [...ui.syncNotice(desc, actions).childNodes];
        if (snapshot.connected) {
            children.push(ui.el(
                'p',
                'wg-muted text-sm m-0 mt-md',
                `Vault ${snapshot.accountId} · state version ${snapshot.status?.version ?? 0}`
            ));
        }
        body.replaceChildren(...children);
    };

    const off = subscribeSync(() => {
        // The screen has moved on; drop the subscription with it rather than
        // repainting a detached node forever.
        if (!card.isConnected) off();
        else paint();
    });
    paint();
    return card;
}

// --- Connect Claude --------------------------------------------------------
//
// The AI connector's only user-visible surface (ARCHITECTURE.md §11, bd
// myportfolio-ybp.5). Everything else in the chain is already merged: the frame
// crypto (core/crypto.js), the blind relay (internal/server/mcp_relay.go), the
// shim (cmd/mcpshim) and the browser responder (core/mcp-responder.js). This
// card is what makes them reachable.
//
// THE KEY NEVER TOUCHES THE SERVER, and that is the property the whole design
// exists for. The mint request is a bare POST with no body; the 32 key bytes are
// generated here afterwards and only ever go two places — into the one-time code
// the user pastes into the shim, and into a vault record (which the server sees
// only as ciphertext, like every other record). Nothing in this section may put
// the key in a request, a URL or a log line.
//
// "Shown once" is a UX property, not a cryptographic one: the vault record holds
// both halves of the code, deliberately, so a second unlocked device can answer
// without re-pairing. It is not re-displayed all the same — a secret that can be
// summoned again is a secret people leave lying around — and it does not need to
// be, because re-connecting is one click.

export const MCP_CODE_ENV_VAR = 'MYPORTFOLIO_MCP_CODE';

/** How many random bytes the pairing key is. crypto.js rejects any other length. */
const PAIRING_KEY_BYTES = 32;

/**
 * The §11 relay ENDPOINT — the full path, not the origin.
 *
 * This one line has 404'd the whole feature once already, in C3: the sibling
 * project's `relay_url` is a bare origin and its shim therefore appends the
 * whole "/api/mcp/relay/shim", so minting an origin here makes the shim dial
 * ".../api/mcp/relay/api/mcp/relay/shim". It fails against every real pairing
 * and passes every test that mints its own code, which is why the pinned vector
 * in internal/mcpshim/testdata/mcp_frame_vectors.json — the file the Go suite
 * reads — is what features.settings.test.js asserts this against, rather than a
 * string this file and its test agree on.
 */
export function relayEndpoint(loc) {
    return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/mcp/relay`;
}

/**
 * The line the user pastes into the shim's environment. `codeEnvVar` in
 * cmd/mcpshim/main.go is the name, and features.settings.test.js reads that file
 * rather than restating it — a shim reading a variable Settings does not name
 * fails as "MYPORTFOLIO_MCP_CODE is not set", which sends the user looking at
 * their shell instead of at us.
 *
 * Unquoted on purpose: a code is PREFIX + base64url + "." + base64url, so its
 * alphabet is [A-Za-z0-9._-] and holds nothing a shell would interpret. The test
 * pins the alphabet, because the day it grows a "$" this line starts silently
 * pasting an empty variable.
 */
export function shimEnvLine(code) {
    return `${MCP_CODE_ENV_VAR}=${code}`;
}

/**
 * Mint a pairing and the one-time code for it. Nothing is stored yet — see
 * savePairing.
 *
 * `http` and `randomBytes` are ports so the test can assert what actually
 * crossed the wire. The order is load-bearing: the id is minted first and the
 * key generated after, so there is never a moment where a key exists that the
 * request could have carried.
 */
export async function mintPairing({ http, records: port, randomBytes, relayUrl }) {
    // No body, no query, no headers: the id is derived from the session cookie
    // server-side (createPairing in internal/server/mcp_relay.go).
    const res = await http('/api/mcp/pairings', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(res.status === 401
            ? 'Your vault session has expired. Reload the app and unlock it, then try again.'
            : `The server would not start a pairing (HTTP ${res.status}).`);
    }
    const body = await res.json();
    const pairingId = typeof body?.pairing_id === 'string' ? body.pairing_id : '';
    if (!pairingId) throw new Error('The server returned no pairing id.');

    const key = randomBytes(new Uint8Array(PAIRING_KEY_BYTES));
    // The pairing the account held is already dead — the server keeps one per
    // account and mint() replaced it — so the record naming it is a tombstone
    // from this point on. Dropping it BEFORE the code is shown is what makes
    // abandoning this screen safe: whatever the user does next, no device is
    // left holding a key for a pairing that cannot answer. It also means that
    // walking away leaves NOTHING stored, so the card honestly reads "not
    // connected" rather than claiming a connection with no code behind it.
    await purgePairing(port);
    return { pairingId, key, code: await formatPairingCode({ relayUrl, pairingId, key }) };
}

/**
 * Store the key where any unlocked device can answer with it (§11).
 *
 * The shape is core/mcp-responder.js's `readPairing`, which reads `pairingId`
 * and `key` off a record at MCP_PAIRING_ID and expects the key base64-encoded.
 * That file is pinned; this is the side that has to match it.
 */
export function savePairing({ records: port, pairingId, key }) {
    return port.put(MCP_PAIRING_TYPE, MCP_PAIRING_ID, { pairingId, key: toBase64(key) });
}

/** Revoke server-side. Idempotent: DELETE on an account with no pairing is a no-op 204. */
export async function revokePairing({ http }) {
    const res = await http('/api/mcp/pairings', { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`The server would not revoke the pairing (HTTP ${res.status}).`);
}

// The three product facts §11 requires the UI to state rather than let a user
// discover. Each of them is the explanation for a support question this feature
// would otherwise generate: "why did it stop working", "what does your server
// see", "can it trade for me".
export const CONNECTOR_FACTS = [
    'Answers come from this browser, so a question only works while a tab of this app is '
    + 'open and unlocked. There is no server-side fallback, by design — the server holds '
    + 'only ciphertext and cannot answer a single query. If no device is unlocked and '
    + 'online, Claude is told so instead of waiting.',
    'The relay in the middle cannot read the conversation: every message is encrypted to a '
    + 'key it never receives. It does see the size and timing of each message and the '
    + 'pairing id — so it learns that you asked something and roughly how big the answer '
    + 'was, never what.',
    'The connector is read-only. It can look at the portfolio — holdings, valuation, '
    + 'performance, prices, transactions — and cannot add, change or delete anything.',
];

const note = (text) => ui.el('p', 'wg-muted text-sm m-0 mt-md', text);

function connectClaudeCard() {
    const card = ui.card(ui.sectionLabel('Connect Claude'));
    const body = ui.el('div');
    card.appendChild(body);

    // This card repaints its own body and never calls the screen's rerender():
    // the one-time code lives in nothing but the DOM node below and the closure
    // that made it, so a full re-render would destroy it. Rebuilding the screen
    // mid-ceremony would leave a minted pairing with no code on screen — the
    // exact state the mint's purge exists to keep harmless, but still a dead end
    // the user has to notice and restart.

    const http = (url, init) => window.fetch(url, init);
    const actions = (...buttons) => {
        const row = ui.el('div', 'flex-row flex-between gap-sm mt-md');
        row.appendChild(ui.el('span', 'flex-1'));
        for (const b of buttons) row.appendChild(b);
        return row;
    };
    const busy = (message) => body.replaceChildren(ui.emptyState(message));
    const fail = (err, retry) => body.replaceChildren(
        ui.messages([String(err?.message ?? err)]),
        actions(retry)
    );

    async function paint() {
        if (!syncState().connected) {
            body.replaceChildren(
                note('Connecting Claude needs a vault: the pairing lives on your account, so every '
                    + 'device you unlock can answer. Set one up first.'),
                ...CONNECTOR_FACTS.map(note)
            );
            return;
        }

        let pairing = null;
        try {
            pairing = await readPairing(records);
        } catch (err) {
            body.replaceChildren(ui.messages([`Could not read the pairing: ${err.message}`]));
            return;
        }

        const connect = ui.button(
            'wg-toolbar-btn wg-toolbar-btn--primary',
            pairing ? 'Replace with a new code' : 'Connect Claude',
            () => (pairing ? confirmReplace() : onConnect())
        );

        if (!pairing) {
            body.replaceChildren(
                note('Ask Claude about this portfolio from Claude Desktop or Claude Code. Connecting '
                    + 'gives you a one-time code for the myportfolio MCP shim; the shim talks to this '
                    + 'browser through a relay that cannot read what it carries.'),
                ...CONNECTOR_FACTS.map(note),
                actions(connect)
            );
            return;
        }

        const disconnect = ui.button('wg-toolbar-btn wg-toolbar-btn--secondary', 'Disconnect', () => ui.confirm({
            title: 'Disconnect Claude',
            message: 'Claude stops being able to read this portfolio, on every device. The stored key '
                + 'is deleted and the code you saved stops working — connecting again gives you a new one.',
            confirmLabel: 'Disconnect',
            onConfirm: onDisconnect,
        }));

        body.replaceChildren(
            ui.messages([`Connected · pairing ${pairing.pairingId}`], 'normal'),
            note('This device answers whenever it is open and unlocked. The code is not shown again — '
                + 'if you have lost it, replace it with a new one.'),
            // internal/server/mcp_relay.go ages a pairing out 24 hours after it
            // was minted and keeps the table in memory, so a server restart ends
            // it too. Both are cheap to recover from and baffling if unstated.
            note('A pairing lasts 24 hours, and ends if the server restarts. When Claude says no '
                + 'device is online and a tab is open and unlocked, connect again.'),
            ...CONNECTOR_FACTS.map(note),
            actions(disconnect, connect)
        );
    }

    function confirmReplace() {
        ui.confirm({
            title: 'Replace the pairing',
            message: 'The code you are using now stops working immediately, on every device, and you '
                + 'get a new one to paste into the shim.',
            confirmLabel: 'Replace',
            onConfirm: onConnect,
        });
    }

    async function onConnect() {
        busy('Starting a pairing…');
        let minted;
        try {
            minted = await mintPairing({
                http,
                records,
                // The one place these 32 bytes come from. Not Math.random, and
                // not derived from anything the server has ever seen.
                randomBytes: (buf) => crypto.getRandomValues(buf),
                relayUrl: relayEndpoint(window.location),
            });
        } catch (err) {
            fail(err, ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Try again', paint));
            return;
        }
        // Deliberately NOT refreshResponder() here, and the reason is a race
        // codex found: refreshResponder returns early while an election is still
        // in flight (`electing`), so a reconcile whose readPairing landed before
        // the user pressed Finish releases the lock with no responder — and the
        // Finish call is the one that gets dropped. The result is a saved pairing
        // that answers nothing until a reload, i.e. "no device online" with an
        // unlocked tab open, which is the least attributable symptom this whole
        // feature can produce.
        //
        // Awaiting it instead is worse: the promise settles only once the lock is
        // GRANTED, so a tab queued behind another tab's responder would sit on
        // "Starting a pairing…" forever.
        //
        // Nothing is needed here anyway. The relay closed the old device leg with
        // 4409 the moment mint() replaced the pairing, and mcp-responder's
        // onStalePairing stops that responder and releases the election on its
        // own; a leg that was offline for it takes the same 4409 on its next dial.
        // Finish's refreshResponder is then the only election in play.
        paintCode(minted);
    }

    function paintCode({ pairingId, key, code }) {
        const envLine = shimEnvLine(code);
        const copy = ui.button('wg-toolbar-btn wg-toolbar-btn--secondary', 'Copy the line', async () => {
            try {
                await navigator.clipboard.writeText(envLine);
                copy.replaceChildren(ui.el('span', null, 'Copied'));
            } catch {
                // Clipboard access is refused in plenty of ordinary situations
                // (no permission, an insecure origin, an in-app browser). The
                // code block selects itself in one click, so say that instead of
                // leaving a button that does nothing.
                copy.replaceChildren(ui.el('span', null, 'Select it and copy by hand'));
            }
        });

        const finish = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'I saved it — finish', async () => {
            busy('Storing the key…');
            try {
                await savePairing({ records, pairingId, key });
            } catch (err) {
                // Nothing is connected and nothing was stored: the pairing is
                // live server-side but no device holds its key, which is exactly
                // the state minting leaves behind and it ages out on its own.
                fail(err, ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Start again', onConnect));
                return;
            }
            // Answer from this tab now, without a reload.
            refreshResponder({ records });
            paint();
        });

        const cancel = ui.button('wg-toolbar-btn wg-toolbar-btn--secondary', 'Cancel', async () => {
            busy('Cancelling…');
            try {
                await revokePairing({ http });
            } catch (err) {
                fail(err, ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Back', paint));
                return;
            }
            paint();
        });

        body.replaceChildren(
            ui.messages(['This code is shown once. It carries the encryption key, so it is not stored '
                + 'anywhere you can read it back — save it now, or connect again for a new one.'], 'normal'),
            note('Install the myportfolio MCP shim, then put this line in the environment you start it '
                + `from (Claude Desktop calls it "env"). It is the shim's only setting.`),
            ui.el('div', 'wg-code-block mt-md', envLine),
            note('The code itself, if you need it on its own:'),
            ui.el('div', 'wg-code-block mt-md', code),
            note('Nothing is connected yet. This device starts answering when you finish below — so if '
                + 'you close this screen instead, no device is left holding a code you do not have.'),
            actions(cancel, copy, finish)
        );
    }

    async function onDisconnect() {
        busy('Disconnecting…');
        try {
            // Server first. The other order would delete the only copy of the
            // key while the relay still routed the pairing, leaving a shim that
            // connects to a pairing nothing can answer.
            await revokePairing({ http });
            await purgePairing(records);
        } catch (err) {
            fail(err, ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Try again', paint));
            return;
        }
        refreshResponder({ records });
        paint();
    }

    paint();
    return card;
}

// --- Accounts --------------------------------------------------------------

function accountModal(record, rerender) {
    const name = ui.input(record?.name ?? '', { placeholder: 'Broker cash' });
    const kind = ui.select([
        { value: 'cash', label: 'Cash' },
        { value: 'securities', label: 'Securities' },
    ], record?.kind ?? 'cash');
    const currency = ui.input(record?.currency ?? reportingCurrency());
    const closed = ui.select([
        { value: 'no', label: 'Open' },
        { value: 'yes', label: 'Closed' },
    ], record?.closed ? 'yes' : 'no');
    const errorSlot = ui.el('div', 'wg-error-slot');

    ui.modal({
        title: record ? 'Edit account' : 'New account',
        body: [
            errorSlot,
            ui.field('Name', name),
            ui.fieldRow(ui.field('Kind', kind), ui.field('Currency', currency)),
            ui.field('Status', closed),
        ],
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            {
                label: 'Save',
                className: 'wg-gloss wg-gloss--sun wg-gloss--lg',
                onClick: async (close) => {
                    if (!name.value.trim()) {
                        errorSlot.replaceChildren(ui.messages(['Name the account.']));
                        return;
                    }
                    await putAccount(record?.recordId ?? null, {
                        name: name.value.trim(),
                        kind: kind.value,
                        currency: currency.value.trim().toUpperCase() || reportingCurrency(),
                        closed: closed.value === 'yes',
                    });
                    close();
                    rerender();
                },
            },
        ],
    });
}

function securityModal(record, rerender) {
    const name = ui.input(record?.name ?? '', { placeholder: 'Vanguard FTSE All-World' });
    const ticker = ui.input(record?.ticker ?? '', { placeholder: 'VWCE' });
    const isin = ui.input(record?.isin ?? '', { placeholder: 'IE00BK5BQT80' });
    const wkn = ui.input(record?.wkn ?? '', { placeholder: 'A2PKXG' });
    const currency = ui.input(record?.currency ?? reportingCurrency());
    // §4: absent assetClass means *unclassified*, and the UI says so rather than
    // inferring one from the name — a wrong class silently mis-buckets the
    // allocation breakdown, and a guess is worse than a blank because it looks
    // like knowledge.
    const assetClass = ui.select([
        { value: '', label: 'Unclassified' },
        ...ASSET_CLASSES.map((c) => ({ value: c, label: c })),
    ], record?.assetClass ?? '');
    // §4's `quote: { provider, symbol }`. BOTH halves, because quotes.js needs
    // both to fetch anything — it routes every security through its own
    // `quote.provider` and skips a security with either missing as
    // `no_quote_config`. This form collected only the symbol, so every security
    // created in the app was unfetchable and Refresh could never price one.
    const quoteProvider = ui.select([
        { value: '', label: 'None — price by hand' },
        ...QUOTE_PROVIDERS.map((p) => ({ value: p.name, label: p.label })),
    ], record?.quote?.provider ?? '');
    const quoteSymbol = ui.input(record?.quote?.symbol ?? '', { placeholder: 'Provider symbol' });
    const errorSlot = ui.el('div', 'wg-error-slot');

    ui.modal({
        title: record ? 'Edit security' : 'New security',
        body: [
            errorSlot,
            ui.field('Name', name),
            ui.fieldRow(ui.field('Ticker', ticker), ui.field('Currency', currency)),
            ui.fieldRow(ui.field('ISIN', isin), ui.field('WKN', wkn)),
            ui.fieldRow(ui.field('Asset class', assetClass), ui.field('Quote provider', quoteProvider)),
            ui.field('Quote symbol', quoteSymbol),
            ui.el('p', 'wg-muted text-sm m-0',
                'The symbol is the provider\'s own, not the exchange ticker: CoinGecko wants a coin id '
                + '(bitcoin), Twelve Data wants a ticker (AAPL). A wrong one comes back as "no close" '
                + 'rather than a wrong price.'),
        ],
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            {
                label: 'Save',
                className: 'wg-gloss wg-gloss--sun wg-gloss--lg',
                onClick: async (close) => {
                    if (!name.value.trim()) {
                        errorSlot.replaceChildren(ui.messages(['Name the security.']));
                        return;
                    }
                    // Anything else already on `quote` survives; the provider
                    // key is removed rather than stored empty, so "None" reads
                    // back as unset instead of as a provider named "".
                    const quote = { ...(record?.quote ?? {}), symbol: quoteSymbol.value.trim() };
                    if (quoteProvider.value) quote.provider = quoteProvider.value;
                    else delete quote.provider;
                    const body = {
                        name: name.value.trim(),
                        currency: currency.value.trim().toUpperCase() || reportingCurrency(),
                        quote,
                    };
                    for (const [key, control] of [['ticker', ticker], ['isin', isin], ['wkn', wkn]]) {
                        const v = control.value.trim();
                        if (v) body[key] = v;
                    }
                    if (assetClass.value) body.assetClass = assetClass.value;
                    await putSecurity(record?.recordId ?? null, body);
                    close();
                    rerender();
                },
            },
        ],
    });
}

function recordsCard({ label, noun, plural, items, describe, onOpen, type, rerender }) {
    const head = ui.el('div', 'flex-row flex-between gap-sm wg-toolbar');
    head.appendChild(ui.sectionLabel(label));
    head.appendChild(ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Add', () => onOpen(null), {
        iconName: 'plus',
    }));

    const body = items.length === 0
        ? ui.emptyState(`No ${plural ?? `${noun}s`} yet.`)
        : ui.list(items.map((item) => ui.row({
            title: item.name ?? item.recordId,
            subtitle: describe(item),
            onOpen: () => onOpen(item),
            onDelete: () => ui.confirm({
                title: `Delete ${noun}`,
                message: `Delete ${item.name ?? item.recordId}? Transactions referring to it stay, `
                    + 'and the engine will report them as unresolved.',
                onConfirm: async () => { await remove(type, item.recordId); rerender(); },
            }),
            deleteLabel: `Delete ${noun}`,
        })));

    return ui.card(head, body);
}

// --- Import / export -------------------------------------------------------

// A successful import must survive the re-render it causes. importRecords()
// calls refresh(), which re-renders this screen and detaches resultSlot, so a
// report written to the slot afterwards is never seen — the user imports, sees
// nothing, and imports again. Parking it here means the rebuilt card renders
// it. (Re-importing is harmless — ids are derived from the file — but "did that
// work?" is exactly the question the report exists to answer.)
let lastImport = null;

function importCard(rerender) {
    const file = ui.input('', { type: 'file' });
    file.accept = '.xml,.csv,text/csv,text/xml';
    const resultSlot = ui.el('div', 'wg-error-slot');
    if (lastImport) resultSlot.replaceChildren(ui.messages(lastImport.lines, lastImport.tone));

    file.addEventListener('change', async () => {
        const chosen = file.files && file.files[0];
        if (!chosen) return;
        resultSlot.replaceChildren(ui.emptyState(`Reading ${chosen.name}…`));
        let text;
        try {
            text = await chosen.text();
        } catch (err) {
            resultSlot.replaceChildren(ui.messages([`Could not read the file: ${err.message}`]));
            return;
        }

        const { format, records: parsed, report } = parsePP(text);
        const lines = [
            `Format: ${format ?? 'unrecognised'}`,
            `Source rows: ${report.counts.sourceRows} · imported ${report.counts.imported}`
            + ` · merged ${report.counts.merged} · skipped ${report.counts.skipped}`,
        ];
        if (parsed.length === 0) {
            resultSlot.replaceChildren(ui.messages([
                ...lines,
                ...report.entries.slice(0, 8).map((e) => `${e.severity} ${e.code}: ${e.message}`),
            ]));
            return;
        }

        let written = 0;
        try {
            written = await importRecords(parsed);
        } catch (err) {
            resultSlot.replaceChildren(ui.messages([`Import failed after ${written} records: ${err.message}`]));
            return;
        }

        lastImport = {
            lines: [
                `Wrote ${written} records.`,
                ...lines,
                // The report is the contract for anything the parser reinterpreted
                // — §4 says a reinterpretation must never be silent.
                ...report.entries.slice(0, 8).map((e) => `${e.severity} ${e.code}: ${e.message}`),
            ],
            tone: report.ok ? 'normal' : 'alert',
        };
        file.value = '';
        rerender();
    });

    return ui.card(
        ui.sectionLabel('Import from Portfolio Performance'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Pick a PP .xml or a CSV export. Ids are derived from the file, so importing '
            + 'the same file twice updates rather than duplicates.'),
        ui.field('File', file),
        resultSlot
    );
}

// --- Sample portfolio ------------------------------------------------------
//
// ARCHITECTURE.md §12's supported answer to "try the Claude connector on demo
// data" (bd myportfolio-cnd.6). `?demo=1` deliberately never answers MCP calls
// — a demo tab answering relayed calls would serve fabricated trades to
// somebody's agent as if they were their portfolio, and an agent cannot tell —
// and both relay legs are session-authed, so making it work would mean an
// unauthenticated pairing endpoint. This is the other side of that decision: a
// signed-in user puts the fixture in their OWN vault, so the connector works
// completely unchanged with no server change at all, and nothing is deceived
// because the user chose to put sample data there.
//
// It is deliberately tiny: demoRecords() already returns a plain record array
// and importRecords() already writes an array through the §3 port, so the sync
// layer picks it up on its own debounce. No bespoke upload path.

/**
 * Is this one of the fixture's own ids? demoRecords() mints stable literals and
 * every one of them is namespaced, which is what lets the sample be identified
 * and removed without storing a manifest of what was written.
 *
 * Neither id shape the rest of the app produces can match: §4's newRecordId is
 * `<type>_<ms>_<random>` with the random tail last, ppimport's are
 * `<type>_pp_<hex>`, and fx.js's ECB refresh writes `fx_EURUSD_2024-05-03` —
 * uppercase pair, dashed date — where the fixture writes `fx_eurusd_20240503`.
 */
export function isSampleId(recordId) {
    const id = String(recordId ?? '');
    return id.includes('_demo_') || /^fx_eurusd_\d{8}$/.test(id);
}

/** Is a sample already in the vault? Read off `state`, so it costs no query. */
export function sampleLoaded({ accounts = [], securities = [], transactions = [] } = {}) {
    return [...accounts, ...securities, ...transactions].some((r) => isSampleId(r?.recordId));
}

/**
 * The first currency in the user's OWN records that is not their reporting
 * currency, or null. This decides whether the fixture's `fx` records may be
 * written — see sampleRecords.
 */
export function ownForeignCurrency({ accounts = [], securities = [], transactions = [] } = {}, home) {
    const mine = String(home ?? '').toUpperCase();
    for (const rec of [...accounts, ...securities, ...transactions]) {
        if (isSampleId(rec?.recordId)) continue;
        const ccy = String(rec?.currency ?? '').toUpperCase();
        if (ccy && ccy !== mine) return ccy;
    }
    return null;
}

/**
 * What a sample load writes. Two things are held back, for two different
 * reasons, and both of them are silent data corruption if they are not.
 *
 * THE SETTINGS SINGLETON, always. §4 gives it a FIXED recordId, which makes it
 * the one record in the fixture whose id collides with something the user
 * already owns — and it is the record carrying `quoteProviders`, i.e. their API
 * keys. The §3 port replaces a body wholesale, so writing it would reset the
 * reporting currency and delete every stored credential as a side effect of
 * pressing "load sample data". ppimport.js declines to emit one for exactly this
 * reason; this is the same decision on the same record.
 *
 * THE `fx` RECORDS, when `fx` is false. Every other id in the fixture is
 * namespaced, so it can only collide with a previous sample load — but an `fx`
 * record is not looked up by id. fx.js keys its series by (pair, date), so the
 * fixture's five years of invented EURUSD fixings would be applied to the
 * user's own dollar holdings; and createFxRates breaks a same-day tie by rate,
 * so the invented one WINS over the real ECB fixing this app fetches (a probe
 * with 1.07 stored and 1.19 invented returned the invented one, no issue
 * raised). The ids differ from fx.js's, so a re-fetch never overwrites it: the
 * contamination is permanent and unattributable. Found by codex review.
 *
 * The cost of holding them back is that the fixture's one dollar-priced holding
 * shows as unconverted, which the UI already says out loud (§4). That is the
 * right trade: a visible gap in invented data beats invented rates silently
 * re-valuing a real portfolio.
 */
export function sampleRecords(seed, { fx = true } = {}) {
    return seed.filter((r) => {
        if (r.recordType === RECORD.settings && r.recordId === SETTINGS_ID) return false;
        if (!fx && r.recordType === RECORD.fx) return false;
        return true;
    });
}

/**
 * The confirmation. This writes ~1900 records into a real vault that then
 * SYNCS, so it must not be a stray tap: it names the true record count (the
 * fixture is built before the dialog opens, which is what makes that possible),
 * says the data is invented, says nothing existing is deleted, and says how to
 * take it back out.
 */
export function sampleConfirm({ count, hasData, withheldFx = null }) {
    return {
        title: 'Load the sample portfolio',
        confirmLabel: 'Load it',
        message: `This writes ${count} invented records into your own vault — five years of made-up `
            + 'trades, dividends and prices — and syncs them to your other devices. None of it is '
            + 'real market or personal data. '
            + (hasData
                ? 'Nothing you already have is deleted, but your own holdings and the sample will be '
                + 'mixed together on every screen until you remove it. '
                : '')
            + (withheldFx
                ? `You hold ${withheldFx}, and an exchange rate is stored per currency pair and day `
                + 'rather than per holding — so the sample\'s invented rates are left out entirely, '
                + 'and any an earlier load left behind are deleted, to keep them away from your own '
                + 'valuations. The sample\'s one dollar-priced holding will show as unconverted; '
                + 'nothing of yours changes value. '
                : '')
            + 'Use "Remove the sample portfolio" on this screen to undo it.',
    };
}

export function sampleRemoveConfirm(count) {
    return {
        title: 'Remove the sample portfolio',
        confirmLabel: 'Remove',
        message: `Deletes the ${count} sample records, on every device. Anything you entered or `
            + 'imported yourself is untouched.',
    };
}

// A report has to survive the re-render its own write causes — refresh() rebuilds
// this screen and detaches the status slot — exactly as importCard's does.
let lastSample = null;

/**
 * The sample rows currently in the vault, across `types`. Reading what is THERE
 * rather than rebuilding today's fixture is what makes both the removal and the
 * rate purge exact: the fixture's `fx` ids carry a date, so the five-year window
 * it covers moves with `today` — a sample loaded in March and reasoned about in
 * June would otherwise miss the days that fell off the back.
 */
async function loadedSampleRows(types) {
    const lists = await Promise.all(types.map((t) => records.list(t)));
    return lists.flat().filter((r) => isSampleId(r.recordId));
}

function sampleCard(rerender) {
    const status = ui.el('div', 'wg-error-slot');
    if (lastSample) status.replaceChildren(ui.messages(lastSample.lines, lastSample.tone));

    const fail = (message) => status.replaceChildren(ui.messages([message]));

    // The rows are gathered BEFORE the dialog and written only inside onConfirm.
    // That ordering is the safety property: pressing a button and then cancelling
    // touches nothing, and the count in the dialog is the real one rather than an
    // estimate.
    const ceremony = (plan, apply) => async () => {
        status.replaceChildren(ui.emptyState('Reading the sample portfolio…'));
        let step;
        try {
            step = await plan();
        } catch (err) {
            fail(`Could not read the sample portfolio: ${err?.message ?? err}`);
            return;
        }
        status.replaceChildren();
        ui.confirm({
            ...step.ask(step.rows.length),
            onConfirm: async () => {
                status.replaceChildren(ui.emptyState('Writing to your vault…'));
                try {
                    lastSample = await apply(step);
                } catch (err) {
                    fail(`The sample portfolio was not written in full: ${err?.message ?? err}`);
                    return;
                }
                rerender();
            },
        });
    };

    const loaded = sampleLoaded(state);

    const load = ui.button(
        'wg-toolbar-btn wg-toolbar-btn--primary',
        loaded ? 'Reload the sample portfolio' : 'Load sample portfolio',
        ceremony(
            async () => {
                const foreign = ownForeignCurrency(state, reportingCurrency());
                // A DYNAMIC import, the same way boot.js loads it: §12 keeps
                // demo.js out of sw.js's PRECACHE so a user who never presses
                // this never downloads the fixture, and the precache guard fails
                // in the other direction if it is added.
                const { demoRecords } = await import('./demo.js');
                // The same `today` boot.js's demo branch passes. A fixture seeded
                // against a wrong "today" produces a portfolio whose performance
                // range ends in the past (bd myportfolio-cnd.5).
                const seed = demoRecords({ today: new Date().toISOString().slice(0, 10) });
                return {
                    rows: sampleRecords(seed, { fx: !foreign }),
                    // Leaving the rates out of the seed is not enough on its own,
                    // and codex found the hole: a load that happened while the
                    // vault was still pure-EUR already wrote them, so acquiring a
                    // dollar holding afterwards puts them straight back in the
                    // path of real valuations. A withholding load therefore also
                    // tombstones the sample rates already there, which is what
                    // makes "nothing of yours changes value" true rather than
                    // aspirational — and makes pressing this button the cure for
                    // a vault that was already contaminated.
                    purge: foreign ? await loadedSampleRows([RECORD.fx]) : [],
                    ask: (count) => sampleConfirm({
                        count,
                        hasData: state.transactions.length > 0 && !loaded,
                        withheldFx: foreign,
                    }),
                };
            },
            async ({ rows, purge }) => {
                // Before the write, so one importRecords-driven refresh() sees the
                // finished state rather than a moment with both in it.
                for (const rec of purge) await records.del(rec.recordType, rec.recordId);
                const written = await importRecords(rows);
                return {
                    lines: [
                        `Wrote ${written} sample records. They reach your other devices on the usual `
                        + 'sync delay.',
                        ...(purge.length > 0
                            ? [`Deleted ${purge.length} invented exchange rates an earlier load had `
                                + 'left in your vault.']
                            : []),
                    ],
                    tone: 'normal',
                };
            }
        )
    );

    // Tombstones through the same §3 port the load went through, so sync carries
    // the removal the way it carried the write. records.del + one refresh()
    // rather than store.remove() per record, which would re-derive the whole
    // world 1900 times.
    const drop = !loaded ? null : ui.button(
        'wg-toolbar-btn wg-toolbar-btn--secondary',
        'Remove the sample portfolio',
        ceremony(
            async () => ({
                rows: await loadedSampleRows(Object.values(RECORD)),
                ask: sampleRemoveConfirm,
            }),
            async ({ rows }) => {
                for (const rec of rows) await records.del(rec.recordType, rec.recordId);
                await refresh();
                return { lines: [`Removed ${rows.length} sample records.`], tone: 'normal' };
            }
        )
    );

    const row = ui.el('div', 'flex-row flex-between gap-sm mt-md');
    row.appendChild(ui.el('span', 'flex-1'));
    if (drop) row.appendChild(drop);
    row.appendChild(load);

    return ui.card(
        ui.sectionLabel('Sample portfolio'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Five years of invented trades, dividends and prices, written into your own vault like '
            + 'any other import. This is the supported way to try the Claude connector — or the app '
            + 'itself — on data that is not yours: the demo at ?demo=1 never answers Claude, because '
            + 'a demo tab cannot tell an agent that the trades it is reading are made up. Nothing you '
            + 'already have is deleted or revalued, your reporting currency is never changed, and the '
            + 'sample can be removed again.'),
        row,
        status
    );
}

function exportCard() {
    const status = ui.el('div', 'wg-error-slot');
    const download = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Export JSON', async () => {
        try {
            const payload = await exportAll();
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = ui.el('a');
            link.href = url;
            link.download = `myportfolio-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            // Revoking immediately can race the download on some engines; one
            // turn of the event loop is enough and costs nothing.
            setTimeout(() => URL.revokeObjectURL(url), 0);
            status.replaceChildren(ui.messages([`Exported ${payload.records.length} records.`], 'normal'));
        } catch (err) {
            status.replaceChildren(ui.messages([`Export failed: ${err.message}`]));
        }
    });

    const row = ui.el('div', 'flex-row flex-between gap-sm');
    row.appendChild(ui.el('span', 'flex-1'));
    row.appendChild(download);

    return ui.card(
        ui.sectionLabel('Export'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Every live record as plain JSON — tombstones excluded. This is a backup you can read, '
            + 'not an encrypted blob.'),
        row,
        status
    );
}

export function render(container) {
    const rerender = () => render(container);
    const accountBalances = new Map((state.snapshot?.accounts ?? []).map((a) => [a.accountId, a.balance]));

    container.replaceChildren(
        syncCard(rerender),
        generalCard(rerender),
        quotesCard(rerender),
        connectClaudeCard(),
        recordsCard({
            label: 'Accounts',
            noun: 'account',
            items: state.accounts,
            type: RECORD.account,
            rerender,
            describe: (a) => [
                a.kind ?? 'cash',
                a.currency ?? '',
                accountBalances.has(a.recordId) ? fmt.money(accountBalances.get(a.recordId)) : null,
                a.closed ? 'closed' : null,
            ].filter(Boolean).join(' · '),
            onOpen: (record) => accountModal(record, rerender),
        }),
        recordsCard({
            label: 'Securities',
            noun: 'security',
            plural: 'securities',
            items: state.securities,
            type: RECORD.security,
            rerender,
            // The quote route is part of a security's identity now that
            // Holdings can fetch: "which of these will Refresh actually price"
            // has to be answerable without opening every row.
            describe: (s) => [
                s.ticker, s.isin, s.currency, s.assetClass ?? 'unclassified',
                s.quote?.provider && s.quote?.symbol ? `${s.quote.provider}:${s.quote.symbol}` : 'no quote',
            ].filter(Boolean).join(' · '),
            onOpen: (record) => securityModal(record, rerender),
        }),
        importCard(rerender),
        sampleCard(rerender),
        exportCard()
    );
}
