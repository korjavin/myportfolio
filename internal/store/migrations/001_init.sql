-- The account is the only thing the skeleton knows about; every later table
-- hangs off it (credentials + envelopes in A3, the encrypted state blob in A5).
--
-- Deliberately NO subdomain column, unlike medtracker's cloudstore 001_init.sql:
-- myportfolio is single origin (ARCHITECTURE.md 8.2), so an account is resolved
-- from the session/credential and never from the Host header. There is likewise
-- no claim_token_hash/claim_expires_unix — no invite provisioning to gate.
CREATE TABLE accounts (
    id              TEXT PRIMARY KEY,
    created_at_unix INTEGER NOT NULL
);
