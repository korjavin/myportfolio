// Recovery (bead A16, Path C): the only way back into a vault whose passkeys
// are all gone. Signup prints a 160-bit code and makes the user tick "I saved
// it"; this is the half that makes that promise true.
//
// The ceremony, and every step is load-bearing:
//
//   1. The user types the Account ID and recovery code off their Emergency Kit.
//      parseRecoveryCode validates the checksum group OFFLINE, so a typo is
//      caught here and never spends a rate-limited server attempt.
//   2. deriveVerifier -> POST /api/recover. The CODE never leaves this file;
//      only the verifier does, and the server stores only its hash.
//   3. deriveKEKRec unwraps the returned envelope_rec into the DEK. If the
//      account id or code were wrong for this envelope, AEAD fails here.
//   4. A new passkey is created and IMMEDIATELY asserted to prove PRF works.
//      No PRF output => the credential is deleted and finish is never called,
//      so the account never acquires a credential it cannot unlock with.
//   5. The finish request carries the new passkey's envelope AND a freshly
//      minted Emergency Kit. The server commits both in one transaction, which
//      is what burns the code that was just typed into a machine. Rotation is
//      not a prompt the user can decline — it has already happened by the time
//      the kit screen renders.
//
// Deliberately absent: transfer slots, QR hand-off, the device list. Those are
// bead 18h.7 and this page must not grow them.

import {
  parseRecoveryCode,
  deriveKEKRec,
  deriveVerifier,
  unwrapEnvelope,
  deriveKEK,
  deriveKMac,
  wrapEnvelope,
  saltKek,
  fromBase64,
  toBase64,
} from './crypto.js';
import {
  envelopeToWire,
  mintRecoveryMaterial,
  renderKitScreen,
  renderUnsupportedAuthenticator,
  forgetCredential,
  enterApp,
} from './signup.js';
import { showError } from './unlock.js';

export function renderRecoverForm(app, errorText) {
  app.innerHTML = `
    <section class="ceremony">
      <h1>Recover your vault</h1>
      <p>Enter the Account ID and recovery code from your Emergency Kit. You
         will set up a new passkey on this device and receive a replacement
         code — the one you are typing now stops working.</p>
      <label class="ceremony-field">
        Account ID
        <input type="text" id="recover-account" autocomplete="off"
               autocapitalize="characters" spellcheck="false">
      </label>
      <label class="ceremony-field">
        Recovery code
        <input type="text" id="recover-code" autocomplete="off"
               autocapitalize="characters" spellcheck="false">
      </label>
      <button id="recover-submit" type="button">Recover my vault</button>
    </section>`;
  showError(app, errorText);
  app.querySelector('#recover-submit').addEventListener('click', () => {
    const button = app.querySelector('#recover-submit');
    button.disabled = true;
    const accountId = normalizeAccountId(app.querySelector('#recover-account').value);
    const code = app.querySelector('#recover-code').value.trim();
    if (!accountId || !code) {
      renderRecoverForm(app, 'Enter both the Account ID and the recovery code exactly as printed.');
      return;
    }
    redeem(app, accountId, code).catch((err) => renderRecoverForm(app, err.message || String(err)));
  });
}

// The account id is Crockford base32 minted server-side, so it never contains
// I, L, O or U — which means the transcription typos those characters cause can
// be corrected here rather than dead-ending a user who is holding a correct
// printed kit. The id is the HKDF salt for both derivations below, so an
// uncorrected typo would fail with "wrong code" and no way to tell.
export function normalizeAccountId(raw) {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function renderBusy(app, message) {
  app.innerHTML = '<section class="ceremony"><h1>Recover your vault</h1><p id="recover-status"></p></section>';
  app.querySelector('#recover-status').textContent = message;
}

async function redeem(app, accountId, code) {
  let codeBytes;
  try {
    codeBytes = await parseRecoveryCode(code);
  } catch {
    // The checksum group caught it offline. Say so without spending an attempt.
    throw new Error('That recovery code is not valid — check it against your Emergency Kit.');
  }

  renderBusy(app, 'Checking your recovery code…');

  const kekRec = await deriveKEKRec(codeBytes, accountId);
  const verifier = await deriveVerifier(codeBytes, accountId);

  const res = await fetch('/api/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, verifier: toBase64(verifier) }),
  });
  if (res.status === 429) {
    throw new Error('Too many recovery attempts. Wait an hour and try again.');
  }
  if (!res.ok) {
    // Identical text for a wrong code and an id that was never real — the
    // server refuses to distinguish them and neither does this.
    throw new Error('That Account ID and recovery code do not match.');
  }
  const { envelope, grant } = await res.json();

  let dek;
  try {
    dek = await unwrapEnvelope({
      kek: kekRec,
      envelope: { nonce: fromBase64(envelope.nonce), ct: fromBase64(envelope.ct) },
      accountId,
      credentialId: 'recovery',
    });
  } catch {
    throw new Error('Could not unlock your vault with that Account ID and code.');
  }

  await enroll(app, { accountId, dek, grant });
}

// Registers a fresh passkey into the recovered account and rotates the kit in
// the same request.
//
// A failure here surfaces through redeem's catch and lands back on the form,
// which is the right destination precisely BECAUSE nothing has been committed
// yet: finish is the only step that writes, so an abort leaves the old code
// still valid and retyping it is a real fix rather than a dead end.
async function enroll(app, ctx) {
  renderBusy(app, 'Setting up a passkey on this device…');

  const beginRes = await fetch('/api/recovery/enroll/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: ctx.grant }),
  });
  if (!beginRes.ok) {
    throw new Error('Recovery timed out. Start again with your Emergency Kit.');
  }
  const { publicKey } = await beginRes.json();
  const creationOptions = PublicKeyCredential.parseCreationOptionsFromJSON(publicKey);

  const credential = await navigator.credentials.create({ publicKey: creationOptions });
  const credentialId = new Uint8Array(credential.rawId);

  const prfOutput = await evaluatePrf(credentialId);
  if (!prfOutput) {
    // Abort BEFORE finish, exactly as signup does. Nothing is persisted, so the
    // account does not end up holding one PRF credential and one without — a
    // mixed account can never be unlocked by the second one, and the recovery
    // path is the easy place to forget that.
    await forgetCredential(credentialId).catch(() => {});
    renderUnsupportedAuthenticator(app);
    return;
  }

  const kek = await deriveKEK(prfOutput, ctx.accountId, credentialId);
  const kMac = await deriveKMac(ctx.dek);
  const envelope = await wrapEnvelope({ kek, dek: ctx.dek, kMac, accountId: ctx.accountId, credentialId });

  // The replacement kit is minted BEFORE finish and travels with it, so the
  // server can burn the old verifier in the same transaction that enrolls this
  // passkey. A rotation that were a second request could be abandoned, and the
  // user would walk away believing a live code was dead.
  const { formatted, material } = await mintRecoveryMaterial(ctx);

  const finishBody = credential.toJSON();
  // Never transmit the PRF output. It is the root of the key hierarchy.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = await fetch('/api/recovery/enroll/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential: finishBody,
      envelope: envelopeToWire(envelope),
      recovery: material,
    }),
  });
  if (!finishRes.ok) {
    await forgetCredential(credentialId).catch(() => {});
    throw new Error('Could not finish setting up your passkey. Please try again.');
  }

  // Only now is the old code dead and the new one the account's only key, so
  // this is the first moment it may be shown.
  renderKitScreen(app, {
    accountId: ctx.accountId,
    formatted,
    onContinue: () => enterApp({ accountId: ctx.accountId, dek: ctx.dek }),
  });
}

// An immediate assertion on the credential just created, for the sole purpose
// of learning whether PRF actually produces an output — feature detection, not
// a browser or authenticator allowlist. Identical to signup's probe, and it has
// to stay identical: this is the gate that keeps a PRF-less credential out.
async function evaluatePrf(credentialId) {
  const salt = await saltKek();
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const output = assertion.getClientExtensionResults().prf?.results?.first;
  return output ? new Uint8Array(output) : null;
}

// Entry point for /recover.html. Guarded the same way vault-boot.js is: a
// browser that cannot do WebAuthn or WebCrypto should be told now, not three
// steps into the one ceremony the user cannot retry cheaply.
function boot() {
  const app = document.getElementById('app');
  if (!globalThis.PublicKeyCredential || !globalThis.crypto?.subtle) {
    app.innerHTML = '<section class="ceremony"><h1>Unsupported browser</h1><p id="why"></p></section>';
    app.querySelector('#why').textContent =
      'Recovery needs passkey and WebCrypto support, which browsers only provide over HTTPS or on localhost.';
    return;
  }
  renderRecoverForm(app);
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();
