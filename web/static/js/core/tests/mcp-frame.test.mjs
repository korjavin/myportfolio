// mp/v1/mcp frame + pairing-code tests (bd myportfolio-ybp.1,
// ARCHITECTURE.md §11). Run with `node --test` from web/ — Node's built-in
// runner, no vitest and no npm dependencies.
//
// The point of this file is the SHARED vector: it reads
// internal/mcpshim/testdata/mcp_frame_vectors.json, the very file
// internal/mcpshim/mcpshim_test.go reads, and opens the frame Go sealed while
// pinning the frame this side sealed for Go to open. A JS-only suite would
// prove only that crypto.js agrees with itself, and the failure mode this
// bead exists to prevent — the shim and the responder disagreeing on the wire
// — is invisible to that.
//
// Three things are checked, and the difference matters:
//
//   * The pinned frames are decrypted, so a label/AAD/packing change here
//     fails instead of quietly making every frame undecryptable to Go.
//   * The same values are recomputed from node:crypto (createDecipheriv) and
//     a hand-written re-implementation of the uint16-BE field framing — an
//     INDEPENDENT implementation, so the pins are cross-checked rather than
//     merely self-consistent.
//   * The negatives: tampered nonce/ciphertext/AAD, and a frame sealed for
//     pairing A failing under pairing B. That last one is the security
//     property the AAD binding exists for, not an edge case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// Node 18 keeps globalThis.crypto behind --experimental-global-webcrypto; the
// browser always has it. No-op on Node >= 19.
globalThis.crypto ??= nodeCrypto.webcrypto;

const SOURCE = readFileSync(new URL('../crypto.js', import.meta.url), 'utf8');

// web/static/js/core/tests -> repo root is five levels up. The vectors live
// beside the Go implementation (and inside a testdata/ directory) on purpose:
// web/static is embedded into the server binary by web/embed.go, so a vector
// file there would be served to every visitor.
const VECTORS_URL = new URL('../../../../../internal/mcpshim/testdata/mcp_frame_vectors.json', import.meta.url);
const V = JSON.parse(readFileSync(VECTORS_URL, 'utf8'));

// Same data:-URL trick as crypto.test.mjs: crypto.js is an ES module with a
// .js extension, so load it as ESM unconditionally rather than depending on a
// package.json being in scope.
let C;
async function crypto_() {
  C ??= await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE));
  return C;
}

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const hex = (u8) => Buffer.from(u8).toString('hex');
const text = (u8) => Buffer.from(u8).toString('utf8');

const key = b64(V.pairing_key_b64);
const pairingId = V.pairing_id;

// --- independent re-implementations (node:crypto only) ---------------------

// uint16-BE length ‖ bytes per field, in argument order. Written out longhand
// so it cannot inherit a bug from crypto.js's encodeFields.
function fields(...parts) {
  const out = [];
  for (const p of parts) {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length, 0);
    out.push(len, b);
  }
  return Buffer.concat(out);
}

function gcmDecrypt(rawKey, nonce, ctWithTag, aad) {
  const ct = Buffer.from(ctWithTag);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(rawKey), Buffer.from(nonce));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

describe('mp/v1/mcp frames — pinned cross-implementation vectors', () => {
  it('opens the frame Go sealed', async () => {
    const { openMCPFrame } = await crypto_();
    const got = await openMCPFrame(key, pairingId, b64(V.frame_sealed_by_go_b64));
    assert.equal(text(got), V.go_payload);
  });

  it('opens the pinned frame this implementation sealed (the one Go opens)', async () => {
    const { openMCPFrame } = await crypto_();
    const got = await openMCPFrame(key, pairingId, b64(V.frame_sealed_by_js_b64));
    assert.equal(text(got), V.js_payload);
  });

  it('node:crypto opens both pinned frames with the hand-framed AAD', () => {
    const aad = fields('mp/v1/mcp', pairingId);
    assert.equal(aad.toString('hex'), V.aad_hex);
    for (const [frameB64, payload] of [
      [V.frame_sealed_by_go_b64, V.go_payload],
      [V.frame_sealed_by_js_b64, V.js_payload],
    ]) {
      const frame = b64(frameB64);
      assert.equal(gcmDecrypt(key, frame.slice(0, 12), frame.slice(12), aad).toString('utf8'), payload);
    }
  });

  it('frames the AAD as encodeFields("mp/v1/mcp", pairingId)', async () => {
    const { encodeFields } = await crypto_();
    assert.equal(hex(encodeFields('mp/v1/mcp', pairingId)), V.aad_hex);
    assert.equal(hex(encodeFields('mp/v1/mcp', V.other_pairing_id)), V.other_aad_hex);
  });

  it('does not open under medtracker’s mt/v1/mcp label', () => {
    // The label change is what stops a frame from the sibling app being
    // accepted here (ARCHITECTURE.md §8.1). Not covered by the positive
    // tests: a wrong label still decrypts nothing, it just fails silently in
    // production instead of in a test.
    const frame = b64(V.frame_sealed_by_go_b64);
    assert.throws(() => gcmDecrypt(key, frame.slice(0, 12), frame.slice(12), fields('mt/v1/mcp', pairingId)));
  });

  it('round-trips a fresh frame with a fresh nonce each time', async () => {
    const { sealMCPFrame, openMCPFrame } = await crypto_();
    const payload = new TextEncoder().encode('{"jsonrpc":"2.0","id":9,"method":"tools/list"}');
    const a = await sealMCPFrame(key, pairingId, payload);
    const b = await sealMCPFrame(key, pairingId, payload);
    assert.equal(a.length, 12 + payload.length + 16);
    assert.equal(text(await openMCPFrame(key, pairingId, a)), text(payload));
    assert.notEqual(hex(a), hex(b), 'two seals of the same payload are identical — the nonce is not fresh');
  });

  it('round-trips a payload filling the relay cap — that cap, not encodeFields, is the limit', async () => {
    // encodeFields' uint16 prefix binds only the AAD's two fields (the 9-byte
    // label and pairingId); the payload is not a field, so a frame sitting at
    // the relay's 64 KiB cap never approaches 65535. Pin that, because "the
    // two limits meet near the cap" is the intuition this test refutes.
    //
    // The cap is on the FRAME (the relay sets a websocket read limit), so the
    // largest payload that survives it is 65536 - 28, not 65536. Assert the
    // sealed length exactly: internal/mcpshim's FrameOverheadBytes carries the
    // same 28 for Go, and a responder that budgets a full 64 KiB payload would
    // drop precisely the largest answers.
    const { sealMCPFrame, openMCPFrame } = await crypto_();
    const RELAY_CAP = 64 * 1024;
    const OVERHEAD = 12 + 16; // nonce ‖ AES-GCM tag
    const big = new Uint8Array(RELAY_CAP - OVERHEAD).fill(0x70);
    const frame = await sealMCPFrame(key, pairingId, big);
    assert.equal(frame.length, RELAY_CAP);
    assert.equal((await openMCPFrame(key, pairingId, frame)).length, big.length);
  });

  it('throws rather than truncating when a field exceeds the uint16 prefix', async () => {
    // Go returns an error at exactly this boundary. Both sides must refuse: a
    // silent truncation mod 65536 on either side is an AAD that disagrees.
    const { encodeFields } = await crypto_();
    assert.throws(() => encodeFields('mp/v1/mcp', 'x'.repeat(0x10000)), RangeError);
    assert.doesNotThrow(() => encodeFields('mp/v1/mcp', 'x'.repeat(0xffff)));
  });
});

describe('mp/v1/mcp frames — negatives', () => {
  const tamper = (frameB64, mutate) => {
    const f = b64(frameB64);
    mutate(f);
    return f;
  };

  it('rejects a frame sealed for a different pairing', async () => {
    // THE security property: pairingId is bound into the AAD precisely so a
    // frame cannot be replayed into another pairing's leg.
    const { openMCPFrame } = await crypto_();
    for (const frameB64 of [V.frame_sealed_by_go_b64, V.frame_sealed_by_js_b64]) {
      await assert.rejects(openMCPFrame(key, V.other_pairing_id, b64(frameB64)));
    }
  });

  it('rejects a tampered nonce', async () => {
    const { openMCPFrame } = await crypto_();
    await assert.rejects(openMCPFrame(key, pairingId, tamper(V.frame_sealed_by_go_b64, (f) => (f[0] ^= 0xff))));
  });

  it('rejects a tampered ciphertext byte', async () => {
    const { openMCPFrame } = await crypto_();
    await assert.rejects(openMCPFrame(key, pairingId, tamper(V.frame_sealed_by_go_b64, (f) => (f[12] ^= 0xff))));
  });

  it('rejects a tampered authentication tag', async () => {
    const { openMCPFrame } = await crypto_();
    await assert.rejects(
      openMCPFrame(key, pairingId, tamper(V.frame_sealed_by_go_b64, (f) => (f[f.length - 1] ^= 0x01)))
    );
  });

  it('rejects a tampered AAD', async () => {
    const { openMCPFrame } = await crypto_();
    await assert.rejects(openMCPFrame(key, pairingId + 'x', b64(V.frame_sealed_by_go_b64)));
  });

  it('rejects the wrong pairing key', async () => {
    const { openMCPFrame } = await crypto_();
    const wrong = new Uint8Array(key);
    wrong[0] ^= 0xff;
    await assert.rejects(openMCPFrame(wrong, pairingId, b64(V.frame_sealed_by_go_b64)));
  });

  it('rejects a frame shorter than the nonce', async () => {
    const { openMCPFrame } = await crypto_();
    await assert.rejects(openMCPFrame(key, pairingId, b64(V.frame_sealed_by_go_b64).slice(0, 11)));
  });
});

describe('pairing code', () => {
  it('mints the byte-identical code Go’s ParsePairingCode reads', async () => {
    // The pinned code was produced by BOTH encoders from the same inputs. If
    // this side changes its JSON key order or base64 alphabet, the shim would
    // still parse the code but Go's own re-format assertion goes red — and
    // this one goes red here first.
    const { formatPairingCode } = await crypto_();
    assert.equal(formatPairingCode({ relayUrl: V.relay_url, pairingId, key }), V.pairing_code);
  });

  it('uses our prefix, not medtracker’s', async () => {
    const { PAIRING_CODE_PREFIX } = await crypto_();
    assert.equal(PAIRING_CODE_PREFIX, 'mpmcp1.');
    assert.ok(V.pairing_code.startsWith('mpmcp1.'));
    assert.ok(!V.pairing_code.startsWith('mtmcp1.'));
  });

  it('carries exactly {relay_url, pairing_id, key} and nothing else', async () => {
    // The pairing key never touches the server; the code is the only thing
    // that carries it and it goes browser -> clipboard -> shim. A field added
    // here would be a field that could carry it somewhere else, so pin the
    // shape rather than trusting review to notice.
    const { formatPairingCode } = await crypto_();
    const body = formatPairingCode({ relayUrl: V.relay_url, pairingId, key }).slice('mpmcp1.'.length);
    const wire = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    assert.deepEqual(Object.keys(wire), ['relay_url', 'pairing_id', 'key']);
    assert.equal(wire.key, Buffer.from(key).toString('base64'));
  });

  it('refuses a key that is not 32 bytes', async () => {
    const { formatPairingCode } = await crypto_();
    assert.throws(
      () => formatPairingCode({ relayUrl: V.relay_url, pairingId, key: new Uint8Array(16) }),
      RangeError
    );
  });

  it('exposes no pairing-code parser', async () => {
    // Deliberate: the browser mints codes and reads its pairing back from the
    // vault record, never from a typed code. Parsing lives only in the shim.
    const c = await crypto_();
    assert.equal(c.parsePairingCode, undefined);
  });
});
