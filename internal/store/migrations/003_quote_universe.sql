-- The pre-fetched quote universe (ARCHITECTURE.md 7, bead myportfolio-18h.19).
--
-- ONE row, holding the exact JSON bytes served to every caller of
-- GET /api/quotes/universe. Storing the encoded body rather than the symbols
-- and closes it was built from is the whole point: the endpoint's contract is
-- that two callers get a BYTE-IDENTICAL response, and re-encoding per request
-- from a Go map would not even be identical to itself.
--
-- This is the only table in the schema that is not account-scoped, and that is
-- the privacy property, not an oversight: the blob is the same for everybody, so
-- there is nothing here to key by account and nothing to leak. It never records
-- who asked.
--
-- It also survives a restart, which is why it is a table and not a package
-- variable: a redeploy would otherwise serve an empty universe until the next
-- upstream refresh finished.
CREATE TABLE quote_universe (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    body            BLOB NOT NULL,
    updated_at_unix INTEGER NOT NULL
);
