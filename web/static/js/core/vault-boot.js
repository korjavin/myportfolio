// Entry point for /vault.html — the one page that runs the passkey ceremonies.
//
// It makes a single decision: if this device already holds a warm LDK cache the
// vault is unlocked, so go straight to the app. Otherwise offer the two things
// a locked device can do — unlock an existing vault, or create a new one.
//
// Deliberately NOT a router or a wizard state machine. Each screen is rendered
// from the outcome of the previous step, so a reload always lands somewhere
// coherent rather than resuming a half-remembered step counter.

import { tryWarmUnlock, renderLocked } from './unlock.js';
import { renderWelcome } from './signup.js';

const app = document.getElementById('app');

function renderChooser() {
  app.innerHTML = `
    <section class="ceremony">
      <h1>myportfolio</h1>
      <p>Your portfolio is encrypted on your device. The server stores a blob it
         cannot read.</p>
      <button id="unlock" type="button">Unlock with your passkey</button>
      <button id="signup" type="button" class="secondary">Create a new vault</button>
      <button id="recover" type="button" class="secondary">Recover with your Emergency Kit</button>
    </section>`;
  app.querySelector('#unlock').addEventListener('click', () => renderLocked(app));
  app.querySelector('#signup').addEventListener('click', () => renderWelcome(app));
  // The kit tells the user to "choose Recover account" here. Without this the
  // 160-bit code signup prints has nowhere to be typed, which is the whole
  // defect A16 exists to fix — do not quietly drop it in a redesign.
  app.querySelector('#recover').addEventListener('click', () => { location.href = '/recover.html'; });
}

// A browser without WebAuthn or without SubtleCrypto cannot participate at all,
// and finding that out three taps into a ceremony is worse than being told now.
function unsupportedEnvironment() {
  if (!globalThis.PublicKeyCredential) return 'This browser has no passkey support.';
  if (!globalThis.crypto?.subtle) {
    return 'This page needs WebCrypto, which browsers only provide over HTTPS or on localhost.';
  }
  return null;
}

async function boot() {
  const blocker = unsupportedEnvironment();
  if (blocker) {
    app.innerHTML = '<section class="ceremony"><h1>Unsupported browser</h1><p id="why"></p></section>';
    app.querySelector('#why').textContent = blocker;
    return;
  }
  const warm = await tryWarmUnlock();
  if (warm) {
    location.href = '/';
    return;
  }
  renderChooser();
}

boot();
