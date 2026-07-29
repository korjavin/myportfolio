// Every asset a shipped page references must actually exist in the embedded tree.
//
// web/embed.go roots the served filesystem at web/static, so an asset stored at
// web/static/css/styles.css is served from /css/styles.css — NOT
// /static/css/styles.css. Two files have already shipped with the /static
// prefix, and both failed silently rather than loudly:
//
//   - fonts.css asked for /static/fonts/... and every glyph 404'd, but
//     `font-display: swap` kept the fallback, so the app looked fine while
//     shipping none of its own typography.
//   - design.html asked for /static/css/... and rendered completely unstyled
//     from the day it landed.
//
// Two independent authors made the same mistake, which makes it a documentation
// defect rather than carelessness — and neither failure was visible at runtime,
// which is why it needs a test rather than a code review.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

// href="/x", src="/x", and url(/x) — the three ways a page names an asset.
const REF = /(?:\b(?:href|src)\s*=\s*|url\(\s*)['"]?(\/[^"')\s>]+)/g;

function refsIn(file) {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(REF)]
    .map((m) => m[1].split(/[?#]/)[0]) // drop cache-busting query and fragment
    .filter((p) => !p.startsWith('//')); // protocol-relative is an external host
}

describe('Architecture – asset paths resolve in the embedded tree', () => {
  const pages = walk(staticRoot).filter((f) => /\.(html|css)$/.test(f));

  test('there are pages to check', () => {
    // Guards the guard: a bad glob here would make every assertion below vacuous.
    assert.ok(pages.length > 0, 'found no .html/.css under web/static');
  });

  for (const page of pages) {
    const rel = page.slice(staticRoot.length + 1);

    test(`${rel}: every referenced asset exists`, () => {
      for (const ref of refsIn(page)) {
        const target = join(staticRoot, ref);
        assert.ok(
          existsSync(target) && statSync(target).isFile(),
          `${rel} references ${ref}, which is not a file in the embedded tree. ` +
            `embed.go roots the FS at web/static, so drop any leading /static — ` +
            `web/static/css/styles.css is served from /css/styles.css.`,
        );
      }
    });

    test(`${rel}: no /static/ prefix`, () => {
      // Called out separately from the existence check because this is the
      // specific mistake, and the message should say so rather than making the
      // next author rediscover why their path 404'd.
      const bad = refsIn(page).filter((p) => p.startsWith('/static/'));
      assert.deepEqual(bad, [], `${rel} uses the /static/ prefix; embed.go already roots the FS there`);
    });
  }
});
