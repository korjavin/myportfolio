# Third-party components

myportfolio itself is MIT licensed (see [LICENSE](LICENSE)). It vendors and redistributes the
components below — they ship inside the built binary via `//go:embed`, so their terms apply to
anyone distributing a build.

| Component | Version | License | License text | Upstream |
|---|---|---|---|---|
| Dexie.js (`web/static/vendor/dexie.min.js`) | 3.2.7 | Apache-2.0 | `web/static/vendor/DEXIE-LICENSE.txt` | https://github.com/dexie/Dexie.js |
| JetBrains Mono (`web/static/fonts/jetbrains-mono-*.woff2`) | — | SIL OFL 1.1 | `web/static/fonts/OFL-JetBrainsMono.txt` | https://github.com/JetBrains/JetBrainsMono |
| Space Grotesk (`web/static/fonts/space-grotesk-*.woff2`) | — | SIL OFL 1.1 | `web/static/fonts/OFL-SpaceGrotesk.txt` | https://github.com/floriankarsten/space-grotesk |

Each license text sits in the same directory as the files it covers, so it is embedded in the binary
alongside them — a build is a redistribution, and both licenses require the text to travel with the
work. The Dexie bundle is minified and its own header was stripped, so that file is the only notice
the shipped artifact carries.

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
  attribution for them is this section, and the license text is vendored beside them at
  `web/domain/fixtures/EPL-1.0.txt`.

## Keeping this honest

`web/static/js/tests/architecture.vendor-licenses.test.js` fails if a third-party file is added under
`web/static/vendor/`, `web/static/fonts/` or `web/domain/fixtures/` without being registered against
a license text that exists. Attribution drift is silent otherwise — it surfaces as somebody else's
complaint, long after the commit that caused it.

**Still unattributed**: the icon paths in `web/static/js/components/wg-icons.js` appear to derive from
Lucide (ISC). Confirm and attribute, or replace them — tracked on `myportfolio-18h.11`.

## Derived work

The passkey/PRF vault design, the `--wg-*` design system, and several frontend primitives are ported
from [medicationtrackerbot](https://github.com/korjavin/medicationtrackerbot), MIT © 2026 Korjavin
Ivan — same author, same license. See `docs/ARCHITECTURE.md` §8 and §9 for exactly what was ported
and what was deliberately left behind.
