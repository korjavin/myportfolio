// Suite v1 client crypto. Ported near-verbatim from medicationtrackerbot's
// web/cloud/js/crypto.js — see that project's docs/cloud-crypto.md "Exact
// formats" for the normative key hierarchy, which myportfolio adopts as-is
// (docs/ARCHITECTURE.md 8). Pure WebCrypto (crypto.subtle), no DOM. Every
// export takes/returns Uint8Array/plain objects so it can be unit-tested under
// Node and reused from signup.js/unlock.js without a bundler.
//
// Four deltas from the source, all listed in ARCHITECTURE.md 8:
//
//   1. Domain-separation labels are "mp/v1/*", never "mt/v1/*", and
//      salt_kek = SHA-256("myportfolio/v1/prf-kek"). Different app, different
//      derivation: an envelope from one must never open under the other.
//   2. No oplog. encryptRecord/decryptRecord and encryptSnapshot/
//      decryptSnapshot are replaced by the single encryptState/decryptState
//      pair below, bound to the server's compare-and-swap `version`.
//   3. No push payload — a portfolio tracker has no background notifications
//      to decrypt. The MCP frame crypto, dropped alongside it in the original
//      port, is BACK: 8.3 used to say "no MCP relay" and the owner reversed
//      it, because an AI connector that cannot read your data is a headline
//      goal for this product (11). See sealMCPFrame/openMCPFrame below.
//   4. No X25519 sealed inbox — nothing relays events to us.

// SUITE_VERSION is the CRYPTO SUITE version stamped into an envelope's `v`
// field. It is unrelated to the state blob's `version`, which is the server's
// compare-and-swap counter (ARCHITECTURE.md 6) — the two never mix.
export const SUITE_VERSION = 1;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Crockford base32 treats these as human-transcription typos of a canonical symbol.
const CROCKFORD_NORMALIZE = { O: '0', I: '1', L: '1' };

export function utf8(str) {
  return new TextEncoder().encode(str);
}

// Standard base64 (with padding) — matches Go's encoding/json []byte
// marshaling, used for the envelope wire fields (nonce/ct/mac).
//
// This sits on the state-blob UPLOAD path (PUT /api/state -> toBase64(ct)), so
// it runs on every sync. Growing `binary` one char at a time cost 1096 ms per
// 24.5 MiB; chunked fromCharCode.apply is 118 ms, and the native method is
// faster still. Do NOT "simplify" this to a per-char loop. Chunk stays under
// the ~65k argument-count limit that makes .apply() throw RangeError on large
// inputs.
const B64_CHUNK = 0x8000;

export function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// base64url (unpadded) — matches the server's credential_ref path segment
// (base64.RawURLEncoding) and WebAuthn's JSON encoding of binary fields.
export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return fromBase64(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// uint16-BE length ‖ bytes per field, concatenated in argument order.
export function encodeFields(...parts) {
  const fields = parts.map((part) => (part instanceof Uint8Array ? part : utf8(part)));
  const total = fields.reduce((n, f) => n + 2 + f.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of fields) {
    // uint16-BE length prefix caps each field at 65535 bytes; a longer field
    // would silently truncate to (length & 0xffff) and corrupt every following
    // field's framing. Fail loudly instead.
    if (f.length > 0xffff) throw new RangeError(`encodeFields: field of ${f.length} bytes exceeds uint16 length prefix`);
    new DataView(out.buffer).setUint16(offset, f.length, false);
    out.set(f, offset + 2);
    offset += 2 + f.length;
  }
  return out;
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const rawChar of str.toUpperCase()) {
    const ch = CROCKFORD_NORMALIZE[rawChar] || rawChar;
    const idx = CROCKFORD_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid recovery code character: ' + rawChar);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hkdf(ikm, salt, info, lengthBytes = 32) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

async function aesGcmEncrypt(rawKey, nonce, plaintext, aad) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(rawKey, nonce, ciphertext, aad) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext);
  return new Uint8Array(pt);
}

// salt_kek — the PRF eval.first input, identical for every credential.
// "myportfolio/v1/prf-kek", NOT medtracker's "medtracker/v1/prf-kek": the
// change is what stops a passkey enrolled in one app from deriving the other's
// KEK (ARCHITECTURE.md 8.1).
export async function saltKek() {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8('myportfolio/v1/prf-kek')));
}

export function generateDEK() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// KEK_i = HKDF(ikm = PRF_i, salt = account_id, info = "mp/v1/kek" ‖ credential_id_i)
//
// Single origin means the client does not know account_id before a cold unlock
// (ARCHITECTURE.md 8.2): the discoverable-credential assertion returns
// {account_id, envelope}, and only then can this be called. The PRF output
// itself never leaves the client either way.
export async function deriveKEK(prfOutput, accountId, credentialId) {
  const info = encodeFields('mp/v1/kek', credentialId);
  return hkdf(prfOutput, utf8(accountId), info);
}

// K_mac = HKDF(DEK, info="mp/v1/envmac") — derived only after DEK is known,
// so a party that can't unwrap any envelope can't mint a valid audit tag.
export async function deriveKMac(dek) {
  return hkdf(dek, new Uint8Array(0), utf8('mp/v1/envmac'));
}

export async function computeEnvelopeMac(kMac, credentialId, nonce, ct) {
  const data = encodeFields('mp/v1/envmac', credentialId, nonce, ct);
  const key = await crypto.subtle.importKey('raw', kMac, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// envelope_i = { v, credential_id, nonce, ct = AES-GCM(KEK_i, DEK, aad), mac }
export async function wrapEnvelope({ kek, dek, kMac, accountId, credentialId }) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mp/v1/env', accountId, credentialId);
  const ct = await aesGcmEncrypt(kek, nonce, dek, aad);
  const mac = await computeEnvelopeMac(kMac, credentialId, nonce, ct);
  return { v: SUITE_VERSION, credential_id: credentialId, nonce, ct, mac };
}

// Unwraps DEK. Throws (AEAD failure) on any tampered nonce/ct/aad.
export async function unwrapEnvelope({ kek, envelope, accountId, credentialId }) {
  const aad = encodeFields('mp/v1/env', accountId, credentialId);
  return aesGcmDecrypt(kek, envelope.nonce, envelope.ct, aad);
}

// Audits envelope.mac against a freshly-derived K_mac once DEK is known —
// flags envelopes an operator forged without holding the DEK ("Malicious
// operator adds their own credential" in medtracker's docs/cloud-crypto.md).
export async function auditEnvelope({ dek, envelope, credentialId }) {
  const kMac = await deriveKMac(dek);
  const expected = await computeEnvelopeMac(kMac, credentialId, envelope.nonce, envelope.ct);
  return timingSafeEqual(expected, envelope.mac);
}

// Path B device transfer: the DEK encrypted under a one-shot transfer key TK,
// never a KEK — the server's ct column is opaque, so nonce ‖ ciphertext is
// packed into one blob rather than adding a second wire field.
export async function encryptTransferPayload(tk, dek, accountId) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mp/v1/xfer', accountId);
  const ct = await aesGcmEncrypt(tk, nonce, dek, aad);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return packed;
}

// Throws (AEAD failure) on a tampered or wrong-TK packed payload.
export async function decryptTransferPayload(tk, packed, accountId) {
  const nonce = packed.slice(0, 12);
  const ct = packed.slice(12);
  const aad = encodeFields('mp/v1/xfer', accountId);
  return aesGcmDecrypt(tk, nonce, ct, aad);
}

async function checksumGroup(codeBytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', codeBytes));
  return base32Encode(digest.slice(0, 3)).slice(0, 4);
}

// 160 random bits, Crockford base32, grouped 8x4 plus a trailing 4-char
// checksum group (SHA-256-derived) for offline typo detection.
export async function generateRecoveryCode() {
  const codeBytes = crypto.getRandomValues(new Uint8Array(20));
  const groups = base32Encode(codeBytes).match(/.{1,4}/g);
  groups.push(await checksumGroup(codeBytes));
  return { codeBytes, formatted: groups.join('-') };
}

// Parses a user-typed recovery code, validating the checksum group. Throws
// on malformed input or checksum mismatch.
export async function parseRecoveryCode(formatted) {
  const clean = formatted.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 36) throw new Error('invalid recovery code length');
  const codeBytes = base32Decode(clean.slice(0, 32));
  const expected = await checksumGroup(codeBytes);
  // Normalize the typed checksum group the same way base32Decode normalizes the
  // body, so an O/I/L transcription typo isn't tolerated in the code but
  // falsely rejected in the checksum.
  const typedChecksum = [...clean.slice(32, 36)].map((c) => CROCKFORD_NORMALIZE[c] || c).join('');
  if (expected !== typedChecksum) throw new Error('invalid recovery code checksum');
  return codeBytes;
}

export async function deriveKEKRec(codeBytes, accountId) {
  return hkdf(codeBytes, utf8(accountId), utf8('mp/v1/kek-rec'));
}

// The server stores SHA-256(verifier) to authenticate and rate-limit a recovery
// attempt. Domain separation from KEK_rec above is what stops that stored value
// from being useful for unwrapping the recovery envelope.
export async function deriveVerifier(codeBytes, accountId) {
  return hkdf(codeBytes, utf8(accountId), utf8('mp/v1/rec-auth'));
}

// K_data = HKDF(DEK, info="mp/v1/data") — the state-blob encryption key.
export async function deriveKData(dek) {
  return hkdf(dek, new Uint8Array(0), utf8('mp/v1/data'));
}

// The state blob's `version` is the server's compare-and-swap counter
// (ARCHITECTURE.md 6), a JS number (server int64, well under
// Number.MAX_SAFE_INTEGER at any real workload). Fixed 8-byte big-endian
// framing keeps the AAD encoding unambiguous — the same choice medtracker made
// for account_seq/snapshot_seq, and the reason ARCHITECTURE.md 6's shorthand
// `encodeFields("mp/v1/state", accountId, version)` is realized here rather
// than by letting a caller decide how to stringify a number.
function encodeVersion(version) {
  if (!Number.isInteger(version) || version < 0) {
    throw new RangeError(`state version must be a non-negative integer, got ${version}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(version), false);
  return out;
}

function stateAAD(accountId, version) {
  return encodeFields('mp/v1/state', accountId, encodeVersion(version));
}

// The state blob (ARCHITECTURE.md 6): one opaque record per account, replacing
// medtracker's oplog + snapshot entirely.
//
//   ct = AES-GCM(K_data, plaintext, aad = "mp/v1/state" ‖ account_id ‖ version)
//
// `plaintext` is gzip(utf8(JSON(records))) — compress BEFORE encrypting, ~10x
// smaller body. The gzip step is the caller's (sync.js), same seam medtracker
// used, so this function stays a pure AEAD over bytes; use gzip/gunzip/isGzip
// below.
//
// Binding `version` into the AAD is what makes rollback detectable: the server
// can replay a matched (version, nonce, ct) triple but cannot re-label an old
// blob as a newer one, because decrypting it under the claimed version fails.
export async function encryptState({ kData, accountId, version, plaintext }) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesGcmEncrypt(kData, nonce, plaintext, stateAAD(accountId, version));
  return { nonce, ct };
}

// Throws (AEAD failure) when the ciphertext, the nonce, the account id, or the
// server-claimed version is not the one this blob was sealed under.
export async function decryptState({ kData, accountId, version, nonce, ct }) {
  return aesGcmDecrypt(kData, nonce, ct, stateAAD(accountId, version));
}

// gzip/gunzip via Web Streams (CompressionStream). Used to compress the state
// JSON *before* encryption so the ciphertext (and PUT body) shrinks ~10x. A
// gzip stream always starts with the 2-byte magic 0x1f 0x8b; raw-JSON state
// starts with '[' (0x5b) or '{' (0x7b), so the decrypt path can sniff which is
// which — no wire field, and an uncompressed blob stays readable.
async function streamThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function gzip(bytes) {
  return streamThrough(bytes, new CompressionStream('gzip'));
}

export function gunzip(bytes) {
  return streamThrough(bytes, new DecompressionStream('gzip'));
}

export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// --- The AI connector: MCP frames over a blind relay (mp/v1/mcp) -----------
//
// ARCHITECTURE.md 11. The server holds only ciphertext and so cannot answer a
// single MCP query; it is a blind pipe and THIS TAB is the responder. Both
// directions between the Go shim (internal/mcpshim/frame.go) and here:
//
//   frame   = nonce(12) ‖ AES-GCM(pairingKey, payload, aad)
//   aad     = encodeFields("mp/v1/mcp", pairingId)
//   payload = one JSON-RPC MCP message, utf8-encoded
//
// pairingKey is the 32 bytes from the one-time pairing code. It is generated
// in the browser and never sent anywhere: the server mints only pairing_id,
// and the relay pipes opaque bytes. Binding pairingId into the AAD is what
// stops a frame minted for one pairing being replayed into another pairing's
// leg — that is a security property, not an edge case, and both suites test
// it.
//
// internal/mcpshim/testdata/mcp_frame_vectors.json pins this format and BOTH
// suites decrypt it. The Go shim and this responder are written at different
// times; a disagreement between them surfaces as "the connector silently
// drops every frame", which is close to unattributable from either side
// alone. The pinned vectors are what make it attributable.
//
// Frame size vs encodeFields' uint16 cap: the payload is NOT an encodeFields
// field, so a large MCP message only ever meets the relay's 64 KiB frame cap,
// never this one. The uint16 length prefix binds only the two AAD fields (the
// 9-byte label and pairingId), so the guard in encodeFields can be tripped
// only by an absurd pairing id — and then it throws on both sides rather than
// truncating mod 65536 into an AAD that silently disagrees with Go's.
const MCP_LABEL = 'mp/v1/mcp';

export async function sealMCPFrame(pairingKey, pairingId, payload) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesGcmEncrypt(pairingKey, nonce, payload, encodeFields(MCP_LABEL, pairingId));
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return packed;
}

// Throws (AEAD failure) on a tampered nonce/ciphertext/aad, the wrong pairing
// key, or a pairingId mismatch (cross-pairing replay).
export async function openMCPFrame(pairingKey, pairingId, frame) {
  return aesGcmDecrypt(pairingKey, frame.slice(0, 12), frame.slice(12), encodeFields(MCP_LABEL, pairingId));
}

// The one-time pairing code Settings shows and the user pastes into the shim:
//
//   "mpmcp1." ‖ base64url_unpadded(JSON({relay_url, pairing_id, key}))
//
// Parsed by internal/mcpshim's ParsePairingCode; the key field is standard
// padded base64, matching Go's encoding/json []byte marshaling, and the three
// JSON keys must stay in this order for the two encoders to agree byte for
// byte (the pinned vector asserts exactly that).
//
// Our own prefix, not medtracker's "mtmcp1.": a code pasted into the wrong
// app's shim must be rejected at the prefix rather than parse cleanly into a
// pairing that can never answer.
//
// There is deliberately no parse counterpart here. The browser mints codes and
// reads its pairing back from the vault record, never from a typed code, so a
// JS parser would be an unused attack surface for the one secret in the whole
// design that must never round-trip through anything but the user's clipboard.
export const PAIRING_CODE_PREFIX = 'mpmcp1.';

export function formatPairingCode({ relayUrl, pairingId, key }) {
  if (key.length !== 32) throw new RangeError(`pairing key must be 32 bytes, got ${key.length}`);
  const wire = { relay_url: relayUrl, pairing_id: pairingId, key: toBase64(key) };
  return PAIRING_CODE_PREFIX + toBase64Url(utf8(JSON.stringify(wire)));
}
