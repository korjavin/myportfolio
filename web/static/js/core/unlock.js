// Unlock (bead A4). Two paths, and the fast one has to be silent.
//
//   Warm — the LDK cache is present, so the DEK is unwrapped locally with no
//          ceremony at all. Zero taps, zero network.
//   Cold — a fresh browser profile, or cleared site data. ONE assertion.
//
// The cold path is the single real divergence from the sibling project
// (ARCHITECTURE.md 8.2). It is single origin, so there are no per-account
// subdomains and the client does not know its account id before the ceremony.
// The consequence is a discoverable-credential assertion: get() with EMPTY
// allowCredentials plus a top-level prf.eval, after which the server verifies
// the signature and answers with { account_id, envelope }. Only then can
// KEK = HKDF(prf, salt=account_id, info="mp/v1/kek" ‖ credential_id) be derived.
//
// Exactly one assertion. No second round trip to fetch the envelope, and no
// "which account?" prompt — the authenticator's own credential picker is the
// account picker.

import {
  saltKek,
  deriveKEK,
  unwrapEnvelope,
  fromBase64,
} from './crypto.js';
import { warmUnlock, establishLdkCache, clearLdkCache } from './ldk.js';

export function renderLocked(app, errorText) {
  app.innerHTML = `
    <section class="ceremony">
      <h1>Unlock myportfolio</h1>
      <p>Unlock this device with your passkey to open your vault.</p>
      <button id="unlock-button" type="button">Unlock with passkey</button>
    </section>`;
  showError(app, errorText);
  app.querySelector('#unlock-button').addEventListener('click', () => {
    const button = app.querySelector('#unlock-button');
    button.disabled = true;
    coldUnlock()
      .then(() => { location.href = '/'; })
      .catch((err) => renderLocked(app, err.message || String(err)));
  });
}

// The cold ceremony proper. Exported because it is also the re-authentication
// primitive: its success proves the user is physically present, and it hands
// back the DEK that a recovery-code rotation (A7) needs to re-wrap.
export async function coldUnlock() {
  const beginRes = await fetch('/api/webauthn/login/begin', { method: 'POST' });
  if (!beginRes.ok) throw new Error('Could not start unlock. Please try again.');
  const { publicKey } = await beginRes.json();
  const requestOptions = PublicKeyCredential.parseRequestOptionsFromJSON(publicKey);

  // Top-level prf.eval rather than evalByCredential: with no allowCredentials
  // there is no credential id to key the map by, so the salt has to apply to
  // whichever discoverable credential the authenticator offers.
  const salt = await saltKek();
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...requestOptions,
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } },
    },
  });

  const prfOutput = assertion.getClientExtensionResults().prf?.results?.first;
  if (!prfOutput) {
    throw new Error("This passkey didn't return the PRF output myportfolio needs to derive your key.");
  }

  const finishBody = assertion.toJSON();
  // Never transmit the PRF output. It is the root of the key hierarchy and it
  // is not part of what the server verifies.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = await fetch('/api/webauthn/login/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finishBody),
  });
  if (!finishRes.ok) throw new Error('Unlock failed. Please try again.');

  const { account_id: accountId, envelope } = await finishRes.json();
  const credentialId = new Uint8Array(assertion.rawId);
  const kek = await deriveKEK(new Uint8Array(prfOutput), accountId, credentialId);

  // A tampered envelope fails AEAD here and throws. That is deliberate: the
  // alternative — treating a decryption failure as "no data" — would present a
  // silently empty vault as though it were the user's real portfolio, and the
  // next sync would upload that emptiness over the top of the real one.
  const dek = await unwrapEnvelope({
    kek,
    envelope: { nonce: fromBase64(envelope.nonce), ct: fromBase64(envelope.ct) },
    accountId,
    credentialId,
  });

  try {
    await establishLdkCache(dek, accountId);
  } catch {
    // The warm cache is an optimization. A storage-blocked browser still
    // unlocked successfully; it just repeats this ceremony next launch.
  }
  return { accountId, dek, credentialId };
}

// The launch decision, shared by the ceremony page and (later) the app shell.
// Returns a context when the device is already unlocked, null when a passkey
// ceremony is needed.
//
// A cache that exists but fails to open is cleared and treated as cold, rather
// than surfaced — the recovery from a corrupted cache is exactly the cold path,
// and the user's data is untouched either way.
export async function tryWarmUnlock() {
  try {
    return await warmUnlock();
  } catch {
    await clearLdkCache().catch(() => {});
    return null;
  }
}

// Error text can carry a browser exception message, which is attacker-
// influenceable. textContent, never innerHTML — both ceremony screens hold the
// DEK in memory, so an XSS on either reads the vault key. Shared by signup.js
// so that decision lives in exactly one place.
export function showError(app, text) {
  if (!text) return;
  const p = document.createElement('p');
  p.className = 'ceremony-error';
  p.textContent = text;
  app.querySelector('section').appendChild(p);
}
