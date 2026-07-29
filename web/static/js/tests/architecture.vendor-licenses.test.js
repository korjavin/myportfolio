// Every third-party file we redistribute must ship its license next to it.
//
// This is not paperwork: Apache-2.0 §4 and SIL OFL both require the license to
// accompany redistribution, and everything under web/static/ is compiled into
// the binary by //go:embed, so a build IS a redistribution. The minified Dexie
// bundle has had its own header stripped by minification, so without the file
// beside it the shipped artifact carries no notice at all.
//
// The manifest below is the enforcement. Adding a vendored asset without
// registering it here fails the suite — which is the point, because the failure
// mode otherwise is silent and only surfaces as a licence complaint later.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', '..'); // web/

// dir -> { asset filename -> license filename in the same dir }
const VENDORED = {
  'static/vendor': {
    'dexie.min.js': 'DEXIE-LICENSE.txt', // Dexie.js 3.2.7, Apache-2.0
  },
  'static/fonts': {
    'jetbrains-mono-latin.woff2': 'OFL-JetBrainsMono.txt',
    'jetbrains-mono-latin-ext.woff2': 'OFL-JetBrainsMono.txt',
    'space-grotesk-latin.woff2': 'OFL-SpaceGrotesk.txt',
    'space-grotesk-latin-ext.woff2': 'OFL-SpaceGrotesk.txt',
  },
  // Source tree only — not embedded — but still redistributed with the repo.
  'domain/fixtures': {
    'Issue4446FIFOMultipleTransfers.xml': 'EPL-1.0.txt',
    'Issue4446FIFOTransferWithSameDayPurchase.xml': 'EPL-1.0.txt',
    'client69.xml': 'EPL-1.0.txt',
    'client_with_id_references.xml': 'EPL-1.0.txt',
  },
};

// A license file is itself a license file, not an asset needing one.
const isLicenseFile = (name) => /^(.*LICENSE.*|OFL.*|EPL.*|COPYING.*)$/i.test(name);

describe('Architecture – vendored third-party licenses', () => {
  for (const [dir, manifest] of Object.entries(VENDORED)) {
    const abs = join(webRoot, dir);

    test(`${dir}: every asset is registered with a license`, () => {
      const present = readdirSync(abs).filter((f) => !isLicenseFile(f));
      const unregistered = present.filter((f) => !(f in manifest));
      assert.deepEqual(
        unregistered,
        [],
        `unregistered third-party file(s) in ${dir}. Add them to VENDORED in this test ` +
          `with the license file that covers them, and vendor that license text if it is not ` +
          `already there. Redistributing a file without its license is the failure this guards.`,
      );
    });

    test(`${dir}: every referenced license text actually exists`, () => {
      for (const [asset, license] of Object.entries(manifest)) {
        assert.ok(
          existsSync(join(abs, license)),
          `${dir}/${asset} is registered under ${license}, but that file is missing`,
        );
      }
    });

    test(`${dir}: every registered asset is actually present`, () => {
      // Catches the reverse drift: an asset removed from disk but left in the
      // manifest, which would let a later re-add sail through unregistered.
      for (const asset of Object.keys(manifest)) {
        assert.ok(existsSync(join(abs, asset)), `${dir}/${asset} is registered but not on disk`);
      }
    });
  }
});
