import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObservationSetSchema, type ObservationSet } from '@primusscope/api-schema';
import type { Checkpoint, CompletedRange, Domain, DomainStatus, IndexerStatus, Lease, RunRecord, ServingState } from './types';
import { StorageError } from './errors';
import { validatePublication, type HostedPublication } from './publication';
export type * from './types';
export { StorageError } from './errors';

const DOMAINS: Domain[] = ['finance', 'network'];
const HASH = /^0x[0-9a-fA-F]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const SCHEMA_VERSION = 2;
const ERROR_CODES = new Set(['RPC_TIMEOUT', 'RPC_RATE_LIMITED', 'REQUEST_BUDGET_EXCEEDED', 'CHAIN_MISMATCH',
  'REORG_DETECTED', 'REORG_BELOW_CHECKPOINT', 'UNKNOWN_IMPLEMENTATION', 'DECODE_ERROR', 'INCONSISTENT_RESPONSE',
  'SOURCE_UNAVAILABLE', 'INDEXING_FAILED', 'CAPACITY_EXCEEDED', 'ABI_MISMATCH', 'RPC_ERROR', 'REQUEST_LIMIT',
  'PROVIDER_ERROR', 'RANGE_INCOMPLETE', 'CHECKPOINT_MISMATCH',
  'REQUEST_TIMEOUT', 'RESPONSE_TOO_LARGE', 'TLS_VERIFICATION_FAILED', 'RATE_LIMITED', 'HTTP_FORBIDDEN',
  'REDIRECT_REFUSED', 'HTTP_SERVER_ERROR', 'RPC_TRANSPORT_ERROR', 'INVALID_RPC_RESPONSE', 'RPC_RANGE_LIMIT',
  'REQUEST_BUDGET_EXHAUSTED', 'RUN_DEADLINE_EXHAUSTED', 'WRONG_CHAIN', 'FINALIZED_HEAD_BEHIND_CHECKPOINT',
  'CHECKPOINT_HASH_CHANGED', 'CHECKPOINT_TIME_CHANGED', 'IMPLEMENTATION_CHANGED', 'RUNTIME_CODE_CHANGED',
  'IMPLEMENTATION_CODE_CHANGED', 'IMPLEMENTATION_UPGRADE_IN_RANGE', 'EVENT_DECODE_FAILED', 'UNKNOWN_EVENT',
  'INVALID_LOG', 'LOG_OUTSIDE_RANGE', 'CONFLICTING_EVENT', 'DUPLICATE_LOG', 'RECEIPT_MISMATCH',
  'BLOCK_HASH_MISMATCH', 'APPEND_PARENT_MISMATCH', 'SOURCE_QUARANTINED', 'SINGLE_BLOCK_EVENT_LIMIT', 'INDEXER_FAILED']);

type Row = Record<string, unknown>;
export type StoreOptions = { readOnly?: boolean; clock?: () => Date };

export function defaultDatabasePath(repositoryRoot = process.cwd()): string {
  // This is external mutable runtime storage, never a bundled deployment asset.
  return join(resolve(/* turbopackIgnore: true */ repositoryRoot), '.local', 'indexer.sqlite');
}

function integer(value: unknown): string {
  if (typeof value !== 'string' || value.length > 78 || !INTEGER.test(value)
      || BigInt(value) >= 2n ** 256n) throw new StorageError('INVALID_RANGE');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new StorageError('INVALID_RANGE');
  return value.toLowerCase();
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new StorageError('INVALID_TIME');
  }
  return new Date(value).toISOString();
}
function parsed(value: unknown): ObservationSet {
  const result = ObservationSetSchema.safeParse(value);
  if (!result.success) throw new StorageError('INVALID_OBSERVATION', 'The indexed observation set could not be validated.');
  return result.data;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safeCode(code: string | undefined): string { return code && ERROR_CODES.has(code) ? code : 'INDEXING_FAILED'; }

/** Durable local reference store; a SQLite file is never a Vercel persistence layer. */
export class SQLiteStore {
  private db!: DatabaseSync;
  private readonly clock: () => Date;
  private readonly readOnly: boolean;

  constructor(path: string, options: StoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.readOnly = options.readOnly === true;
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new StorageError('INVALID_PATH');
    if (this.readOnly && !existsSync(path)) throw new StorageError('SOURCE_UNAVAILABLE');
    try {
      if (!this.readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path, { readOnly: this.readOnly });
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      if (!this.readOnly) {
        chmodSync(path, 0o600);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        this.migrate();
      }
      const version = this.db.prepare('PRAGMA user_version').get() as Row;
      if (version.user_version !== SCHEMA_VERSION) throw new StorageError('SCHEMA_MISMATCH');
    } catch (error) {
      try { this.db!.close(); } catch { /* Constructor failed before opening. */ }
      if (error instanceof StorageError) throw error;
      throw new StorageError('SOURCE_UNAVAILABLE');
    }
  }

  private migrate() {
    const version = this.db.prepare('PRAGMA user_version').get() as Row;
    if (version.user_version === SCHEMA_VERSION) return;
    if (version.user_version === 1) {
      this.db.exec('BEGIN IMMEDIATE; ALTER TABLE checkpoints ADD COLUMN retry_after_seconds INTEGER; ALTER TABLE checkpoints ADD COLUMN next_retry_at TEXT; PRAGMA user_version=2; COMMIT;');
      return;
    }
    if (version.user_version !== 0) throw new StorageError('SCHEMA_MISMATCH');
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE snapshots(id TEXT PRIMARY KEY, generation INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL,
        finance_to TEXT NOT NULL, network_to TEXT NOT NULL, valid INTEGER NOT NULL CHECK(valid IN (0,1)));
      CREATE TABLE checkpoints(domain TEXT PRIMARY KEY CHECK(domain IN ('finance','network')), chain_id INTEGER NOT NULL,
        from_block TEXT NOT NULL, to_block TEXT NOT NULL, block_hash TEXT NOT NULL, to_time TEXT NOT NULL,
        observed_at TEXT NOT NULL, quarantined INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT, last_success_at TEXT, last_outcome TEXT, last_error_code TEXT,
        target_finalized_block TEXT, source_as_of TEXT, as_observed_at TEXT,
        retry_after_seconds INTEGER, next_retry_at TEXT);
      CREATE TABLE leases(domain TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, expires_ms INTEGER NOT NULL);
      CREATE TABLE events(domain TEXT NOT NULL, id TEXT NOT NULL, contract_address TEXT NOT NULL,
        transaction_hash TEXT NOT NULL, log_index TEXT NOT NULL, block_number TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(domain,id), UNIQUE(domain,contract_address,transaction_hash,log_index));
      CREATE TABLE ranges(domain TEXT NOT NULL, from_block TEXT NOT NULL, to_block TEXT NOT NULL,
        to_hash TEXT NOT NULL, to_time TEXT NOT NULL, observed_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('seed','range')),
        PRIMARY KEY(domain,from_block,to_block));
      PRAGMA user_version=2;
      COMMIT;`);
  }

  private now(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new StorageError('INVALID_TIME');
    return now;
  }
  private writable() { if (this.readOnly) throw new StorageError('READ_ONLY'); }
  private transaction<T>(action: () => T, write = true): T {
    if (write) this.writable();
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the safe original error. */ }
      if (error instanceof StorageError) throw error;
      throw new StorageError('SOURCE_UNAVAILABLE');
    }
  }
  private metadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }
  private setMetadata(key: string, value: string) {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  private checkpointRow(domain: Domain): Row {
    if (!DOMAINS.includes(domain)) throw new StorageError('INVALID_DOMAIN');
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE domain=?').get(domain) as Row | undefined;
    if (!row) throw new StorageError('NOT_INITIALIZED');
    return row;
  }
  private checkpoint(row: Row): Checkpoint {
    return { domain: row.domain as Domain, chainId: Number(row.chain_id) as 56 | 8453,
      fromBlock: String(row.from_block), toBlock: String(row.to_block), nextBlock: String(BigInt(String(row.to_block)) + 1n),
      blockHash: String(row.block_hash), toTime: String(row.to_time), observedAt: String(row.observed_at), quarantined: row.quarantined === 1,
      nextRetryAt: row.next_retry_at as string | null };
  }
  getCheckpoint(domain: Domain): Checkpoint { return this.checkpoint(this.checkpointRow(domain)); }
  private lease(domain: Domain, token: string) {
    const row = this.db.prepare('SELECT * FROM leases WHERE domain=? AND token=?').get(domain, token) as Row | undefined;
    if (!row || Number(row.expires_ms) <= this.now().getTime()) throw new StorageError('LEASE_LOST');
  }
  private currentSnapshot(allowQuarantined = false): ObservationSet {
    if (!allowQuarantined && this.db.prepare('SELECT domain FROM checkpoints WHERE quarantined=1 LIMIT 1').get()) {
      throw new StorageError('SOURCE_QUARANTINED', 'Indexed observations are paused while source consistency is reviewed.');
    }
    const id = this.metadata('current_snapshot');
    if (!id) throw new StorageError('NOT_INITIALIZED');
    const row = this.db.prepare('SELECT payload,valid FROM snapshots WHERE id=?').get(id) as Row | undefined;
    if (!row || (!allowQuarantined && row.valid !== 1)) throw new StorageError('SOURCE_UNAVAILABLE');
    try { return parsed(JSON.parse(String(row.payload))); }
    catch { throw new StorageError('SOURCE_UNAVAILABLE'); }
  }
  private publish(snapshot: ObservationSet): ObservationSet {
    const generation = Number(this.metadata('generation') ?? '0') + 1;
    const { snapshotId: _old, generatedAt: _generated, ...core } = snapshot;
    const result = parsed({ ...core, snapshotId: digest({ generation, observation: core }), generatedAt: this.now().toISOString() });
    this.db.prepare('INSERT INTO snapshots(id,generation,payload,finance_to,network_to,valid) VALUES (?,?,?,?,?,1)')
      .run(result.snapshotId, generation, JSON.stringify(result), result.finance.coverage.toBlock, result.network.coverage.toBlock);
    this.setMetadata('generation', String(generation)); this.setMetadata('current_snapshot', result.snapshotId);
    return result;
  }

  initialize(input: ObservationSet, anchors: { finance: string; network: string }): boolean {
    const snapshot = parsed(input);
    const hashes = { finance: hash(anchors.finance), network: hash(anchors.network) };
    return this.transaction(() => {
      const existing = this.metadata('seed_snapshot');
      if (existing) {
        if (existing !== snapshot.snapshotId) throw new StorageError('SEED_MISMATCH');
        for (const domain of DOMAINS) {
          const anchor = this.db.prepare('SELECT to_hash FROM ranges WHERE domain=? AND kind=?').get(domain, 'seed') as Row | undefined;
          if (!anchor || anchor.to_hash !== hashes[domain]) throw new StorageError('ANCHOR_MISMATCH');
        }
        return false;
      }
      for (const domain of DOMAINS) {
        const coverage = snapshot[domain].coverage;
        this.db.prepare('INSERT INTO checkpoints(domain,chain_id,from_block,to_block,block_hash,to_time,observed_at) VALUES (?,?,?,?,?,?,?)')
          .run(domain, coverage.chainId, coverage.fromBlock, coverage.toBlock, hashes[domain], coverage.toTime, coverage.observedAt);
        this.db.prepare('INSERT INTO ranges(domain,from_block,to_block,to_hash,to_time,observed_at,fingerprint,kind) VALUES (?,?,?,?,?,?,?,?)')
          .run(domain, coverage.fromBlock, coverage.toBlock, hashes[domain], coverage.toTime, coverage.observedAt, snapshot.snapshotId, 'seed');
        for (const event of snapshot[domain].events) this.insertEvent(domain, event);
      }
      this.db.prepare('INSERT INTO snapshots(id,generation,payload,finance_to,network_to,valid) VALUES (?,?,?,?,?,1)')
        .run(snapshot.snapshotId, 0, JSON.stringify(snapshot), snapshot.finance.coverage.toBlock, snapshot.network.coverage.toBlock);
      this.setMetadata('seed_snapshot', snapshot.snapshotId); this.setMetadata('generation', '0');
      this.setMetadata('current_snapshot', snapshot.snapshotId);
      return true;
    });
  }
  private insertEvent(domain: Domain, event: ObservationSet['finance']['events'][number] | ObservationSet['network']['events'][number]) {
    this.db.prepare('INSERT INTO events(domain,id,contract_address,transaction_hash,log_index,block_number,payload) VALUES (?,?,?,?,?,?,?)')
      .run(domain, event.id, event.contractAddress.toLowerCase(), event.transactionHash.toLowerCase(), event.logIndex, event.blockNumber, JSON.stringify(event));
  }

  acquireLease(domain: Domain, owner: string, ttlMs = 60_000): Lease | null {
    if (!DOMAINS.includes(domain) || typeof owner !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(owner)
      || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600_000) throw new StorageError('INVALID_LEASE');
    return this.transaction(() => {
      this.checkpointRow(domain);
      const now = this.now().getTime();
      const row = this.db.prepare('SELECT expires_ms FROM leases WHERE domain=?').get(domain) as Row | undefined;
      if (row && Number(row.expires_ms) > now) return null;
      const token = randomUUID(); const expires = now + ttlMs;
      this.db.prepare('INSERT INTO leases(domain,token,owner,expires_ms) VALUES (?,?,?,?) ON CONFLICT(domain) DO UPDATE SET token=excluded.token,owner=excluded.owner,expires_ms=excluded.expires_ms')
        .run(domain, token, owner, expires);
      return { domain, token, owner, expiresAt: new Date(expires).toISOString() };
    });
  }
  renewLease(token: string, ttlMs = 60_000): Lease {
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600_000) throw new StorageError('INVALID_LEASE');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM leases WHERE token=?').get(token) as Row | undefined;
      if (!row) throw new StorageError('LEASE_LOST');
      this.lease(row.domain as Domain, token);
      const expires = this.now().getTime() + ttlMs;
      this.db.prepare('UPDATE leases SET expires_ms=? WHERE token=?').run(expires, token);
      return { domain: row.domain as Domain, token, owner: String(row.owner), expiresAt: new Date(expires).toISOString() };
    });
  }
  releaseLease(token: string): void {
    this.writable(); this.db.prepare('DELETE FROM leases WHERE token=?').run(token);
  }

  commitRange(domain: Domain, token: string, input: CompletedRange): { snapshotId: string; checkpoint: Checkpoint; insertedEvents: number; idempotent: boolean } {
    const from = integer(input.fromBlock), to = integer(input.toBlock);
    const previousHash = hash(input.previousBlockHash), toHash = hash(input.toBlockHash);
    const toTime = instant(input.toTime), observedAt = instant(input.observedAt);
    if (BigInt(from) > BigInt(to) || Date.parse(observedAt) > this.now().getTime() + 30_000) throw new StorageError('INVALID_RANGE');
    if (!Array.isArray(input.events) || input.events.length > 100_000) throw new StorageError('CAPACITY_EXCEEDED');
    const fingerprint = digest({ domain, from, to, previousHash, toHash, toTime, events: input.events });
    return this.transaction(() => {
      this.lease(domain, token);
      const checkpoint = this.getCheckpoint(domain);
      if (checkpoint.quarantined) throw new StorageError('SOURCE_QUARANTINED');
      const prior = this.db.prepare('SELECT fingerprint FROM ranges WHERE domain=? AND from_block=? AND to_block=?').get(domain, from, to) as Row | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new StorageError('RANGE_CONFLICT');
        return { snapshotId: this.currentSnapshot().snapshotId, checkpoint, insertedEvents: 0, idempotent: true };
      }
      if (from !== checkpoint.nextBlock || previousHash !== checkpoint.blockHash) throw new StorageError('CHECKPOINT_MISMATCH');
      if (Date.parse(toTime) < Date.parse(checkpoint.toTime) || Date.parse(observedAt) < Date.parse(checkpoint.observedAt)) {
        throw new StorageError('INVALID_TIME');
      }
      const snapshot = this.currentSnapshot();
      if (!Array.isArray(input.events) || snapshot[domain].events.length + input.events.length > 100_000) throw new StorageError('CAPACITY_EXCEEDED');
      for (const event of input.events) {
        const block = BigInt(integer(event.blockNumber));
        if (block < BigInt(from) || block > BigInt(to)) throw new StorageError('INVALID_RANGE');
      }
      const candidate = structuredClone(snapshot);
      candidate[domain].coverage = { ...candidate[domain].coverage, toBlock: to, toTime, observedAt, completeForRegisteredContracts: true };
      // The domain union is validated as a whole before any event can be persisted.
      (candidate[domain].events as unknown[]) = [...candidate[domain].events, ...input.events];
      candidate.generatedAt = this.now().toISOString();
      const validated = parsed(candidate);
      for (const event of input.events) this.insertEvent(domain, event);
      this.db.prepare('INSERT INTO ranges(domain,from_block,to_block,to_hash,to_time,observed_at,fingerprint,kind) VALUES (?,?,?,?,?,?,?,?)')
        .run(domain, from, to, toHash, toTime, observedAt, fingerprint, 'range');
      this.db.prepare('UPDATE checkpoints SET to_block=?,block_hash=?,to_time=?,observed_at=? WHERE domain=?')
        .run(to, toHash, toTime, observedAt, domain);
      const published = this.publish(validated);
      return { snapshotId: published.snapshotId, checkpoint: this.getCheckpoint(domain), insertedEvents: input.events.length, idempotent: false };
    });
  }

  recordRun(domain: Domain, token: string, input: RunRecord): void {
    if (!['idle', 'advanced', 'failed'].includes(input.outcome)) throw new StorageError('INVALID_RUN');
    const at = instant(input.at);
    const target = input.targetFinalizedBlock === undefined ? null : integer(input.targetFinalizedBlock);
    const sourceAsOf = input.sourceAsOf === undefined ? null : instant(input.sourceAsOf);
    if ((target === null) !== (sourceAsOf === null) || Date.parse(at) > this.now().getTime() + 30_000) throw new StorageError('INVALID_RUN');
    const retry = input.retryAfterSeconds ?? null;
    if (retry !== null && (input.outcome !== 'failed' || !Number.isInteger(retry) || retry < 0 || retry > 86_400)) throw new StorageError('INVALID_RUN');
    this.transaction(() => {
      this.lease(domain, token);
      const row = this.checkpointRow(domain);
      if (row.last_attempt_at && Date.parse(at) < Date.parse(String(row.last_attempt_at))) throw new StorageError('INVALID_TIME');
      this.db.prepare(`UPDATE checkpoints SET last_attempt_at=?,last_success_at=?,last_outcome=?,last_error_code=?,
        target_finalized_block=COALESCE(?,target_finalized_block),source_as_of=COALESCE(?,source_as_of),
        as_observed_at=CASE WHEN ? IS NULL THEN as_observed_at ELSE ? END,retry_after_seconds=?,next_retry_at=? WHERE domain=?`)
        .run(at, input.outcome === 'failed' ? (row.last_success_at as string | null) : at,
          input.outcome, input.outcome === 'failed' ? safeCode(input.code) : null, target, sourceAsOf, target, at,
          retry, retry === null ? null : new Date(Date.parse(at) + retry * 1000).toISOString(), domain);
    });
  }

  quarantine(domain: Domain, token: string, code = 'REORG_DETECTED'): void {
    this.transaction(() => {
      this.lease(domain, token); this.checkpointRow(domain);
      this.db.prepare('UPDATE checkpoints SET quarantined=1,last_attempt_at=?,last_outcome=?,last_error_code=? WHERE domain=?')
        .run(this.now().toISOString(), 'failed', safeCode(code), domain);
      this.db.prepare('UPDATE snapshots SET valid=0').run();
    });
  }

  rollback(domain: Domain, token: string, toBlock: string, blockHash: string, toTime: string): { snapshotId: string; checkpoint: Checkpoint } {
    integer(toBlock); const targetHash = hash(blockHash), targetTime = instant(toTime);
    const target = this.db.prepare('SELECT * FROM ranges WHERE domain=? AND to_block=?').get(domain, toBlock) as Row | undefined;
    if (!target) {
      this.quarantine(domain, token, 'REORG_BELOW_CHECKPOINT');
      throw new StorageError('REORG_BELOW_CHECKPOINT', 'Recovery requires a previously verified range boundary.');
    }
    return this.transaction(() => {
      this.lease(domain, token);
      const checkpoint = this.getCheckpoint(domain);
      if (BigInt(toBlock) > BigInt(checkpoint.toBlock) || target.to_hash !== targetHash || target.to_time !== targetTime) {
        throw new StorageError('CHECKPOINT_MISMATCH');
      }
      const candidate = this.currentSnapshot(true);
      candidate[domain].events = candidate[domain].events.filter(event => BigInt(event.blockNumber) <= BigInt(toBlock)) as never;
      candidate[domain].stateSamples = candidate[domain].stateSamples.filter(sample => BigInt(sample.asOfBlock) <= BigInt(toBlock)) as never;
      if (domain === 'finance') candidate.finance.latencySamples = candidate.finance.latencySamples.filter(sample =>
        Date.parse(sample.finalizedAt) <= Date.parse(targetTime));
      const observedAt = this.now().toISOString();
      candidate[domain].coverage = { ...candidate[domain].coverage, toBlock, toTime: targetTime, observedAt };
      candidate.generatedAt = observedAt;
      const valid = parsed(candidate);
      // Block identifiers are decimal TEXT; comparisons must use BigInt, never SQL lexical ordering.
      for (const event of this.db.prepare('SELECT id,block_number FROM events WHERE domain=?').all(domain) as Row[]) {
        if (BigInt(String(event.block_number)) > BigInt(toBlock)) this.db.prepare('DELETE FROM events WHERE domain=? AND id=?').run(domain, String(event.id));
      }
      for (const range of this.db.prepare('SELECT from_block,to_block FROM ranges WHERE domain=?').all(domain) as Row[]) {
        if (BigInt(String(range.to_block)) > BigInt(toBlock)) this.db.prepare('DELETE FROM ranges WHERE domain=? AND from_block=? AND to_block=?').run(domain, String(range.from_block), String(range.to_block));
      }
      for (const snapshot of this.db.prepare('SELECT id,finance_to,network_to FROM snapshots').all() as Row[]) {
        if (BigInt(String(snapshot[domain === 'finance' ? 'finance_to' : 'network_to'])) > BigInt(toBlock)) {
          this.db.prepare('UPDATE snapshots SET valid=0 WHERE id=?').run(String(snapshot.id));
        }
      }
      this.db.prepare('UPDATE checkpoints SET to_block=?,block_hash=?,to_time=?,observed_at=?,quarantined=0 WHERE domain=?')
        .run(toBlock, targetHash, targetTime, observedAt, domain);
      const published = this.publish(valid);
      return { snapshotId: published.snapshotId, checkpoint: this.getCheckpoint(domain) };
    });
  }

  private status(): IndexerStatus {
    const id = this.metadata('current_snapshot');
    const domains = (this.db.prepare('SELECT * FROM checkpoints ORDER BY domain').all() as Row[]).map(row => {
      const checkpoint = this.checkpoint(row);
      const target = row.target_finalized_block === null ? null : String(row.target_finalized_block);
      return { ...checkpoint, lastAttemptAt: row.last_attempt_at as string | null, lastSuccessAt: row.last_success_at as string | null,
        lastOutcome: row.last_outcome as DomainStatus['lastOutcome'], lastErrorCode: row.last_error_code as string | null,
        targetFinalizedBlock: target, sourceAsOf: row.source_as_of as string | null,
        lagBlocks: target === null ? null : String(BigInt(target) > BigInt(checkpoint.toBlock) ? BigInt(target) - BigInt(checkpoint.toBlock) : 0n),
        asObservedAt: row.as_observed_at as string | null,
        retryAfterSeconds: row.retry_after_seconds as number | null } satisfies DomainStatus;
    });
    return { storage: 'sqlite', publication: !id ? 'empty' : domains.some(domain => domain.quarantined) ? 'quarantined' : 'available', snapshotId: id, domains };
  }
  getStatus(): IndexerStatus { return this.transaction(() => this.status(), false); }
  readServingState(): ServingState {
    return this.transaction(() => ({ snapshot: this.currentSnapshot(), status: this.status() }), false);
  }
  readSnapshot(): ObservationSet { return this.readServingState().snapshot; }

  /** Worker-only transfer: includes the last validated facts during quarantine. */
  exportPublication(collector: HostedPublication['collector'] = { mode: 'manual', intervalMinutes: null, runUrl: null }): HostedPublication {
    return this.transaction(() => validatePublication({ schemaVersion: '1.0.0',
      snapshot: this.currentSnapshot(true), checkpoints: this.status().domains, collector }), false);
  }

  /** Restore a published checkpoint into a fresh, private job-local database. */
  restorePublication(input: HostedPublication): void {
    const value = validatePublication(input);
    if (this.getStatus().publication !== 'empty') throw new StorageError('ALREADY_INITIALIZED');
    const byDomain = (domain: Domain) => value.checkpoints.find(c => c.domain === domain)!;
    this.initialize(value.snapshot, { finance: byDomain('finance').blockHash, network: byDomain('network').blockHash });
    this.transaction(() => {
      for (const c of value.checkpoints) {
        this.db.prepare(`UPDATE checkpoints SET quarantined=?,last_attempt_at=?,last_success_at=?,last_outcome=?,
          last_error_code=?,target_finalized_block=?,source_as_of=?,as_observed_at=?,retry_after_seconds=?,next_retry_at=? WHERE domain=?`)
          .run(c.quarantined ? 1 : 0, c.lastAttemptAt, c.lastSuccessAt, c.lastOutcome, c.lastErrorCode,
            c.targetFinalizedBlock, c.sourceAsOf, c.asObservedAt, c.retryAfterSeconds, c.nextRetryAt, c.domain);
      }
      if (value.checkpoints.some(c => c.quarantined)) this.db.prepare('UPDATE snapshots SET valid=0').run();
    });
  }
  close(): void { this.db.close(); }
}
