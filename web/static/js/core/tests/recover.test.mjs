// Recovery (A16, Path C) — the client half.
//
// The load-bearing property here is a HANDSHAKE ACROSS TIME: signup mints an
// Emergency Kit and the user files it away; months later, on a different
// device, recovery has to open it. The two halves live in different files and
// never run in the same session, so nothing at runtime ever tells you they
// disagree — a mismatched AAD, a base64 slip, or a different `credentialId`
// literal ships a kit that is worthless exactly when it is needed, and the
// Go tests cannot see it because the server holds only ciphertext.
//
// So this drives the real mint from signup.js through the real wire encoding
// and back out through recover.js's derivations.
//
// .mjs because it is ESM regardless of what package.json is in scope, matching
// the crypto tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

// Node 18 keeps globalThis.crypto behind a flag; the browser always has it.
// Install it rather than teaching the modules under test about Node.
globalThis.crypto ??= nodeCrypto.webcrypto;

const { mintRecoveryMaterial } = await import('../signup.js');
const { normalizeAccountId } = await import('../recover.js');
const {
  parseRecoveryCode, deriveKEKRec, deriveVerifier, unwrapEnvelope, fromBase64, toBase64,
} = await import('../crypto.js');

const ACCOUNT_ID = '7Z2K4Q9BXR3MN0VT';

// Exactly what recover.js does with the kit's two typed fields and the
// envelope the server hands back.
async function redeem({ accountId, code, envelope }) {
  const codeBytes = await parseRecoveryCode(code);
  const kekRec = await deriveKEKRec(codeBytes, accountId);
  const verifier = await deriveVerifier(codeBytes, accountId);
  const dek = await unwrapEnvelope({
    kek: kekRec,
    envelope: { nonce: fromBase64(envelope.nonce), ct: fromBase64(envelope.ct) },
    accountId,
    credentialId: 'recovery',
  });
  return { dek, verifier };
}

describe('recovery — the Emergency Kit round trip', () => {
  it('a code minted at signup unwraps the same DEK at recovery', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const { formatted, material } = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });

    const { dek: recovered } = await redeem({
      accountId: ACCOUNT_ID, code: formatted, envelope: material.envelope,
    });
    assert.deepEqual(Array.from(recovered), Array.from(dek));
  });

  it('the verifier the client sends is the one signup registered', async () => {
    // The server compares SHA-256 of these two. If mint and redeem derived the
    // verifier differently, every kit would authenticate as a wrong code — and
    // the only symptom would be users who cannot recover.
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const { formatted, material } = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });
    const { verifier } = await redeem({ accountId: ACCOUNT_ID, code: formatted, envelope: material.envelope });
    assert.equal(toBase64(verifier), material.verifier);
  });

  it('survives the transcription the printed kit invites', async () => {
    // Lowercase, spaces instead of dashes, and the O/1/L typos Crockford
    // exists to absorb. A kit is read off paper, so these are the normal case.
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const { formatted, material } = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });
    const typed = formatted.toLowerCase().replace(/-/g, ' ');

    const { dek: recovered } = await redeem({
      accountId: ACCOUNT_ID, code: typed, envelope: material.envelope,
    });
    assert.deepEqual(Array.from(recovered), Array.from(dek));
  });

  it('a wrong account id fails AEAD rather than opening someone else\'s envelope', async () => {
    // account_id is bound into the envelope's AAD, so it is not merely a
    // lookup key: a code that is right for one account cannot open another's.
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const { formatted, material } = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });

    await assert.rejects(redeem({
      accountId: 'ZZZZZZZZZZZZZZZZ', code: formatted, envelope: material.envelope,
    }));
  });

  it('a rotated kit does not open with the burned code', async () => {
    // The forced rotation, from the client's side: after recovery the account
    // holds a NEW envelope_rec, and the code the user typed into a machine no
    // longer opens it.
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const burned = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });
    const rotated = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });

    assert.notEqual(rotated.formatted, burned.formatted);
    assert.notEqual(rotated.material.verifier, burned.material.verifier);
    await assert.rejects(redeem({
      accountId: ACCOUNT_ID, code: burned.formatted, envelope: rotated.material.envelope,
    }));
    // ...and the replacement opens the same vault, so rotation is not a reset.
    const { dek: recovered } = await redeem({
      accountId: ACCOUNT_ID, code: rotated.formatted, envelope: rotated.material.envelope,
    });
    assert.deepEqual(Array.from(recovered), Array.from(dek));
  });
});

describe('recovery — typing the Account ID off paper', () => {
  it('normalises the characters Crockford base32 does not mint', () => {
    // The id is minted from an alphabet with no I, L, O or U, so those can only
    // ever be transcription errors — and the id is the HKDF salt for BOTH
    // derivations, so an uncorrected one fails as "wrong code" with no way for
    // the user to tell what they got wrong.
    assert.equal(normalizeAccountId('7z2k4q9bxr3mn0vt'), ACCOUNT_ID);
    assert.equal(normalizeAccountId('7Z2K-4Q9B-XR3M-N0VT'), ACCOUNT_ID);
    assert.equal(normalizeAccountId('  7Z2K 4Q9B XR3M NOVT  '), ACCOUNT_ID);
    assert.equal(normalizeAccountId('7Z2K4Q9BXR3MN0VT'), ACCOUNT_ID);
    // I and L both stand in for 1, per the same table crypto.js's base32Decode
    // uses for the code itself.
    assert.equal(normalizeAccountId('1abc'), '1ABC');
    assert.equal(normalizeAccountId('Iabc'), '1ABC');
    assert.equal(normalizeAccountId('labc'), '1ABC');
    assert.equal(normalizeAccountId(''), '');
  });
});

describe('recovery — the code never leaves the client', () => {
  it('mintRecoveryMaterial returns nothing derived-reversibly from the code', async () => {
    // What crosses the wire is the envelope and the verifier. Neither may be
    // the code, and the code is 20 bytes of entropy that would be trivially
    // recognisable if it leaked into either.
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const { formatted, material } = await mintRecoveryMaterial({ accountId: ACCOUNT_ID, dek });
    const codeBytes = await parseRecoveryCode(formatted);
    const onTheWire = JSON.stringify(material);

    assert.ok(!onTheWire.includes(formatted.replace(/-/g, '')));
    assert.ok(!onTheWire.includes(toBase64(codeBytes)));
    assert.deepEqual(Object.keys(material).sort(), ['envelope', 'verifier']);
  });
});
