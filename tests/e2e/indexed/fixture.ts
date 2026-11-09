import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ObservationSetSchema } from "@primusscope/api-schema";
import { SQLiteStore, type CompletedRange } from "../../../packages/storage/src/index";
import { fixtureDatabasePath, repositoryRoot } from "./paths";

/** Synthetic anchors and empty ranges belong exclusively to this test database. */
const anchors = { finance: `0x${"11".repeat(32)}`, network: `0x${"22".repeat(32)}` };
const seed = ObservationSetSchema.parse(JSON.parse(readFileSync(resolve(repositoryRoot, "data/observations/current.json"), "utf8")));
const clockBase = Math.max(Date.parse(seed.generatedAt), Date.parse(seed.finance.coverage.observedAt)) + 60_000;
const at = (step: number) => new Date(clockBase + step * 60_000);

function emptyRange(offset: 1 | 2): CompletedRange {
  const block = (BigInt(seed.finance.coverage.toBlock) + BigInt(offset)).toString();
  return {
    fromBlock: block,
    toBlock: block,
    previousBlockHash: offset === 1 ? anchors.finance : `0x${"33".repeat(32)}`,
    toBlockHash: `0x${(offset === 1 ? "33" : "44").repeat(32)}`,
    toTime: new Date(Date.parse(seed.finance.coverage.toTime!) + offset * 3_000).toISOString(),
    observedAt: new Date(Date.parse(seed.finance.coverage.observedAt) + offset * 1_000).toISOString(),
    events: [],
  };
}

export function seedFixture(): void {
  const path = fixtureDatabasePath();
  if (existsSync(path)) throw new Error("A fresh indexed E2E run must use a new test database.");
  const store = new SQLiteStore(path, { clock: () => at(0) });
  try {
    if (!store.initialize(seed, anchors)) throw new Error("The test observation database was not initialized.");
  } finally { store.close(); }
}

export function mutateFixture(action: "advance" | "repeat" | "fail" | "recover") {
  const path = fixtureDatabasePath();
  if (!existsSync(path)) throw new Error("The isolated indexed E2E database has not been seeded.");
  const step = { advance: 1, repeat: 2, fail: 3, recover: 4 }[action];
  const store = new SQLiteStore(path, { clock: () => at(step) });
  let token: string | undefined;
  try {
    // Restart initialization must recognize the original seed without resetting progress.
    if (store.initialize(seed, anchors)) throw new Error("Restarting a writer unexpectedly replaced its seed.");
    const lease = store.acquireLease("finance", `e2e.fixture.${action}`);
    if (!lease) throw new Error("The isolated fixture writer could not obtain its lease.");
    token = lease.token;
    const committed = action === "fail" ? null : store.commitRange("finance", token, emptyRange(action === "recover" ? 2 : 1));
    store.recordRun("finance", token, {
      outcome: action === "fail" ? "failed" : "advanced",
      at: at(step).toISOString(),
      ...(action === "fail" ? { code: "RPC_TIMEOUT" } : {}),
      targetFinalizedBlock: (BigInt(seed.finance.coverage.toBlock) + 101n).toString(),
      sourceAsOf: new Date(Date.parse(seed.finance.coverage.toTime!) + 101 * 3_000).toISOString(),
    });
    const state = store.readServingState();
    return {
      action,
      snapshotId: state.snapshot.snapshotId,
      toBlock: state.snapshot.finance.coverage.toBlock,
      observedAt: state.snapshot.finance.coverage.observedAt,
      eventCount: state.snapshot.finance.events.length,
      insertedEvents: committed?.insertedEvents ?? 0,
      idempotent: committed?.idempotent ?? false,
    };
  } finally {
    if (token) store.releaseLease(token);
    store.close();
  }
}
