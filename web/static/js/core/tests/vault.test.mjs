// Ceremony tests for the pure, DOM-free parts of signup.js — run with
// `node --test`, no vitest and no npm dependencies.
//
// The DOM-driving and WebAuthn parts of signup.js/unlock.js cannot be checked
// here (they need a real authenticator); the Go side covers the wire contract
// end to end. What IS checkable without a browser is the part that would fail
// silently and permanently: the Emergency Kit document, which is the only copy
// of a recovery code that exists anywhere, and the envelope wire encoding the
// server decodes with encoding/json.
//
// The .mjs extension is deliberate: ESM regardless of package.json scope, same
// as crypto.test.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

globalThis.crypto ??= nodeCrypto.webcrypto;

const { buildKitDocument, escapeHtml, envelopeToWire } = await import('../signup.js');
const { generateRecoveryCode, parseRecoveryCode } = await import('../crypto.js');

describe('Emergency Kit document', () => {
  it('carries the address, account id and recovery code', () => {
    const doc = buildKitDocument({
      kitUrl: 'https://vault.example',
      accountId: 'ABCD1234EFGH5678',
      formatted: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789-WXYZ',
    });
    assert.match(doc, /https:\/\/vault\.example/);
    assert.match(doc, /ABCD1234EFGH5678/);
    assert.match(doc, /ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789-WXYZ/);
  });

  // The kit is opened as a local file, so a code injected through the account
  // id would execute with file: privileges years later, with no CSP in sight.
  it('escapes every interpolated value', () => {
    const doc = buildKitDocument({
      kitUrl: 'https://vault.example/"><script>alert(1)</script>',
      accountId: '<img src=x onerror=alert(2)>',
      formatted: "'--><svg onload=alert(3)>",
    });
    assert.ok(!doc.includes('<script>alert(1)'), 'kit url was not escaped');
    assert.ok(!doc.includes('<img src=x'), 'account id was not escaped');
    assert.ok(!doc.includes('<svg onload'), 'recovery code was not escaped');
    assert.match(doc, /&lt;script&gt;/);
  });

  it('references nothing external, so it still works offline in ten years', () => {
    const doc = buildKitDocument({ kitUrl: 'https://vault.example', accountId: 'A', formatted: 'B' });
    assert.ok(!/<script/i.test(doc), 'kit document contains a script');
    assert.ok(!/(src|href)\s*=\s*["']?https?:/i.test(doc), 'kit document loads something over the network');
  });

  // The code printed on the kit is the ONLY copy. If it does not parse back,
  // the account is unrecoverable and nobody finds out until it matters.
  it('prints a code that parses back to the same bytes', async () => {
    const { codeBytes, formatted } = await generateRecoveryCode();
    const doc = buildKitDocument({ kitUrl: 'https://vault.example', accountId: 'ACC', formatted });

    const printed = doc.match(/<dd class="code">([0-9A-Z-]+)<\/dd>\s*\n<\/dl>/)?.[1];
    assert.ok(printed, 'no recovery code found in the kit document');
    assert.equal(printed, formatted);
    assert.deepEqual(await parseRecoveryCode(printed), codeBytes);
  });
});

describe('escapeHtml', () => {
  it('escapes all five characters that can break out of markup or an attribute', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('envelopeToWire', () => {
  // Go decodes []byte fields from standard base64 WITH padding. base64url or
  // unpadded output would be rejected at the server, or worse, silently decode
  // to different bytes.
  it('encodes nonce/ct/mac as padded standard base64', () => {
    const wire = envelopeToWire({
      v: 1,
      nonce: new Uint8Array([0xfb, 0xff, 0x00]),
      ct: new Uint8Array([1, 2, 3, 4]),
      mac: new Uint8Array([255]),
    });
    assert.equal(wire.v, 1);
    assert.equal(wire.nonce, '+/8A');
    assert.equal(wire.ct, 'AQIDBA==');
    assert.equal(wire.mac, '/w==');
    for (const [field, encoded] of Object.entries(wire)) {
      if (field === 'v') continue;
      assert.ok(!/[-_]/.test(encoded), `${field} used base64url, which Go will not decode`);
    }
  });

  it('round-trips arbitrary bytes through a Go-compatible decode', () => {
    const bytes = nodeCrypto.randomBytes(97);
    const wire = envelopeToWire({ v: 1, nonce: bytes, ct: bytes, mac: bytes });
    assert.deepEqual(new Uint8Array(Buffer.from(wire.ct, 'base64')), new Uint8Array(bytes));
  });
});
