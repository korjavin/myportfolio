// Suite v1 crypto tests. Run with `node --test` — Node's built-in runner, no
// vitest and no npm dependencies.
//
// Two things are being checked, and the difference matters:
//
//   * vectors.json pins every deterministic derivation. It was generated once
//     from crypto.js and committed, so a refactor that changes a key derivation
//     fails here instead of silently locking every existing user out of their
//     vault.
//   * The same values are recomputed from node:crypto (hkdfSync, createHmac,
//     createDecipheriv) and a hand-rolled re-implementation of the uint16-BE
//     field framing. That is an INDEPENDENT implementation, so the pins are
//     cross-checked rather than merely self-consistent.
//
// The .mjs extension is deliberate: it is ESM regardless of whether a
// package.json is in scope, so this file runs identically on a branch without
// one and after Track B's web/package.json ({"type":"module"}) lands.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// Node 18 keeps globalThis.crypto behind --experimental-global-webcrypto; the
// browser always has it. Install it rather than teaching crypto.js about Node,
// so the module under test stays byte-identical to what ships to the browser.
// No-op on Node >= 19.
globalThis.crypto ??= nodeCrypto.webcrypto;

const SRC_URL = new URL('../crypto.js', import.meta.url);
const SOURCE = readFileSync(SRC_URL, 'utf8');
const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

// crypto.js is an ES module with a .js extension. Whether Node parses it as ESM
// depends on a package.json being in scope, which is Track B's file and not on
// every branch — so load it by evaluating its source as a data: URL module
// instead, which is ESM unconditionally. It has no imports of its own, so this
// is equivalent to importing it directly.
//
// Once web/package.json ({"type":"module"}) is on master this can simplify to
// `await import('../crypto.js')`.
let C;
async function crypto_() {
  C ??= await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE));
  return C;
}

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const hex = (u8) => Buffer.from(u8).toString('hex');
const bytes = (u8) => Array.from(u8);

const accountId = V.accountId;
const credentialId = b64(V.credentialIdB64);
const prf = b64(V.prfB64);
const dek = b64(V.dekB64);
const tk = b64(V.tkB64);

// --- independent re-implementations (node:crypto only) ---------------------

// uint16-BE length ‖ bytes per field, in argument order. Written out longhand
// on purpose: reusing crypto.js's encodeFields here would make the AAD checks
// below circular.
function fields(...parts) {
  return Buffer.concat(
    parts.map((p) => {
      const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8');
      const len = Buffer.alloc(2);
      len.writeUInt16BE(b.length);
      return Buffer.concat([len, b]);
    })
  );
}

function u64be(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

const hkdf = (ikm, salt, info, len = 32) =>
  Buffer.from(nodeCrypto.hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), len));

// WebCrypto returns ciphertext ‖ 16-byte tag; node:crypto wants them apart.
function gcmDecrypt(key, nonce, ctWithTag, aad) {
  const ct = Buffer.from(ctWithTag).subarray(0, ctWithTag.length - 16);
  const tag = Buffer.from(ctWithTag).subarray(ctWithTag.length - 16);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// --- the port itself --------------------------------------------------------

describe('port hygiene (ARCHITECTURE.md 8)', () => {
  // Delta 1: "an envelope from one must never be openable by the other". Tested
  // semantically rather than by grepping the source for "mt/v1/", because what
  // matters is the derived key, not the spelling — every derivation below is
  // recomputed under medtracker's labels and must come out different.
  it('derives nothing that collides with medtracker under the same inputs', async () => {
    const c = await crypto_();
    const codeBytes = b64(V.recoveryCode.codeBytesB64);

    assert.notEqual(
      hex(await c.saltKek()),
      nodeCrypto.createHash('sha256').update('medtracker/v1/prf-kek').digest('hex'),
      'salt_kek still matches medtracker'
    );

    const collisions = [
      [await c.deriveKEK(prf, accountId, credentialId), hkdf(prf, accountId, fields('mt/v1/kek', Buffer.from(credentialId)))],
      [await c.deriveKMac(dek), hkdf(dek, Buffer.alloc(0), 'mt/v1/envmac')],
      [await c.deriveKData(dek), hkdf(dek, Buffer.alloc(0), 'mt/v1/data')],
      [await c.deriveKEKRec(codeBytes, accountId), hkdf(codeBytes, accountId, 'mt/v1/kek-rec')],
      [await c.deriveVerifier(codeBytes, accountId), hkdf(codeBytes, accountId, 'mt/v1/rec-auth')],
    ];
    for (const [ours, theirs] of collisions) {
      assert.notEqual(hex(ours), theirs.toString('hex'), 'a derivation still uses a medtracker label');
    }
  });

  it('seals the envelope, transfer, and state AADs under mp/v1 labels', async () => {
    // The AAD labels are not covered by the key checks above: a wrong label
    // there would still derive the right key but bind the wrong context.
    const e = { nonce: b64(V.envelope.nonceB64), ct: b64(V.envelope.ctB64) };
    const kek = Buffer.from(V.kekHex, 'hex');
    assert.throws(
      () => gcmDecrypt(kek, e.nonce, e.ct, fields('mt/v1/env', accountId, Buffer.from(credentialId))),
      'envelope AAD still uses a medtracker label'
    );
    assert.throws(
      () => gcmDecrypt(tk, b64(V.transferPayloadB64).slice(0, 12), b64(V.transferPayloadB64).slice(12), fields('mt/v1/xfer', accountId)),
      'transfer AAD still uses a medtracker label'
    );
    // medtracker had no state blob at all; its nearest analogue was the snapshot.
    assert.throws(
      () => gcmDecrypt(Buffer.from(V.kDataHex, 'hex'), b64(V.state.nonceB64), b64(V.state.ctB64), fields('mt/v1/snap', accountId, u64be(V.state.version))),
      'state AAD still uses a medtracker label'
    );
  });

  it('does not export the primitives this app deliberately dropped', async () => {
    const c = await crypto_();
    for (const dropped of [
      'encryptRecord', 'decryptRecord', // no oplog
      'encryptSnapshot', 'decryptSnapshot', // replaced by encryptState/decryptState
      'encryptPushPayload', 'decryptPushPayload', // no push
      'openInboxEvent', 'generateInboxKeypair', 'inboxCryptoSupported', // no X25519 inbox
    ]) {
      assert.equal(c[dropped], undefined, `crypto.js re-exports dropped primitive ${dropped}`);
    }
    // sealMCPFrame/openMCPFrame were on this list — ARCHITECTURE.md §8.3 said
    // "no MCP relay" — and the owner reversed that: the AI connector is a
    // headline goal (§11). They are now REQUIRED, and tested in
    // mcp-frame.test.mjs against vectors the Go shim decrypts too.
    assert.equal(typeof c.sealMCPFrame, 'function');
    assert.equal(typeof c.openMCPFrame, 'function');
  });

  it('keeps toBase64 chunked rather than a per-char loop', () => {
    // A measured 10x on the state-blob upload path, not incidental style.
    assert.match(SOURCE, /String\.fromCharCode\.apply/);
    assert.match(SOURCE, /B64_CHUNK = 0x8000/);
  });
});

describe('pinned vectors — key hierarchy', () => {
  it('salt_kek is SHA-256("myportfolio/v1/prf-kek")', async () => {
    const { saltKek } = await crypto_();
    assert.equal(hex(await saltKek()), V.saltKekHex);
    // Independent: node:crypto over the literal label.
    assert.equal(nodeCrypto.createHash('sha256').update('myportfolio/v1/prf-kek').digest('hex'), V.saltKekHex);
  });

  it('encodeFields frames uint16-BE length ‖ bytes in argument order', async () => {
    const { encodeFields } = await crypto_();
    assert.equal(hex(encodeFields('mp/v1/kek', credentialId)), V.encodeFieldsHex);
    assert.equal(fields('mp/v1/kek', Buffer.from(credentialId)).toString('hex'), V.encodeFieldsHex);
  });

  it('deriveKEK = HKDF(PRF, salt=account_id, info="mp/v1/kek" ‖ credential_id)', async () => {
    const { deriveKEK } = await crypto_();
    const kek = await deriveKEK(prf, accountId, credentialId);
    assert.equal(hex(kek), V.kekHex);
    assert.equal(hkdf(prf, accountId, fields('mp/v1/kek', Buffer.from(credentialId))).toString('hex'), V.kekHex);
  });

  it('deriveKMac = HKDF(DEK, info="mp/v1/envmac")', async () => {
    const { deriveKMac } = await crypto_();
    assert.equal(hex(await deriveKMac(dek)), V.kMacHex);
    assert.equal(hkdf(dek, Buffer.alloc(0), 'mp/v1/envmac').toString('hex'), V.kMacHex);
  });

  it('deriveKData = HKDF(DEK, info="mp/v1/data")', async () => {
    const { deriveKData } = await crypto_();
    assert.equal(hex(await deriveKData(dek)), V.kDataHex);
    assert.equal(hkdf(dek, Buffer.alloc(0), 'mp/v1/data').toString('hex'), V.kDataHex);
  });

  it('deriveKEKRec and deriveVerifier are domain-separated', async () => {
    const { deriveKEKRec, deriveVerifier } = await crypto_();
    const codeBytes = b64(V.recoveryCode.codeBytesB64);
    assert.equal(hex(await deriveKEKRec(codeBytes, accountId)), V.kekRecHex);
    assert.equal(hex(await deriveVerifier(codeBytes, accountId)), V.verifierHex);
    assert.equal(hkdf(codeBytes, accountId, 'mp/v1/kek-rec').toString('hex'), V.kekRecHex);
    assert.equal(hkdf(codeBytes, accountId, 'mp/v1/rec-auth').toString('hex'), V.verifierHex);
    // The server stores SHA-256(verifier); it must be useless for unwrapping.
    assert.notEqual(V.kekRecHex, V.verifierHex);
  });
});

describe('envelope', () => {
  const envelope = () => ({
    v: V.envelope.v,
    credential_id: credentialId,
    nonce: b64(V.envelope.nonceB64),
    ct: b64(V.envelope.ctB64),
    mac: new Uint8Array(Buffer.from(V.envelope.macHex, 'hex')),
  });

  it('unwraps the pinned envelope back to the DEK', async () => {
    const { unwrapEnvelope, deriveKEK } = await crypto_();
    const kek = await deriveKEK(prf, accountId, credentialId);
    const got = await unwrapEnvelope({ kek, envelope: envelope(), accountId, credentialId });
    assert.deepEqual(bytes(got), bytes(dek));
  });

  it('node:crypto opens the same envelope with the same AAD', async () => {
    const e = envelope();
    const aad = fields('mp/v1/env', accountId, Buffer.from(credentialId));
    const got = gcmDecrypt(Buffer.from(V.kekHex, 'hex'), e.nonce, e.ct, aad);
    assert.deepEqual(bytes(got), bytes(dek));
  });

  it('computeEnvelopeMac matches the pin and an independent HMAC', async () => {
    const { computeEnvelopeMac } = await crypto_();
    const e = envelope();
    const kMac = Buffer.from(V.kMacHex, 'hex');
    assert.equal(hex(await computeEnvelopeMac(kMac, credentialId, e.nonce, e.ct)), V.envelope.macHex);

    const data = fields('mp/v1/envmac', Buffer.from(credentialId), Buffer.from(e.nonce), Buffer.from(e.ct));
    assert.equal(nodeCrypto.createHmac('sha256', kMac).update(data).digest('hex'), V.envelope.macHex);
  });

  it('audits the pinned envelope as genuine', async () => {
    const { auditEnvelope } = await crypto_();
    assert.equal(await auditEnvelope({ dek, envelope: envelope(), credentialId }), true);
  });

  it('fails the audit when the envelope was forged without the DEK', async () => {
    const { auditEnvelope, generateDEK } = await crypto_();
    assert.equal(await auditEnvelope({ dek: generateDEK(), envelope: envelope(), credentialId }), false);
  });

  it('round-trips a freshly wrapped envelope', async () => {
    const { deriveKEK, deriveKMac, wrapEnvelope, unwrapEnvelope, auditEnvelope, generateDEK } = await crypto_();
    const freshDek = generateDEK();
    const kek = await deriveKEK(prf, accountId, credentialId);
    const kMac = await deriveKMac(freshDek);
    const e = await wrapEnvelope({ kek, dek: freshDek, kMac, accountId, credentialId });
    assert.equal(e.v, 1);
    assert.equal(e.nonce.length, 12);
    assert.deepEqual(bytes(await unwrapEnvelope({ kek, envelope: e, accountId, credentialId })), bytes(freshDek));
    assert.equal(await auditEnvelope({ dek: freshDek, envelope: e, credentialId }), true);
  });

  describe('AEAD negatives', () => {
    const kekOf = async () => (await crypto_()).deriveKEK(prf, accountId, credentialId);

    it('rejects a tampered ciphertext byte', async () => {
      const { unwrapEnvelope } = await crypto_();
      const e = envelope();
      e.ct[0] ^= 0xff;
      await assert.rejects(unwrapEnvelope({ kek: await kekOf(), envelope: e, accountId, credentialId }));
    });

    it('rejects a tampered authentication tag', async () => {
      const { unwrapEnvelope } = await crypto_();
      const e = envelope();
      e.ct[e.ct.length - 1] ^= 0x01;
      await assert.rejects(unwrapEnvelope({ kek: await kekOf(), envelope: e, accountId, credentialId }));
    });

    it('rejects a tampered nonce', async () => {
      const { unwrapEnvelope } = await crypto_();
      const e = envelope();
      e.nonce[0] ^= 0xff;
      await assert.rejects(unwrapEnvelope({ kek: await kekOf(), envelope: e, accountId, credentialId }));
    });

    it('rejects a foreign account id in the AAD', async () => {
      const { unwrapEnvelope } = await crypto_();
      await assert.rejects(
        unwrapEnvelope({ kek: await kekOf(), envelope: envelope(), accountId: 'someone-else', credentialId })
      );
    });

    it('rejects a foreign credential id in the AAD', async () => {
      const { unwrapEnvelope } = await crypto_();
      await assert.rejects(
        unwrapEnvelope({
          kek: await kekOf(),
          envelope: envelope(),
          accountId,
          credentialId: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
        })
      );
    });

    it('rejects a KEK derived from a different PRF output', async () => {
      const { deriveKEK, unwrapEnvelope } = await crypto_();
      const wrongKek = await deriveKEK(new Uint8Array(32), accountId, credentialId);
      await assert.rejects(unwrapEnvelope({ kek: wrongKek, envelope: envelope(), accountId, credentialId }));
    });
  });
});

describe('state blob (ARCHITECTURE.md 6)', () => {
  const kData = new Uint8Array(Buffer.from(V.kDataHex, 'hex'));
  const nonce = b64(V.state.nonceB64);
  const ct = b64(V.state.ctB64);
  const version = V.state.version;
  const plaintext = Buffer.from(V.state.plaintextUtf8, 'utf8');

  it('decrypts the pinned blob at its pinned version', async () => {
    const { decryptState } = await crypto_();
    const got = await decryptState({ kData, accountId, version, nonce, ct });
    assert.equal(Buffer.from(got).toString('utf8'), V.state.plaintextUtf8);
  });

  it('node:crypto opens it with aad = "mp/v1/state" ‖ account_id ‖ uint64-BE version', async () => {
    // The independent check that pins how `version` is framed — ARCHITECTURE.md 6
    // writes `encodeFields("mp/v1/state", accountId, version)` without saying,
    // so this is the contract A5's server and client must both honour.
    const aad = fields('mp/v1/state', accountId, u64be(version));
    assert.deepEqual(gcmDecrypt(kData, nonce, ct, aad), plaintext);
  });

  it('round-trips gzip(JSON) through encrypt/decrypt', async () => {
    const { encryptState, decryptState, deriveKData, generateDEK, gzip, gunzip, isGzip } = await crypto_();
    const k = await deriveKData(generateDEK());
    const records = Array.from({ length: 500 }, (_, i) => ({
      recordId: `transaction_${i}`,
      recordType: 'transaction',
      amount: i * 100,
    }));
    const raw = new TextEncoder().encode(JSON.stringify(records));
    const compressed = await gzip(raw);
    assert.ok(compressed.length < raw.length, 'gzip must actually shrink the state');

    const { nonce: n, ct: c } = await encryptState({ kData: k, accountId, version: 7, plaintext: compressed });
    const got = await decryptState({ kData: k, accountId, version: 7, nonce: n, ct: c });
    assert.equal(isGzip(got), true);
    assert.equal(new TextDecoder().decode(await gunzip(got)), JSON.stringify(records));
  });

  it('rejects a wrong version in the AAD — the rollback guard', async () => {
    const { decryptState } = await crypto_();
    // The server can replay a matched (version, nonce, ct) triple, but binding
    // version into the AAD stops it re-labelling an old blob as a newer one.
    for (const wrong of [0, version - 1, version + 1, 1000]) {
      await assert.rejects(
        decryptState({ kData, accountId, version: wrong, nonce, ct }),
        `version ${wrong} must not open a blob sealed at ${version}`
      );
    }
  });

  it('rejects a foreign account id, a tampered ct, and a tampered nonce', async () => {
    const { decryptState } = await crypto_();
    await assert.rejects(decryptState({ kData, accountId: 'someone-else', version, nonce, ct }));

    const badCt = ct.slice();
    badCt[0] ^= 0xff;
    await assert.rejects(decryptState({ kData, accountId, version, nonce, ct: badCt }));

    const badTag = ct.slice();
    badTag[badTag.length - 1] ^= 0x01;
    await assert.rejects(decryptState({ kData, accountId, version, nonce, ct: badTag }));

    const badNonce = nonce.slice();
    badNonce[0] ^= 0xff;
    await assert.rejects(decryptState({ kData, accountId, version, nonce: badNonce, ct }));
  });

  it('rejects a non-integer or negative version rather than framing it silently', async () => {
    const { encryptState } = await crypto_();
    for (const bad of [-1, 1.5, NaN, '3', undefined]) {
      await assert.rejects(
        encryptState({ kData, accountId, version: bad, plaintext }),
        RangeError,
        `version ${String(bad)} must be refused`
      );
    }
  });

  it('uses a fresh nonce per encryption', async () => {
    const { encryptState } = await crypto_();
    const a = await encryptState({ kData, accountId, version, plaintext });
    const b = await encryptState({ kData, accountId, version, plaintext });
    assert.notDeepEqual(bytes(a.nonce), bytes(b.nonce));
  });
});

describe('device transfer payload', () => {
  it('decrypts the pinned payload back to the DEK', async () => {
    const { decryptTransferPayload } = await crypto_();
    const got = await decryptTransferPayload(tk, b64(V.transferPayloadB64), accountId);
    assert.deepEqual(bytes(got), bytes(dek));
  });

  it('node:crypto opens it as nonce(12) ‖ AES-GCM(TK, DEK, aad="mp/v1/xfer" ‖ account_id)', () => {
    const packed = b64(V.transferPayloadB64);
    const got = gcmDecrypt(tk, packed.slice(0, 12), packed.slice(12), fields('mp/v1/xfer', accountId));
    assert.deepEqual(bytes(got), bytes(dek));
  });

  it('round-trips under a fresh TK', async () => {
    const { encryptTransferPayload, decryptTransferPayload, generateDEK } = await crypto_();
    const freshTk = crypto.getRandomValues(new Uint8Array(32));
    const freshDek = generateDEK();
    const packed = await encryptTransferPayload(freshTk, freshDek, accountId);
    assert.deepEqual(bytes(await decryptTransferPayload(freshTk, packed, accountId)), bytes(freshDek));
  });

  it('rejects the wrong TK and a foreign account id', async () => {
    const { decryptTransferPayload } = await crypto_();
    const packed = b64(V.transferPayloadB64);
    await assert.rejects(decryptTransferPayload(crypto.getRandomValues(new Uint8Array(32)), packed, accountId));
    await assert.rejects(decryptTransferPayload(tk, packed, 'someone-else'));
  });
});

describe('recovery code', () => {
  it('matches the pinned Crockford encoding and checksum group', async () => {
    const { base32Encode, parseRecoveryCode } = await crypto_();
    const codeBytes = b64(V.recoveryCode.codeBytesB64);
    assert.equal(base32Encode(codeBytes), V.base32.encoded);
    assert.deepEqual(bytes(await parseRecoveryCode(V.recoveryCode.formatted)), bytes(codeBytes));
  });

  it('generates a 160-bit code that round-trips through parseRecoveryCode', async () => {
    const { generateRecoveryCode, parseRecoveryCode } = await crypto_();
    const { codeBytes, formatted } = await generateRecoveryCode();
    assert.equal(codeBytes.length, 20);
    assert.match(formatted, /^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    assert.deepEqual(bytes(await parseRecoveryCode(formatted)), bytes(codeBytes));
  });

  it('normalizes Crockford O/I/L transcription typos in body and checksum alike', async () => {
    const { parseRecoveryCode } = await crypto_();
    const codeBytes = b64(V.recoveryCode.codeBytesB64);
    const canonical = V.recoveryCode.formatted;
    // O->0 and I/L->1 everywhere, including the checksum group: a typo must not
    // be tolerated in the body but falsely rejected in the checksum.
    const typoed = canonical.replace(/0/g, 'O').replace(/1/g, 'L');
    assert.notEqual(typoed, canonical, 'pinned code should contain a 0 or 1 to substitute');
    assert.deepEqual(bytes(await parseRecoveryCode(typoed)), bytes(codeBytes));
    assert.deepEqual(bytes(await parseRecoveryCode(canonical.toLowerCase())), bytes(codeBytes));
    assert.deepEqual(bytes(await parseRecoveryCode(canonical.replace(/-/g, ' '))), bytes(codeBytes));
  });

  it('rejects a corrupted checksum group', async () => {
    const { parseRecoveryCode } = await crypto_();
    const groups = V.recoveryCode.formatted.split('-');
    groups[8] = (groups[8][0] === '0' ? '1' : '0') + groups[8].slice(1);
    await assert.rejects(parseRecoveryCode(groups.join('-')), /checksum/);
  });

  it('rejects a corrupted code body', async () => {
    const { parseRecoveryCode } = await crypto_();
    const groups = V.recoveryCode.formatted.split('-');
    groups[0] = (groups[0][0] === '2' ? '3' : '2') + groups[0].slice(1);
    await assert.rejects(parseRecoveryCode(groups.join('-')), /checksum/);
  });

  it('rejects a wrong-length code and an out-of-alphabet character', async () => {
    const { parseRecoveryCode, base32Decode } = await crypto_();
    await assert.rejects(parseRecoveryCode(V.recoveryCode.formatted.slice(0, -1)), /length/);
    assert.throws(() => base32Decode('UU'), /invalid recovery code character/);
  });
});

describe('encodeFields length guard', () => {
  it('accepts a field at the uint16 ceiling and rejects one past it', async () => {
    const { encodeFields } = await crypto_();
    // A longer field would truncate to (length & 0xffff) and corrupt the framing
    // of every field after it. Fail loudly instead.
    assert.doesNotThrow(() => encodeFields(new Uint8Array(0xffff)));
    assert.throws(() => encodeFields(new Uint8Array(0x10000)), RangeError);
  });
});

describe('gzip sniffing', () => {
  it('round-trips and discriminates the magic bytes', async () => {
    const { gzip, gunzip, isGzip } = await crypto_();
    const gzipped = await gzip(new TextEncoder().encode('[]'));
    assert.equal(isGzip(gzipped), true);
    assert.equal(gzipped[0], 0x1f);
    assert.equal(gzipped[1], 0x8b);
    assert.equal(new TextDecoder().decode(await gunzip(gzipped)), '[]');

    // Uncompressed state starts with '[' (0x5b) or '{' (0x7b).
    assert.equal(isGzip(new TextEncoder().encode('[{"recordId":"tx_1"}]')), false);
    assert.equal(isGzip(new TextEncoder().encode('{}')), false);
    assert.equal(isGzip(new Uint8Array([0x1f])), false); // too short to sniff
    assert.equal(isGzip(new Uint8Array(0)), false);
  });
});

// toBase64 sits on the state-blob upload path, so it runs on every sync. It
// used to grow the binary string one char at a time (1096 ms per 24.5 MiB);
// chunking is a measured 10x. Both the native path and the chunked fallback
// must agree with each other and with Go's encoding/base64.
describe('toBase64 chunking', () => {
  const withoutNative = (fn) => {
    const native = Uint8Array.prototype.toBase64;
    if (native) delete Uint8Array.prototype.toBase64;
    try {
      return fn();
    } finally {
      if (native) Uint8Array.prototype.toBase64 = native;
    }
  };

  // Deterministic fill: every byte value recurs, so a mangled chunk seam shows
  // up as a base64 mismatch. (getRandomValues caps at 65,536 bytes anyway.)
  const filled = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

  const cases = [
    ['empty', new Uint8Array(0)],
    ['1 byte', new Uint8Array([0])],
    ['every byte value', Uint8Array.from({ length: 256 }, (_, i) => i)],
    // Straddle the 0x8000 chunk boundary: an off-by-one there corrupts the
    // base64 mid-stream, and .apply() past ~65k args throws RangeError.
    ['chunk boundary - 1', filled(0x8000 - 1)],
    ['chunk boundary', filled(0x8000)],
    ['chunk boundary + 1', filled(0x8000 + 1)],
    ['multi-chunk, not a multiple of 3', filled(0x8000 * 2 + 7)],
  ];

  for (const [name, input] of cases) {
    it(`matches Buffer's base64 and round-trips: ${name}`, async () => {
      const { toBase64, fromBase64 } = await crypto_();
      const expected = Buffer.from(input).toString('base64');
      assert.equal(toBase64(input), expected);
      assert.equal(withoutNative(() => toBase64(input)), expected);
      assert.deepEqual(bytes(fromBase64(toBase64(input))), bytes(input));
    });
  }

  it('the chunked fallback agrees with the native method on a blob-sized buffer', async () => {
    const { toBase64 } = await crypto_();
    const input = filled(1 << 20);
    assert.equal(withoutNative(() => toBase64(input)), toBase64(input));
  });

  it('toBase64Url produces unpadded base64url over both paths', async () => {
    const { toBase64, toBase64Url, fromBase64Url } = await crypto_();
    const input = new Uint8Array([0xfb, 0xff, 0xfe, 0x00]);
    assert.equal(toBase64(input), '+//+AA==');
    assert.equal(toBase64Url(input), '-__-AA');
    assert.equal(withoutNative(() => toBase64Url(input)), '-__-AA');
    assert.deepEqual(bytes(fromBase64Url('-__-AA')), bytes(input));
  });
});

describe('timingSafeEqual', () => {
  it('compares by content and rejects a length mismatch', async () => {
    const { timingSafeEqual } = await crypto_();
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  });
});
