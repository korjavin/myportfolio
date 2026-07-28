// Passkey signup (bead A3): a new user creates an account with ONE passkey and
// walks away with a recovery code.
//
// Ceremony order, and every step of it is load-bearing:
//
//   1. register/begin  — the server mints an account id and returns it as the
//                        WebAuthn user handle. Nothing is persisted yet.
//   2. create()        — residentKey required (cold unlock needs a discoverable
//                        credential), userVerification required, prf requested.
//   3. get()           — an IMMEDIATE assertion on the credential just created,
//                        purely to obtain the PRF output. Never trust the
//                        `enabled` flag create() reports; the output from a
//                        real assertion is the only evidence PRF works.
//   4. register/finish — attestation + the wrapped DEK, stored in ONE server
//                        transaction so a passkey can never exist without the
//                        envelope that unwraps it.
//   5. Emergency Kit   — recovery envelope uploaded BEFORE the code is shown,
//                        then an explicit save gate, then straight into the app.
//
// The PRF output never leaves this file's scope. It is not in the finish body,
// not in a log, not in storage.

import {
  saltKek,
  generateDEK,
  deriveKEK,
  deriveKMac,
  wrapEnvelope,
  generateRecoveryCode,
  deriveKEKRec,
  deriveVerifier,
  toBase64,
} from './crypto.js';
import { establishLdkCache } from './ldk.js';
// showError lives in unlock.js so the "render untrusted text with textContent,
// never innerHTML" decision exists in exactly one place. Both ceremony screens
// hold the DEK in memory, so an XSS on either one reads the vault key.
import { showError } from './unlock.js';

// Only ever one passkey per device is offered. A second platform passkey on the
// SAME device can silently replace the first inside the authenticator, which
// would strand the envelope that first credential's KEK wraps. Adding a second
// DEVICE is a different ceremony (bead A7).
const UNSUPPORTED_MESSAGE =
  "This passkey doesn't support PRF, the feature myportfolio uses to derive your " +
  'encryption key. Try a hardware security key (e.g. a YubiKey), or a different ' +
  'browser or device.';

export function renderWelcome(app, errorText) {
  app.innerHTML = `
    <section class="ceremony">
      <h1>Create your vault</h1>
      <p>Your portfolio is encrypted on this device. The server only ever holds
         a blob it cannot read.</p>
      <p>You will need a passkey (Face ID, Touch ID, Windows Hello, or a
         security key) and somewhere safe to keep a recovery code.</p>
      <button id="create-passkey" type="button">Create your passkey</button>
    </section>`;
  showError(app, errorText);
  app.querySelector('#create-passkey').addEventListener('click', () => {
    const button = app.querySelector('#create-passkey');
    button.disabled = true;
    startRegistration(app).catch((err) => renderWelcome(app, err.message || String(err)));
  });
}

async function startRegistration(app) {
  const beginRes = await fetch('/api/webauthn/register/begin', { method: 'POST' });
  if (!beginRes.ok) throw new Error('Could not start passkey registration. Please try again.');
  const { publicKey } = await beginRes.json();
  const creationOptions = PublicKeyCredential.parseCreationOptionsFromJSON(publicKey);

  // The account id is server-minted but already present in the begin options,
  // so the KEK can be derived and the DEK wrapped BEFORE finish — which is what
  // lets finish persist account + credential + envelope atomically.
  const accountId = new TextDecoder().decode(creationOptions.user.id);

  const credential = await navigator.credentials.create({ publicKey: creationOptions });
  const credentialId = new Uint8Array(credential.rawId);

  const prfOutput = await evaluatePrf(credentialId);
  if (!prfOutput) {
    // Abort BEFORE finish. No account, no credential, no envelope exists
    // server-side, so nothing has to be undone — an account with one non-PRF
    // credential must never come into existence, because it could never be
    // unlocked. Best-effort tell the credential manager to forget the orphan
    // it just created; not every browser implements this yet.
    await forgetCredential(credentialId).catch(() => {});
    renderUnsupportedAuthenticator(app);
    return;
  }

  const dek = generateDEK();
  const kek = await deriveKEK(prfOutput, accountId, credentialId);
  const kMac = await deriveKMac(dek);
  const envelope = await wrapEnvelope({ kek, dek, kMac, accountId, credentialId });

  const finishBody = credential.toJSON();
  // Never transmit the PRF output. It is key material and it is client-only.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = await fetch('/api/webauthn/register/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: finishBody, envelope: envelopeToWire(envelope) }),
  });
  if (!finishRes.ok) throw new Error('Passkey registration failed. Please try again.');

  await renderEmergencyKit(app, { accountId, dek });
}

// An immediate assertion on the credential just created, for the sole purpose
// of learning whether PRF actually produces an output. Returns null when it
// does not.
//
// This is a capability probe by feature detection, never by sniffing browser
// or authenticator versions — a version allowlist is wrong the day after it is
// written, in both directions.
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

function forgetCredential(credentialId) {
  if (typeof PublicKeyCredential?.signalUnknownCredential !== 'function') return Promise.resolve();
  return PublicKeyCredential.signalUnknownCredential({
    rpId: location.hostname,
    credentialId: base64UrlFromBytes(credentialId),
  });
}

function base64UrlFromBytes(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function renderUnsupportedAuthenticator(app) {
  app.innerHTML = `
    <section class="ceremony">
      <h1>This passkey can't be used</h1>
      <p id="unsupported-detail"></p>
      <p>Nothing was created — your data is untouched and you can try again with
         a different authenticator.</p>
      <button id="try-again" type="button">Try again</button>
    </section>`;
  app.querySelector('#unsupported-detail').textContent = UNSUPPORTED_MESSAGE;
  app.querySelector('#try-again').addEventListener('click', () => renderWelcome(app));
}

// The Emergency Kit. Exported because A7's "regenerate recovery code" is the
// same ceremony with a different tail, and a second copy of a flow that decides
// whether an account is recoverable is not a thing to have.
//
// The recovery material is uploaded BEFORE the code is rendered, so a failed
// upload leaves the previous material untouched and the user is never shown a
// code that would not work.
export async function renderEmergencyKit(app, ctx) {
  const { codeBytes, formatted } = await generateRecoveryCode();
  const kekRec = await deriveKEKRec(codeBytes, ctx.accountId);
  const verifier = await deriveVerifier(codeBytes, ctx.accountId);
  const kMac = await deriveKMac(ctx.dek);
  const envelopeRec = await wrapEnvelope({
    kek: kekRec, dek: ctx.dek, kMac, accountId: ctx.accountId, credentialId: 'recovery',
  });

  const res = await fetch('/api/recovery-material', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope: envelopeToWire(envelopeRec), verifier: toBase64(verifier) }),
  });
  if (!res.ok) throw new Error('Could not save your recovery material. Please try again.');

  const kitUrl = location.origin;
  const kitDoc = buildKitDocument({ kitUrl, accountId: ctx.accountId, formatted });

  app.innerHTML = `
    <section class="ceremony kit">
      <h1>Your Emergency Kit</h1>
      <p>This is the only way back into your vault if you lose your passkey.
         There is no password reset and we cannot recover it for you. Save or
         print it now — it is not shown again.</p>
      <dl>
        <dt>Address</dt><dd id="kit-url"></dd>
        <dt>Account ID</dt><dd id="kit-account-id"></dd>
        <dt>Recovery code</dt><dd id="kit-code" class="recovery-code"></dd>
      </dl>
      <div class="kit-actions">
        <button id="kit-download" type="button">Download Emergency Kit</button>
        <button id="kit-print" type="button" class="secondary">Print it instead</button>
      </div>
      <label class="ceremony-ack">
        <input type="checkbox" id="kit-saved" disabled>
        I saved my Emergency Kit.
      </label>
      <p id="kit-hint">Download or print the kit to continue.</p>
      <button id="kit-continue" type="button" disabled>Open myportfolio</button>
    </section>`;

  // textContent, never innerHTML: the recovery code and the server-supplied
  // account id must not be able to become markup on the one page that holds
  // the DEK in memory.
  app.querySelector('#kit-url').textContent = kitUrl;
  app.querySelector('#kit-account-id').textContent = ctx.accountId;
  app.querySelector('#kit-code').textContent = formatted;

  const checkbox = app.querySelector('#kit-saved');
  const button = app.querySelector('#kit-continue');
  const hint = app.querySelector('#kit-hint');

  // Two gates on purpose. Producing a file (or printing) is the one that
  // actually saves the account; the checkbox is a second line of defence but
  // must never be the only one, because ticking a box has never saved a vault.
  let kitProduced = false;
  const sync = () => {
    checkbox.disabled = !kitProduced;
    button.disabled = !(kitProduced && checkbox.checked);
  };
  const markProduced = () => {
    kitProduced = true;
    // The download or print IS the confirmation, so tick the attestation the
    // user just earned. Honest: this only ever fires after a real save action.
    checkbox.checked = true;
    hint.textContent = 'Kit saved.';
    sync();
  };

  checkbox.addEventListener('change', sync);
  app.querySelector('#kit-download').addEventListener('click', () => {
    // In-app browsers and some privacy modes refuse Blob downloads. Fall
    // through to print rather than leaving the user behind a gate that cannot
    // be opened.
    if (!downloadKit(kitDoc, ctx.accountId)) printKit(kitDoc);
    markProduced();
  });
  app.querySelector('#kit-print').addEventListener('click', () => {
    printKit(kitDoc);
    markProduced();
  });

  button.addEventListener('click', () => {
    button.disabled = true;
    enterApp(ctx).catch((err) => {
      button.disabled = false;
      showError(app, err.message || String(err));
    });
  });
}

// The last step of signup is the app itself, not a congratulations screen.
//
// The warm cache is written HERE and nowhere earlier. If it were written right
// after registration, a user who closed the tab on the Emergency Kit screen
// would reload straight into an unlocked vault with no recovery code — holding
// data they cannot recover and never having been told.
async function enterApp(ctx) {
  try {
    await establishLdkCache(ctx.dek, ctx.accountId);
  } catch {
    // Storage-blocked browsers (private mode, quota policy) still get into the
    // app; they simply do a passkey unlock on the next launch instead of a
    // silent one.
  }
  location.href = '/';
}

export function envelopeToWire(envelope) {
  return {
    v: envelope.v,
    nonce: toBase64(envelope.nonce),
    ct: toBase64(envelope.ct),
    mac: toBase64(envelope.mac),
  };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A standalone document, because it has to survive being opened out of the
// Downloads folder years later with no network and no stylesheet: inline CSS,
// no external reference of any kind, and the same bytes are both savable and
// printable.
export function buildKitDocument({ kitUrl, accountId, formatted }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>myportfolio Emergency Kit — ${escapeHtml(accountId)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
         max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; }
  dt { font-weight: 600; margin-top: 1rem; }
  dd { margin: 0.25rem 0 0; }
  .code { font-family: ui-monospace, monospace; font-size: 1.25rem;
          letter-spacing: 0.08em; word-break: break-all; }
  .warn { border: 1px solid #111; padding: 0.75rem 1rem; margin: 1.5rem 0; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>myportfolio — Emergency Kit</h1>
<p class="warn"><strong>This is the only way back into your vault if you lose
your passkey.</strong> Anyone holding this page can open your portfolio. Keep it
on paper, or somewhere offline only you can reach. It is stored nowhere else —
not even on the server.</p>
<dl>
  <dt>Address</dt><dd>${escapeHtml(kitUrl)}</dd>
  <dt>Account ID</dt><dd class="code">${escapeHtml(accountId)}</dd>
  <dt>Recovery code</dt><dd class="code">${escapeHtml(formatted)}</dd>
</dl>
<p>To use it: open the address above, choose &ldquo;Recover account&rdquo;, and
enter the recovery code. You will be issued a new code afterwards, which makes
this page worthless — replace it when that happens.</p>
</body>
</html>`;
}

// Returns false when the browser refuses the download, so the caller can fall
// back to print. The recovery code lives in the Blob's CONTENTS; a blob: URL is
// an opaque UUID, so the code never lands in a URL, a request, or a log.
function downloadKit(docHtml, accountId) {
  try {
    const url = URL.createObjectURL(new Blob([docHtml], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `myportfolio-emergency-kit-${accountId}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred: revoking synchronously cancels the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch {
    return false;
  }
}

// An offscreen iframe rather than window.print(), so what prints is the kit
// document itself — identical to the downloaded file — and not the app chrome.
function printKit(docHtml) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;';
  frame.srcdoc = docHtml;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      // Nothing useful to say to the user here; the download path remains.
    }
  });
  document.body.appendChild(frame);
}
