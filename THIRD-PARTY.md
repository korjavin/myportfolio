# Third-party components

myportfolio itself is MIT licensed (see [LICENSE](LICENSE)). It vendors and redistributes the
components below — they ship inside the built binary via `//go:embed`, so their terms apply to
anyone distributing a build.

| Component | Version | License | Upstream |
|---|---|---|---|
| Dexie.js (`web/static/vendor/dexie.min.js`) | see upstream | Apache-2.0 | https://github.com/dexie/Dexie.js |
| JetBrains Mono (`web/static/fonts/jetbrains-mono-*.woff2`) | — | SIL OFL 1.1 | https://github.com/JetBrains/JetBrainsMono |
| Space Grotesk (`web/static/fonts/space-grotesk-*.woff2`) | — | SIL OFL 1.1 | https://github.com/floriankarsten/space-grotesk |

## Test fixtures (source tree only, not redistributed in the binary)

`web/domain/fixtures/*.xml` are copied byte-for-byte from Portfolio Performance's own test
resources, **EPL-1.0**, © the Portfolio Performance contributors —
https://github.com/portfolio-performance/portfolio, `name.abuchen.portfolio.tests/src/`, master @
`729a58e08ce3f8bc898ce39256499bbca406c07c`:

| File | Upstream path | PP file version |
|---|---|---|
| `Issue4446FIFOMultipleTransfers.xml` | `issues/` | 66 |
| `Issue4446FIFOTransferWithSameDayPurchase.xml` | `issues/` | 66 |
| `client69.xml` | `fileversions/` | 69 (current) |
| `client_with_id_references.xml` | `fileversions/` | 63 |

They are the corpus `web/domain/ppimport.test.js` verifies the importer against — real PP serializer
output rather than files written from our own reading of the format, which is the only way to know
the importer parses the format and not our assumptions about it.

Two things worth stating plainly:

- **They contain no real portfolio.** They are PP's synthetic regression files: accounts named
  "Konto" and "Depot 1".."Depot 4", one or two well-known listed securities, invented amounts. No
  personal holdings, names or account numbers, which matters because this repo is public.
- **They are not embedded in the binary.** `web/embed.go` embeds `web/static` only, so these files
  exist in the source tree and are redistributed with the repository, not with a build. EPL-1.0 §3
  attribution for them is this section.

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
