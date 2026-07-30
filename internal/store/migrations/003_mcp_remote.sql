-- Tier 2 of the AI connector (ARCHITECTURE.md §11, "Two tiers"): the hosted MCP
-- URL a user pastes into Claude or ChatGPT. One row per account, present only
-- while the connector is enabled — the row IS the enablement, so disabling is a
-- DELETE and there is nothing left on disk to unseal.
--
-- This is the ONLY table in the schema that holds a secret the server can open.
-- Everything in 002 is either ciphertext it has no key for or a hash it can only
-- compare; this key it must actually use, because Tier 2's whole premise is that
-- the server seals frames on the browser's behalf. The key therefore lands
-- SEALED: AES-256-GCM under an HKDF-SHA256 key derived from the session secret
-- (internal/server/mcp_seal.go), never in plaintext.
--
-- Sealed at rest is NOT zero knowledge and must not be described as such
-- anywhere: the running server opens this key and sees MCP requests and
-- responses in plaintext in transit. That is the trade Tier 2 makes and Tier 1
-- (cmd/mcpshim, which holds the key on the user's own machine) does not.
--
-- Rotating the session secret orphans every row here: the sealing key is derived
-- from it, so already-paired remotes cannot be opened and must re-pair. That is
-- accepted, and it is strictly milder than losing the volume, which destroys
-- vaults outright (docs/DEPLOY.md).
CREATE TABLE mcp_remote (
    account_id        TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    -- The capability token in the connector URL. High-entropy, unlike the
    -- sibling's typed-across-devices token: the user copies a URL into a client
    -- config and never retypes it (§11's "Where we diverge"), so entropy is
    -- free and brute force stops being the thing that has to be throttled.
    token             TEXT NOT NULL UNIQUE,
    relay_url         TEXT NOT NULL,
    pairing_id        TEXT NOT NULL,
    pairing_key_ct    BLOB NOT NULL,
    pairing_key_nonce BLOB NOT NULL,
    created_at_unix   INTEGER NOT NULL
);

-- ON DELETE CASCADE above is load-bearing rather than tidiness: a revoked
-- connector whose key is still decryptable on disk is not revoked, so deleting
-- an account has to take its pairing key with it. There is no server-side
-- account-delete path today, which is exactly why the constraint carries the
-- rule instead of a handler that has to remember this table exists. PRAGMA
-- foreign_keys=ON is set in store.Open, and TestForeignKeysEnforced pins it.
