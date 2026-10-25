// How often each hidden entry was offered to the retrieval model, and how often the model judged it needed. An entry that keeps
// ranking high (a long message that mentions most project words) but is never needed takes a place from other candidates at every
// prompt. After OFFERS_BEFORE_REST offers with no "needed", it rests for REST_PROMPTS retrievals in which it would have been a
// candidate, then gets OFFERS_BEFORE_REST new offers. A "needed" verdict clears the count. A handle the prompt names is never rested.
//
// This is tuning state, not a projection of the session: it lives in its own table, which a projection rebuild does not drop.
// Deleting the database resets it, which only means every entry starts with fresh offers.
import type { Db } from "../ledger/db.ts";

export const OFFERS_BEFORE_REST = 3;
export const REST_PROMPTS = 3;

const ensured = new WeakSet<object>();
function ensure(db: Db) {
	if (ensured.has(db)) return;
	db.exec("CREATE TABLE IF NOT EXISTS retrieval_offers (entry_id TEXT PRIMARY KEY, offered INTEGER NOT NULL DEFAULT 0, rested INTEGER NOT NULL DEFAULT 0)");
	ensured.add(db);
}

/** Entries resting now. */
export function resting(db: Db): Set<string> {
	ensure(db);
	const rows = db.prepare("SELECT entry_id FROM retrieval_offers WHERE offered >= ?").all(OFFERS_BEFORE_REST);
	return new Set(rows.map((r) => String(r.entry_id)));
}

/** After a parsed reply: every entry the model saw counts one offer; a needed one starts over. */
export function recordOffers(db: Db, seen: Array<{ entryId: string; needed: boolean }>) {
	ensure(db);
	const up = db.prepare(
		"INSERT INTO retrieval_offers(entry_id, offered, rested) VALUES(?, 1, 0) ON CONFLICT(entry_id) DO UPDATE SET offered = offered + 1",
	);
	const reset = db.prepare("DELETE FROM retrieval_offers WHERE entry_id = ?");
	for (const s of seen) (s.needed ? reset : up).run(s.entryId);
}

/** Entries left out because they rest: one rest each; the last rest gives them their offers back. */
export function recordRests(db: Db, entryIds: string[]) {
	ensure(db);
	const rest = db.prepare("UPDATE retrieval_offers SET rested = rested + 1 WHERE entry_id = ?");
	const done = db.prepare("DELETE FROM retrieval_offers WHERE entry_id = ? AND rested >= ?");
	for (const id of entryIds) {
		rest.run(id);
		done.run(id, REST_PROMPTS);
	}
}
