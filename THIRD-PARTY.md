# Third-party components

myportfolio itself is MIT licensed (see [LICENSE](LICENSE)). It vendors and redistributes the
components below — they ship inside the built binary via `//go:embed`, so their terms apply to
anyone distributing a build.

| Component | Version | License | Upstream |
|---|---|---|---|
| Dexie.js (`web/static/vendor/dexie.min.js`) | see upstream | Apache-2.0 | https://github.com/dexie/Dexie.js |
| JetBrains Mono (`web/static/fonts/jetbrains-mono-*.woff2`) | — | SIL OFL 1.1 | https://github.com/JetBrains/JetBrainsMono |
| Space Grotesk (`web/static/fonts/space-grotesk-*.woff2`) | — | SIL OFL 1.1 | https://github.com/floriankarsten/space-grotesk |

## Known compliance gap

**The full license texts are not yet vendored alongside these files.** Apache-2.0 §4 requires a copy
of the license to accompany redistribution, and the minified Dexie bundle has had its license header
stripped by minification, so nothing in the shipped artifact carries the notice. SIL OFL 1.1
likewise requires the license to travel with the font files.

This table is attribution, not compliance. Tracked as a bead; close it before any public release or
binary distribution.

## Derived work

The passkey/PRF vault design, the `--wg-*` design system, and several frontend primitives are ported
from [medicationtrackerbot](https://github.com/korjavin/medicationtrackerbot), MIT © 2026 Korjavin
Ivan — same author, same license. See `docs/ARCHITECTURE.md` §8 and §9 for exactly what was ported
and what was deliberately left behind.
