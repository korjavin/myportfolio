-- The vault: WebAuthn credentials, DEK envelopes, recovery material, and the
-- one encrypted state blob per account (ARCHITECTURE.md 6, 8).
--
-- Everything the server holds here is opaque to it. It stores public keys it
-- verifies signatures against, ciphertext it cannot open, and a hash of a
-- verifier it can only compare. There is no column anywhere that a compromised
-- operator could read to learn a holding, a price, or a key.

-- One row per registered passkey. id is the RAW credential id, not base64 —
-- the wire/envelope form is base64url, and keeping the storage form raw means
-- exactly one place (envelopes.credential_ref) has to agree on an encoding.
CREATE TABLE credentials (
    id                BLOB PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key        BLOB NOT NULL,
    transports        TEXT NOT NULL DEFAULT '',
    -- Stored so an assertion's counter can be recorded, NOT so it can be
    -- enforced: platform authenticators (iCloud Keychain, Google Password
    -- Manager) report 0 forever, so treating a non-increase as a clone would
    -- reject every ordinary passkey. ARCHITECTURE.md 8 / bead A4.
    sign_count        INTEGER NOT NULL DEFAULT 0,
    -- Must round-trip: go-webauthn rejects an assertion whose backup-eligible
    -- bit differs from the one seen at registration, and synced passkeys always
    -- assert BE=1.
    backup_eligible   INTEGER NOT NULL DEFAULT 0,
    backup_state      INTEGER NOT NULL DEFAULT 0,
    created_at_unix   INTEGER NOT NULL,
    last_used_at_unix INTEGER
);

-- Cold unlock resolves an account from the asserted credential, so this is the
-- hot path of the discoverable-credential ceremony, not a reporting index.
CREATE INDEX credentials_account_id ON credentials (account_id);

-- envelope_i = AES-GCM(KEK_i, DEK). credential_ref is base64url(credential id)
-- for a passkey envelope and the literal 'recovery' for the Emergency Kit's.
CREATE TABLE envelopes (
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    credential_ref TEXT NOT NULL,
    v              INTEGER NOT NULL,
    nonce          BLOB NOT NULL,
    ct             BLOB NOT NULL,
    mac            BLOB NOT NULL,
    PRIMARY KEY (account_id, credential_ref)
);

-- SHA-256(verifier) authenticates a recovery attempt (A7 redeems it). A column
-- on accounts rather than its own table because it is 1:1 with an account and
-- has to be written in the SAME transaction as the 'recovery' envelope — a
-- verifier paired with a stale envelope authenticates a code that then cannot
-- decrypt anything, which is a silently broken Emergency Kit.
ALTER TABLE accounts ADD COLUMN recovery_verifier_hash BLOB;

-- The state blob (ARCHITECTURE.md 6): ONE row per account, replaced whole.
-- Not an oplog — a portfolio is a few thousand records and a handful of writes
-- a day, so there is nothing to stream.
--
-- version is the server's compare-and-swap counter. It is also bound into the
-- ciphertext's AAD by the client (as a fixed 8-byte big-endian integer), which
-- is what makes a rollback detectable: the operator can replay a matched
-- (version, nonce, ct) triple but cannot re-label an old blob as a newer one.
CREATE TABLE state_blobs (
    account_id      TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    nonce           BLOB NOT NULL,
    ct              BLOB NOT NULL,
    updated_at_unix INTEGER NOT NULL
);

-- Process secrets that must survive a restart. Today: the HMAC key for session
-- cookies — generated on first boot instead of demanded as configuration, so a
-- self-hosted deployment cannot accidentally run with a guessable one, and so
-- restarting the binary does not sign every user out.
CREATE TABLE server_secrets (
    name            TEXT PRIMARY KEY,
    secret          BLOB NOT NULL,
    created_at_unix INTEGER NOT NULL
);
