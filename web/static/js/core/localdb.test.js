/**
 * localdb.test.js
 *
 * The two halves of bd myportfolio-18h.12 that live in localdb.js: moving the
 * pre-signup rows into the account that claims this device, and erasing every
 * namespace rather than only the one currently open.
 *
 * Dexie itself is not exercised — there is no IndexedDB under `node --test` and
 * a double of it would test the double. What IS exercised is everything that can
 * be wrong without a browser noticing: which rows move, which are left behind,
 * and which database names an account deletion is required to reach.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { claim, mirrorName, deleteAllMirrors } from './localdb.js';
import { fakeDb } from './tests/sync-fakes.mjs';

function row(recordId, clientTs, extra = {}) {
    return { recordId, recordType: 'transaction', deleted: false, clientTs, ...extra };
}

async function seed(db, rows) {
    await db.records.bulkPut(rows);
    return db;
}

describe('claim: the pre-signup rows follow the user into their account', () => {
    test('every row moves, and none is left readable in the pre-signup mirror', async () => {
        const pre = await seed(fakeDb(), [row('tx_1', 10), row('tx_2', 11, { deleted: true })]);
        const account = fakeDb();

        assert.equal(await claim(pre, account), 2);

        assert.deepEqual((await account.records.toArray()).map((r) => r.recordId), ['tx_1', 'tx_2']);
        // The tombstone travels too — dropping it resurrects a deleted trade.
        assert.equal((await account.records.toArray()).find((r) => r.recordId === 'tx_2').deleted, true);
        // "My data vanished" is unrecoverable, but so is leaving it behind for
        // the NEXT account to claim: the move is what makes the isolation real.
        assert.deepEqual(await pre.records.toArray(), []);
    });

    test('an empty pre-signup mirror is a no-op, not a wipe of the account', async () => {
        const account = await seed(fakeDb(), [row('tx_1', 10)]);
        assert.equal(await claim(fakeDb(), account), 0);
        assert.deepEqual((await account.records.toArray()).map((r) => r.recordId), ['tx_1']);
    });

    test('a newer row already in the account survives an older pre-signup one', async () => {
        // The user was logged out for a while, edited tx_1 offline, then logged
        // back in — but the account's copy had already been edited on another
        // device and pulled down. §6's rule, not a new one: higher clientTs wins.
        const pre = await seed(fakeDb(), [row('tx_1', 10, { amount: 100 }), row('tx_2', 10)]);
        const account = await seed(fakeDb(), [row('tx_1', 99, { amount: 999 })]);

        assert.equal(await claim(pre, account), 1, 'only tx_2 is news');

        const rows = await account.records.toArray();
        assert.equal(rows.find((r) => r.recordId === 'tx_1').amount, 999);
        assert.deepEqual(rows.map((r) => r.recordId).sort(), ['tx_1', 'tx_2']);
    });

    test('running it twice changes nothing — a half-finished migration retries safely', async () => {
        const pre = await seed(fakeDb(), [row('tx_1', 10)]);
        const account = fakeDb();
        await claim(pre, account);
        // Second open of the same account: the source is drained, so there is
        // nothing to re-apply and nothing to clobber.
        assert.equal(await claim(pre, account), 0);
        assert.deepEqual((await account.records.toArray()).map((r) => r.recordId), ['tx_1']);
    });
});

/** An indexedDB with just the two methods deleteAllMirrors uses. */
function fakeIdb(names, { enumerable = true, blocked = [] } = {}) {
    const idb = {
        names: [...names],
        deleteDatabase(name) {
            const req = {};
            queueMicrotask(() => {
                if (blocked.includes(name)) {
                    req.onblocked?.();
                    return;
                }
                idb.names = idb.names.filter((n) => n !== name);
                req.onsuccess?.();
            });
            return req;
        },
    };
    if (enumerable) idb.databases = async () => idb.names.map((name) => ({ name }));
    return idb;
}

describe('deleteAllMirrors: account deletion reaches every namespace', () => {
    const ACCOUNT = 'amber-falcon-8k3q9x';
    const OTHER = 'copper-heron-2p7w4m';

    test('every mirror and every account\'s sync metadata goes, and nothing else', async () => {
        const idb = fakeIdb([
            'myportfolio',
            mirrorName(ACCOUNT),
            mirrorName(OTHER),
            `myportfolio-sync_${ACCOUNT}`,
            'myportfolio-sync',
            'myportfolio-device',
            'some-other-app',
        ]);

        await deleteAllMirrors({ idb, accountId: ACCOUNT });

        // The whole point: deleting only the account that happens to be open
        // leaves the other one's plaintext portfolio on disk.
        assert.deepEqual(idb.names, ['myportfolio-device', 'some-other-app']);
    });

    test('a browser that will not enumerate still loses the active account', async () => {
        const idb = fakeIdb(['myportfolio', mirrorName(ACCOUNT), mirrorName(OTHER)], { enumerable: false });

        await deleteAllMirrors({ idb, accountId: ACCOUNT });

        // indexedDB.databases() is missing, so the other account cannot be found
        // — but the one being deleted must never survive its own deletion.
        assert.deepEqual(idb.names, [mirrorName(OTHER)]);
    });

    test('a blocked delete rejects rather than reporting success', async () => {
        const idb = fakeIdb(['myportfolio', mirrorName(ACCOUNT)], { blocked: [mirrorName(ACCOUNT)] });
        await assert.rejects(
            deleteAllMirrors({ idb, accountId: ACCOUNT }),
            /holding myportfolio_amber-falcon-8k3q9x open/,
            'an account deletion that says "done" while the rows are still there is the worst possible answer'
        );
    });
});
