import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chunk } from "../src/ledger/fts.ts";
import { dbPathFor, Ledger, logicalDump } from "../src/ledger/projector.ts";
import { readSource } from "../src/ledger/source.ts";
import { Memory } from "../src/memory.ts";
import { asst, fakeSession, fixtureEntries, user, type Any } from "./memory-fixture.ts";

const open: Ledger[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const ledgerAt = (path: string, src: Any) => { const l = Ledger.open(src, path); open.push(l); return l; };
const srcOf = (s: ReturnType<typeof fakeSession>, n?: number) => {
	const src = readSource(s.ctx)!;
	return n === undefined ? src : { ...src, entries: src.entries.slice(0, n) };
};

describe("reopening a large session", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => user(`u${i}`, i ? `u${i - 1}` : null, `message number ${i}`));

	test("an unchanged, fully indexed session of more than one batch is reused, not rebuilt", async () => {
		const s = fakeSession(many(1203));
		const logs: Any[] = [];
		const first = new Memory((r) => logs.push(r));
		first.sessionStart(s.ctx);
		await first.ready;
		while (first.state !== "ready") await new Promise((r) => setImmediate(r)); // the remaining batches, one per tick
		first.shutdown();
		const second = new Memory((r) => logs.push(r));
		second.sessionStart(s.ctx);
		await second.ready;
		second.shutdown();
		const opens = logs.filter((r) => r.type === "memory_backfill");
		expect(opens.map((r) => [r.reconcile, r.projected, r.done])).toEqual([["rebuild", 500, false], ["reuse", 0, true]]);
	});

	test("the batch limit bounds projection only: a partial database continues, a changed prefix rebuilds one batch", () => {
		const s = fakeSession(many(25));
		const path = join(s.dir, "p.sqlite");
		const a = ledgerAt(path, srcOf(s));
		expect(a.reconcile(srcOf(s), 10)).toMatchObject({ mode: "rebuild", projected: 10 });
		a.close(); open.pop();
		const b = ledgerAt(path, srcOf(s));
		expect(b.reconcile(srcOf(s), 10)).toMatchObject({ mode: "append", projected: 10 }); // 10..20, nothing dropped
		expect(b.projectedCount).toBe(20);
		expect(b.reconcile(srcOf(s), 10)).toMatchObject({ mode: "append", projected: 5 });
		expect(b.current(srcOf(s))).toBe(true);
		s.state.entries[3] = { ...s.state.entries[3], message: { ...s.state.entries[3].message, content: "edited" } };
		expect(b.reconcile(srcOf(s), 10)).toMatchObject({ mode: "rebuild", projected: 10 });
	});
});

describe("backfill ownership and failure state", () => {
	const many = (id: string, n = 1203) => Array.from({ length: n }, (_, i) => user(`${id}-${i}`, i ? `${id}-${i - 1}` : null, `request ${i}`));
	// Control only the scheduling. Callbacks, transactions and projection are the production code.
	function ticks() {
		const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
		const schedule = spyOn(globalThis, "setImmediate").mockImplementation(((fn: () => void) => {
			const t = { fn, cancelled: false }; queue.push(t); return t;
		}) as Any);
		const cancel = spyOn(globalThis, "clearImmediate").mockImplementation(((t: { cancelled: boolean }) => { t.cancelled = true; }) as Any);
		return { queue, restore: () => { schedule.mockRestore(); cancel.mockRestore(); } };
	}

	test("a failed second batch stays error, rolls back to the committed prefix, then resumes in bounded batches", async () => {
		const s = fakeSession(many("A")), logs: Any[] = [], mem = new Memory((r) => logs.push(r));
		const clock = ticks();
		try {
			mem.sessionStart(s.ctx); await mem.ready;
			const first = (mem as Any).ledger as Ledger;
			expect(first.projectedCount).toBe(500);
			first.onProject = (seq) => { if (seq === 650) throw new Error("batch fault"); };
			clock.queue.shift()!.fn();
			expect(mem.state).toBe("error");
			expect((mem as Any).ledgerDone).toBe(false);
			expect((mem as Any).pumping).toBe(false);
			expect(logs.find((r) => r.type === "error")).toMatchObject({ error: "batch fault", failures: 1, sessionId: "sA" });
			const committed = ledgerAt(dbPathFor(s.file, s.header.id), srcOf(s));
			expect(committed.counts(1203).indexedEntries).toBe(500); // entries 500..649 were rolled back
			committed.close(); open.pop();
			const retry = mem.ensure(s.ctx, "retry")!;
			expect(retry.projectedCount).toBe(1000); // opening retry projects 500, not all 703 remaining
			expect(mem.state).toBe("indexing");
			let projected = 0;
			retry.onProject = () => { projected++; };
			clock.queue.shift()!.fn();
			expect(projected).toBe(203);
			expect(retry.current(srcOf(s))).toBe(true);
			expect(mem.state).toBe("ready");
			expect(mem.error).toBe("");
			expect((mem as Any).failures).toBe(0);
			expect(clock.queue).toHaveLength(0);
		} finally { mem.shutdown(); clock.restore(); rmSync(s.dir, { recursive: true, force: true }); }
	});

	test("release cancels queued ticks; even an already-dequeued old callback cannot touch a new session or shutdown state", async () => {
		for (const action of ["switch", "shutdown"]) {
			const a = fakeSession(many("A"), { id: "A" }), b = fakeSession(many("B"), { id: "B" });
			const logs: Any[] = [], mem = new Memory((r) => logs.push(r)), clock = ticks();
			try {
				mem.sessionStart(a.ctx); await mem.ready;
				const old = clock.queue.shift()!, oldLedger = (mem as Any).ledger as Ledger;
				let oldCalls = 0;
				const catchUp = oldLedger.catchUp.bind(oldLedger);
				oldLedger.catchUp = (src) => { oldCalls++; return catchUp(src); };
				if (action === "switch") { mem.sessionStart(b.ctx); await mem.ready; }
				else mem.shutdown();
				expect(old.cancelled).toBe(true);
				const before = { state: mem.state, error: mem.error, pumping: (mem as Any).pumping, done: (mem as Any).ledgerDone,
					ledger: (mem as Any).ledger, pending: (mem as Any).backfillStep, records: logs.length };
				old.fn(); // intentionally invoke a cancelled callback to prove the ownership guard, not just cancellation
				expect(oldCalls).toBe(0); // stale work must not even access the old closed ledger
				expect({ state: mem.state, error: mem.error, pumping: (mem as Any).pumping, done: (mem as Any).ledgerDone,
					ledger: (mem as Any).ledger, pending: (mem as Any).backfillStep, records: logs.length }).toEqual(before);
				if (action === "switch") {
					const led = (mem as Any).ledger as Ledger;
					expect(led.sessionId).toBe("B");
					expect(led.projectedCount).toBe(500);
					expect(mem.state).toBe("indexing");
					clock.queue.shift()!.fn(); // B's own second batch still runs
					expect(led.projectedCount).toBe(1000);
					expect(mem.state).toBe("indexing");
					b.state.entries.push(user("B-new", "B-1202", "arrived between ticks"));
					b.state.leaf = "B-new"; // no catchUp event: the pump must read the newest source itself
					clock.queue.shift()!.fn();
					expect(led.projectedCount).toBe(1204);
					expect(led.current(srcOf(b))).toBe(true);
					expect(mem.state).toBe("ready");
				} else expect((mem as Any).ledger).toBeNull();
				expect(logs.filter((r) => r.type === "error")).toEqual([]);
			} finally { mem.shutdown(); clock.restore(); rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); }
		}
	});

	test("batch failures count toward the retry limit; reconciliation of an incomplete prefix does not reset them", async () => {
		const s = fakeSession(many("A", 2203)), logs: Any[] = [], mem = new Memory((r) => logs.push(r)), clock = ticks();
		const original = Ledger.open;
		const opening = spyOn(Ledger, "open").mockImplementation((...args: Parameters<typeof Ledger.open>) => {
			const led = original(...args);
			led.catchUp = () => { throw new Error("persistent fault"); };
			return led;
		});
		try {
			mem.sessionStart(s.ctx); await mem.ready;
			clock.queue.shift()!.fn(); // first failure: async batch
			for (let n = 2; n <= 3; n++) {
				const retry = mem.ensure(s.ctx, `retry-${n}`)!;
				expect(retry.projectedCount).toBe(n * 500); // valid partial reconciliation succeeds, but the next tick still fails
				clock.queue.shift()!.fn();
			}
			expect(mem.ensure(s.ctx, "retry-blocked")).toBeNull();
			expect(opening).toHaveBeenCalledTimes(3);
			expect(logs.filter((r) => r.type === "error").map((r) => r.failures)).toEqual([1, 2, 3]);
			expect(mem.state).toBe("error");
			expect(clock.queue).toHaveLength(0);
		} finally { mem.shutdown(); opening.mockRestore(); clock.restore(); rmSync(s.dir, { recursive: true, force: true }); }
	});
});

describe("chunking (hand-computed windows)", () => {
	test("7000 chars -> windows at 0, 2700, 5400 with a 300-char overlap; the last one ends at the text's end", () => {
		const text = Array.from({ length: 7000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
		const { chunks, indexed, truncated } = chunk(text);
		expect(chunks.map((c) => [c.start, c.start + c.text.length])).toEqual([[0, 3000], [2700, 5700], [5400, 7000]]);
		for (const c of chunks) expect(c.text).toBe(text.slice(c.start, c.start + c.text.length)); // exact slices of the source
		expect([indexed, truncated]).toEqual([7000, false]);
		expect(chunk("x".repeat(3000)).chunks.length).toBe(1); // exactly one window: no empty or overlapping tail chunk
		expect(chunk("x".repeat(3001)).chunks.map((c) => c.start)).toEqual([0, 2700]);
	});

});

describe("deterministic projection", () => {
	test("a tool result is linked to the call that issued its id on its own ancestry, also with parallel calls and a reused id", () => {
		const s = fakeSession(fixtureEntries());
		const l = ledgerAt(join(s.dir, "x.sqlite"), srcOf(s));
		l.reconcile(srcOf(s));
		const links = l.db.prepare("SELECT src_id, dst_id FROM edges WHERE type = 'answered_by' ORDER BY dst_id").all().map((r) => `${r.src_id}->${r.dst_id}`);
		// a1 issued c1 (block 2) and c2 (block 3); r1 answers c2, r2 answers c1; a2 reissued c1 and r3 answers that one
		expect(links).toEqual(["call:a1:3->entry:r1", "call:a1:2->entry:r2", "call:a2:0->entry:r3", "call:a4:0->entry:r4", "call:a5:0->entry:r5"]);
	});



	test("incremental batches give exactly the rows of one clean rebuild, including segments that grow across batches", () => {
		const s = fakeSession(fixtureEntries());
		const full = srcOf(s);
		const a = ledgerAt(join(s.dir, "inc.sqlite"), full);
		a.reconcile(srcOf(s, 3)); // u1 a1 r1: segment a1 is incomplete here (r2 still to come)
		expect(a.catchUp(srcOf(s, 10))).toBe(7); // up to a4: r4 (its result) arrives in the next batch
		expect(a.catchUp(full)).toBe(full.entries.length - 10);
		expect(a.catchUp(full)).toBe(0);
		const b = ledgerAt(join(s.dir, "clean.sqlite"), full);
		expect(b.reconcile(full).mode).toBe("rebuild");
		expect(logicalDump(a.db)).toEqual(logicalDump(b.db));
		const seg = a.db.prepare("SELECT retrieval_text FROM segments WHERE id = 'a1'").get()!.retrieval_text;
		expect(seg).toContain("[error] Error: timeout after 30000ms"); // r2 came in the second batch and still reached segment a1
	});


	test("an interrupted first backfill leaves no rows behind and runs again in full at the next open", () => {
		const s = fakeSession(fixtureEntries());
		const path = join(s.dir, "x.sqlite");
		const l = ledgerAt(path, srcOf(s));
		l.onProject = (seq) => { if (seq === 6) throw new Error("killed"); };
		expect(() => l.reconcile(srcOf(s))).toThrow("killed");
		expect(l.db.prepare("SELECT count(*) AS n FROM events_seen").get()!.n).toBe(0);
		expect(l.db.prepare("SELECT count(*) AS n FROM search_docs").get()!.n).toBe(0);
		l.close();
		const again = ledgerAt(path, srcOf(s));
		expect(again.reconcile(srcOf(s)).mode).toBe("rebuild");
		const clean = ledgerAt(join(s.dir, "clean.sqlite"), srcOf(s));
		clean.reconcile(srcOf(s));
		expect(logicalDump(again.db)).toEqual(logicalDump(clean.db));
	});

	test("the judge setting does not change the projection, and nothing the ledger or retrieval imports reaches the judge", () => {
		const dumps = ["1", "0"].map((v) => {
			process.env.PI_ZIP_JUDGE = v;
			const s = fakeSession(fixtureEntries());
			const l = ledgerAt(join(s.dir, "x.sqlite"), srcOf(s));
			l.reconcile(srcOf(s));
			return logicalDump(l.db);
		});
		delete process.env.PI_ZIP_JUDGE;
		expect(dumps[0]).toEqual(dumps[1]);
		const src = join(import.meta.dir, "..", "src");
		const seen = new Set<string>();
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const m of readFileSync(file, "utf8").matchAll(/^import[^;]*?from "(\.[^"]+)"/gm)) walk(join(file, "..", m[1]));
		};
		walk(join(src, "memory.ts"));
		const reached = [...seen].map((f) => f.slice(src.length + 1)).sort();
		expect(reached.some((f) => f === "judge.ts" || f === "plan.ts" || f === "run.ts")).toBe(false);
		expect(reached).toContain("ledger/projector.ts"); // the walk does follow the ledger
	});
});

describe("lazy backfill of the opened session only", () => {
	test("opening A creates only A's database; B gets one when it is opened; nothing else in the directory is touched", async () => {
		const a = fakeSession(fixtureEntries(), { id: "sA" });
		const b = fakeSession([user("u1", null, "other session"), asst("a1", "u1", [{ type: "text", text: "hi" }])], { dir: a.dir, id: "sB" });
		const c = fakeSession([user("u1", null, "third session")], { dir: a.dir, id: "sC" });
		const dbs = () => readdirSync(a.dir).filter((f) => f.includes(".memory.sqlite") && !/-(wal|shm)$/.test(f)).sort();
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(a.ctx);
		expect(dbs()).toEqual([]); // deferred: session_start returns before any indexing
		await mem.ready;
		expect(dbs()).toEqual([`2026-01-01_sA.memory.sqlite`]);
		expect(mem.statusLine(a.ctx)).toContain(`indexed_entries=${fixtureEntries().length}`);
		mem.sessionStart(b.ctx);
		await mem.ready;
		expect(dbs()).toEqual([`2026-01-01_sA.memory.sqlite`, `2026-01-01_sB.memory.sqlite`]);
		expect(existsSync(dbPathFor(c.file, "sC"))).toBe(false);
		mem.shutdown();
		expect(logs.filter((r) => r.type === "memory_backfill").map((r) => r.entries)).toEqual([fixtureEntries().length, 2]);
	});

});
