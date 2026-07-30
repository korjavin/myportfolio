# Asking an AI about your portfolio — the MCP connector

Connect an AI to your own portfolio. Pinned in [ARCHITECTURE.md §11](ARCHITECTURE.md); this file is
the user- and operator-facing half.

**There are two ways to connect and they are not equally private. Read §0 first — everything from §1
on describes the local shim.**

## 0. Which tier you are choosing

| | **Tier 1 — local shim** | **Tier 2 — hosted URL** |
| --- | --- | --- |
| What you do | build and run `mcpshim` on your machine | paste one URL into your client |
| Works with | Claude Desktop, Claude Code | Claude, ChatGPT, any remote MCP client |
| Needs a Go toolchain | yes | no |
| **Our server can read your questions and answers** | **no — the relay is blind** | **yes, in transit** |
| Pairing key held by | only your machine and your tab | also our server, sealed at rest |
| Zero knowledge | yes | **no** |

Tier 2 exists because Tier 1 needs a Go toolchain and a long-running local process, which rules out
ChatGPT and most phones. The trade is real and unavoidable: for our server to speak MCP to a hosted
client it must hold your pairing key and seal frames on your tab's behalf, so **it sees plaintext
requests and responses in transit**. The key is stored sealed (AES-256-GCM under a key derived from the
server's session secret), which defends a leak of that one table — **not** a stolen database file or a
replica, because those carry the sealing key alongside the ciphertext it protects. Sealing is defence
in depth here, not a boundary.

So Tier 2 is **opt-in, per-account, revocable, and off by default**, and the consent step in Settings
says all of the above at the moment you enable it. Enable it in Settings › Connect Claude, copy the
URL, and **treat that URL as a password** — anyone holding it can query your portfolio while one of
your tabs is unlocked. Revoking drops the server's copy of the key, and deliberately does **not**
disconnect a Tier-1 shim, because both tiers share one relay pairing.

Two things that would otherwise surprise you: a **redeploy drops in-memory pairings**, and **rotating
the server's session secret orphans every stored key**. Either way a configured connector must re-pair
from Settings — and it says so, rather than timing out.

```
Claude Desktop/Code ──stdio── mcpshim ──wss:// ciphertext ──► relay ──► your unlocked PWA tab
                              (holds the pairing key)       (blind)    (decrypts, answers)
```

The server holds only ciphertext, so **it cannot answer a single question**. It pipes opaque encrypted
frames between a small local process (`mcpshim`, running next to Claude on your machine) and one open,
unlocked tab of the app, which is the thing that actually computes the answer.

Three consequences, all of them structural rather than temporary. They are repeated in the app's own
Connect Claude card, and they are the whole of what surprises people:

- **A question only works while a tab of the app is open and unlocked**, on some device of yours.
  There is no server-side fallback, by design. If nothing is listening, Claude is told so.
- **The relay cannot read your data, but it sees the size and timing of every message.** See
  [§7](#7-what-this-costs-you-the-honest-version) — that is a real change to the privacy posture, not
  a footnote.
- **It is read-only.** It can look at the portfolio; it cannot add, change or delete anything.

---

## 1. What you need — including the part that is missing

| | |
|---|---|
| A deployment you have an account on | Signup is one biometric tap — no email, no password. |
| **Go on the machine that runs Claude** | 1.25 or newer (`go.mod`). |
| Claude Desktop or Claude Code | Any MCP client that launches a stdio server with an env var works; these are the two we describe. |

**There is no prebuilt `mcpshim` binary, anywhere.** `release.yml` does not build one and the Docker
image does not carry one — correctly, because the shim runs on *your laptop*, beside Claude, not on
the server. So the install below is `go build`, and that means **a Go toolchain on the client
machine** is a hard prerequisite today. Cross-platform prebuilt binaries are a later issue, not a
thing you are missing; we would rather say so than let you discover it.

---

## 2. Build the shim

From a checkout of this repo, on the machine where Claude runs:

```bash
git clone https://github.com/korjavin/myportfolio
cd myportfolio
go build -o ~/bin/myportfolio-mcpshim ./cmd/mcpshim
~/bin/myportfolio-mcpshim -version        # mcpshim 0.1.0
```

Nothing else is built and nothing is installed system-wide. Use whatever path you like; it goes into
the Claude config verbatim in [§4](#4-point-claude-at-it).

`go build ./cmd/mcpshim` with no `-o` drops a `mcpshim` binary in the current directory, which is
fine too — just keep the absolute path.

**The shim has exactly one setting, and no config file**: the environment variable
`MYPORTFOLIO_MCP_CODE`. Its only setting is a secret, and a secret in a file of ours is a secret we
have to manage.

---

## 3. Pair

In the app: **Settings › Connect Claude › Connect Claude**.

You get a one-time code and, above it, the exact line to put in the shim's environment:

```
MYPORTFOLIO_MCP_CODE=mpmcp1.<base64url>.<checksum>
```

The code carries three things: the relay's URL, the pairing id, and **32 random bytes of encryption
key that never reach the server**. The server mints the id; the browser generates the key afterwards
and sends it nowhere.

Then press **I saved it — finish**. Nothing is connected until you do — that is deliberate, so
abandoning the screen leaves no live pairing behind whose key you never wrote down.

Two properties of the code that are easy to get wrong:

- **It is shown once.** Not because it cannot be recovered — the key is stored in your vault, so a
  second unlocked device answers without re-pairing — but because a secret you can summon again is a
  secret people leave lying around. Lost it? *Replace with a new code*; the old one stops working
  immediately.
- **Pasting it into the wrong variable, or a code from another app, fails at startup rather than
  silently.** The code carries a checksum, so a typo is caught before the shim connects. This
  matters: an undetected typo used to produce a shim that connected happily and timed out every
  call with *"no unlocked device is online"* — the design's own documented limitation, and therefore
  the last thing anyone thinks to question.

---

## 4. Point Claude at it

**Claude Code**, one command:

```bash
claude mcp add myportfolio \
  --env MYPORTFOLIO_MCP_CODE=mpmcp1.… \
  -- ~/bin/myportfolio-mcpshim
```

**Claude Desktop**, in `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) — then restart it:

```json
{
  "mcpServers": {
    "myportfolio": {
      "command": "/Users/you/bin/myportfolio-mcpshim",
      "env": {
        "MYPORTFOLIO_MCP_CODE": "mpmcp1.…"
      }
    }
  }
}
```

Use an **absolute path** for `command`: the client launches the process itself, not through your
shell, so `~` and a `PATH` entry from your profile may not be there.

**Verified from our side and stated as such:** the shim's contract — the variable name, the two
advertised tools, the startup failures below, and that its stdout carries nothing but MCP protocol
traffic — is driven against the real built binary by `cmd/mcpshim/main_test.go`. The two config
blocks above are the standard MCP `mcpServers` shape those clients document; we have not driven
Claude Desktop's UI from a test, so if a future client version changes that file's shape, believe the
client.

**A note on where the secret ends up.** The shim keeps no config file, but the client's config *is* a
file, so the code — and therefore the pairing key — lands on your disk in plaintext, protected by
your OS like anything else there. That is the trade for a one-variable setup. Anyone who can read
that file, and reach the relay, can read your portfolio until you disconnect.

---

## 5. What the AI can see

Two tools, and deliberately no third. `mcp_help` discovers, `mcp_call` runs exactly one operation.
There is no `mcp_execute`-style script runner and there cannot be: it would have to run somewhere
that can read your data, and the server can't.

`mcp_help` with no arguments returns the whole catalog — eight read-only operations
(`web/static/js/core/mcp-catalog.js` is the source of truth):

| Operation | What it answers |
|---|---|
| `portfolio.summary` | The whole portfolio in one small answer: total value, cost, unrealized/realized gain, dividends, fees, taxes, counts. The cheapest call. |
| `portfolio.holdings` | Every open and closed position, one row per (securities account, security) — shares, cost basis, latest stored close, market value, gains. |
| `portfolio.securities` | One row per security across the whole portfolio, with the brokers it is held at. Where `securityId` comes from. |
| `portfolio.accounts` | Cash and securities accounts with balances derived from the transaction log. |
| `portfolio.issues` | Everything the engine could **not** compute and why — missing FX rate, unpriced holding, oversell, undated transaction. |
| `performance.summary` | TTWROR and IRR over a date range, portfolio-wide and per security, as fractions with an explicit "not defined" case. |
| `prices.series` | One security's stored daily closes. Nothing is fetched live. |
| `transactions.list` | The raw transaction log, newest first, filterable by date, type, security or account. |

Every operation optionally takes an `asOf` / `from` / `to` date, so "what did this look like in March"
works. Money crosses the boundary twice — an exact decimal string plus a fixed-point integer — so a
model cannot read €1,234.56 as 123,456 euros.

**What it cannot do:** anything else. The read-only guarantee is structural, not a convention — the
catalog is handed a records port with only `list` on it, so no operation can reach a write even by
accident. Write operations are a separate decision with their own consent surface; *"the model
misread the units and booked a sell"* is not a failure mode worth shipping to be first.

**What it never sees, even so:** your passkeys, your recovery code, your vault keys, and the pairing
key itself — the pairing record is deliberately outside the record types `exportAll()` enumerates, so
it is not in your plaintext exports either.

---

## 6. When it says nothing is online

Four shapes, kept mutually distinguishable on purpose, because *"the connector looks alive and every
call times out"* is a symptom that points nowhere.

| What Claude is told | What it means | What to do |
|---|---|---|
| *No unlocked device is online to answer. Your pairing code is valid…* | The pairing is fine; no tab is open and unlocked. Returned after 30s. | Open the app, unlock it, retry. |
| *This pairing no longer exists…* | The relay closed a **live** connection because the account's pairing went away under it — you pressed Disconnect, or it aged out while the shim was attached. | Re-pair in Settings, restart the shim with the new code. |
| *Another connection took over this pairing…* | A newer shim, or a newer pairing minted from Settings, replaced this one. | Keep one shim; if you re-paired, restart it with the new code. |
| *mcpshim: connect to relay: … gave up reconnecting after 3 attempts … dial relay …* | The shim could not get a socket at all: the relay is unreachable, **or** it answered `401 unknown or expired pairing` because the pairing is already gone. This is what a shim started *after* a pairing expired or a server restart sees — there is no live connection left for the relay to close with a nicer message. | Check the app loads at all; if it does, re-pair and restart the shim. |

Startup failures are separate and loud — the shim refuses to run rather than pairing with a key that
would make every call time out. Both go to stderr, which is where your client's MCP logs will show
them:

```
$ MYPORTFOLIO_MCP_CODE=nonsense myportfolio-mcpshim
level=ERROR msg="[mcpshim] invalid MYPORTFOLIO_MCP_CODE — the code itself is malformed (mistyped,
truncated, or from a different app), which is NOT the same as 'no device online'. …"
error="mcpshim: pairing code missing \"mpmcp1.\" prefix"

$ myportfolio-mcpshim          # variable unset
level=ERROR msg="[mcpshim] MYPORTFOLIO_MCP_CODE is not set — open your portfolio, go to
Settings › Connect Claude, and paste the one-time code into that variable"
```

### Pairings expire, and today they expire too eagerly

Stated as the code behaves at the time of writing (`internal/server/mcp_relay.go`):

- **A pairing ages out 24 hours after it was minted, and using it does not extend that.**
- **The pairing table is in memory, so a server restart ends every pairing** — and this deployment
  redeploys on every green push to master, so that is not a rare event.

Recovery is the same either way — re-pair in Settings, restart the client — but **which of the two
messages above you get depends on whether the shim was connected at the time**. Aged out while
attached: the relay closes the leg with `4404` and you get *"This pairing no longer exists"*, which is
the sentence you want. Killed by a restart, or first call from a shim started later: there is no live
leg to close, the redial 401s, and you get the transport-flavoured *"gave up reconnecting"* error
instead. Same cause, worse label — worth knowing, since the restart case is the common one here.

This is a known defect rather than a design property (bd `myportfolio-ybp.10`). The `4404` machinery
that reports it *is* the design, and works.

If you have several tabs or devices open, exactly one of them answers — one device leg per pairing is
a standing limitation. The tabs elect an answerer between themselves; you do not have to pick.

---

## 7. What this costs you — the honest version

The rest of this product's privacy story ([ARCHITECTURE.md §6](ARCHITECTURE.md), §8) is: the server
sees one opaque blob per account, written on a debounced schedule, and can infer almost nothing from
it. **Turning on the connector genuinely weakens that**, in three specific ways, and the point of this
section is that you get to decide with the facts rather than after them.

**On Tier 2 there is a fourth, and it subsumes the first: our server sees the plaintext.** Points 1–3
below are written for Tier 1, where the relay is blind and metadata is all it gets. If you enabled the
hosted URL, replace point 1 with "the server reads the questions and the answers in transit" and read
§0 again. Everything in points 2 and 3 still applies unchanged.

**1. The relay learns metadata.** It cannot open a frame — every message is encrypted to a key it
never receives, with the pairing id bound into the AEAD so a frame cannot be replayed into another
pairing. But it sees **frame sizes, timing, and pairing ids**. So it learns that you asked something,
when, and roughly how big the answer was — never what. Against a blob on a debounced timer, that is a
real delta: an interactive request/response pattern is inherently more revealing than a periodic
write, and nothing in the design hides it.

**2. Any unlocked device of yours can answer.** The pairing key lives in a vault record, which syncs
like every other record. That is the feature — pair once, answer from your phone or your laptop —
and it is also the blast radius: the pairing is an account-level capability, not a device-level one.
Whoever holds an unlocked device can serve your portfolio to a paired shim. Disconnect revokes it
everywhere at once, which is the other side of the same property.

**3. Whatever the AI is told leaves the local trust boundary entirely.** This is the big one, and no
amount of end-to-end encryption on our side touches it. Once a tool result reaches Claude, your
holdings, transactions and returns are in a prompt on the model provider's infrastructure, subject to
their terms and their retention, not ours. Our end-to-end encryption stops at the point *you* asked
us to send data somewhere. That is a legitimate thing to want — it is the whole point of holding a
rigorous portfolio locally — but it is your call to make, and you can only make it if we say so
plainly.

And the ceiling under all of it, unchanged from §8: end-to-end encryption cannot protect against the
origin serving poisoned JavaScript. The connector does not make that worse; it does not make it
better either.

---

## 8. Trying it without your own data

**`?demo=1` does not answer MCP calls, and must not.** If you pair Claude and then open the demo URL
expecting it to work, you will conclude the connector is broken. It isn't: `boot.js` deliberately
never starts the responder in the demo branch. A demo tab answering relayed calls would serve
**fabricated trades to an agent as if they were a real portfolio**, and the agent has no way to tell.
Both relay legs are session-authenticated and demo mode has no account, so making it work would mean
an unauthenticated pairing endpoint — a fresh abuse surface, in order to serve invented numbers.

The supported path is therefore: **sign up (one biometric tap, no email, no password), then put
sample data into your own vault** and pair against that. Nothing is deceived — you chose to load
sample data into an account you own, and the connector works unchanged.

A one-click *Load sample portfolio* action is bd `myportfolio-cnd.6` and **is not in Settings at the
time of writing**; until it lands, the way to get data into a fresh account is the Portfolio
Performance import or entering a couple of transactions by hand. We would rather name the gap than
document a button that isn't there.

---

## 9. Disconnect

**Settings › Connect Claude › Disconnect.** It revokes the pairing on the server first and then
deletes the stored key, in that order — the other order would delete the only copy of the key while
the relay still routed the pairing, leaving a shim connected to something nothing can answer.

Effects, immediately and on every device:

- The relay drops both legs and forgets the pairing.
- The key is deleted from your vault, so no device can answer with it.
- The code in your Claude config stops working. Remove it, or leave it — it is inert either way,
  though it is a secret in a file, so removing it is better hygiene.

Connecting again gives you a new code. *Replace with a new code* does the same thing in one step:
the old code dies the moment the new one is minted.

---

## 10. For contributors

The connector is five files, and the properties above are pinned by tests rather than by convention:

| | |
|---|---|
| `cmd/mcpshim/` | The local stdio MCP server. Two tools, one env var, all diagnostics on stderr. |
| `internal/mcpshim/` | Dial, frame crypto, correlation, the pairing-code format. |
| `internal/server/mcp_relay.go` | The blind relay: two legs, close codes `4404`/`4409`, a per-pairing rate limit. Nothing here may grow a call that decodes a frame body. |
| `web/static/js/core/mcp-responder.js` | The browser responder and the single-answerer election. |
| `web/static/js/core/mcp-catalog.js` | The eight read-only operations and the money-presentation boundary. |

Read [ARCHITECTURE.md §11](ARCHITECTURE.md) before changing any of it — the close codes, the
`relay_url`-is-an-endpoint rule and the frame budget are each scar tissue from a bug that presented
as an unattributable timeout.
