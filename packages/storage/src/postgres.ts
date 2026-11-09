import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { StorageError } from './errors';
import { validatePublication, type HostedPublication } from './publication';

export type SqlResult = { rows: Record<string, unknown>[] };
export interface SqlClient { query(text: string, values?: unknown[]): Promise<SqlResult> }
export type PublishedState = { revision: string; publication: HostedPublication };

const migration = [
  'CREATE SCHEMA IF NOT EXISTS primusscope',
  `CREATE TABLE IF NOT EXISTS primusscope.publication (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0), seed_snapshot_id text NOT NULL,
    state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE IF NOT EXISTS primusscope.collector_lease (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), token text NOT NULL,
    owner text NOT NULL, expires_at timestamptz NOT NULL)`,
  'REVOKE ALL ON SCHEMA primusscope FROM PUBLIC',
  'REVOKE ALL ON ALL TABLES IN SCHEMA primusscope FROM PUBLIC',
];

/** HTTPS transport; connection strings never enter returned errors or reports. */
export function neonClient(connectionString: string): SqlClient {
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech')
      || !url.username || !url.password) throw new Error();
    const sql = neon(connectionString, { fullResults: true });
    return { async query(text, values = []) {
      try { const result = await sql.query(text, values); return { rows: result.rows as Record<string, unknown>[] }; }
      catch { throw new StorageError('DATABASE_UNAVAILABLE'); }
    } };
  } catch { throw new StorageError('INVALID_DATABASE_CONFIGURATION'); }
}

/** One current publication, with a database-clock lease and fenced atomic replacement. */
export class PostgresPublicationStore {
  constructor(private readonly client: SqlClient, private readonly readOnly = false) {}
  private writable() { if (this.readOnly) throw new StorageError('READ_ONLY'); }
  async migrate(): Promise<void> {
    this.writable();
    for (const statement of migration) await this.client.query(statement);
  }
  async read(): Promise<PublishedState | null> {
    const result = await this.client.query('SELECT revision::text, state FROM primusscope.publication WHERE singleton=true');
    const row = result.rows[0];
    return row ? { revision: String(row.revision), publication: validatePublication(row.state) } : null;
  }
  async revision(): Promise<string | null> {
    const result = await this.client.query('SELECT revision::text FROM primusscope.publication WHERE singleton=true');
    return result.rows[0] ? String(result.rows[0].revision) : null;
  }
  async initialize(input: HostedPublication): Promise<boolean> {
    this.writable(); const publication = validatePublication(input);
    const result = await this.client.query(`INSERT INTO primusscope.publication(singleton,seed_snapshot_id,state)
      VALUES(true,$1,$2::jsonb) ON CONFLICT(singleton) DO NOTHING RETURNING revision`,
      [publication.snapshot.snapshotId, JSON.stringify(publication)]);
    if (result.rows.length) return true;
    const existing = await this.client.query('SELECT seed_snapshot_id FROM primusscope.publication WHERE singleton=true');
    if (existing.rows[0]?.seed_snapshot_id !== publication.snapshot.snapshotId) throw new StorageError('SEED_MISMATCH');
    return false;
  }
  async acquireLease(owner: string, seconds = 600): Promise<string | null> {
    this.writable();
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(owner) || !Number.isInteger(seconds) || seconds < 30 || seconds > 600) {
      throw new StorageError('INVALID_LEASE');
    }
    const token = randomUUID();
    const result = await this.client.query(`INSERT INTO primusscope.collector_lease(singleton,token,owner,expires_at)
      VALUES(true,$1,$2,clock_timestamp()+$3::integer*interval '1 second')
      ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,owner=excluded.owner,expires_at=excluded.expires_at
      WHERE collector_lease.expires_at <= clock_timestamp() RETURNING token`, [token, owner, seconds]);
    return result.rows.length ? token : null;
  }
  async renewLease(token: string, seconds = 600): Promise<void> {
    this.writable();
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new StorageError('INVALID_LEASE');
    const result = await this.client.query(`UPDATE primusscope.collector_lease
      SET expires_at=clock_timestamp()+$2::integer*interval '1 second'
      WHERE singleton=true AND token=$1 AND expires_at > clock_timestamp() RETURNING token`, [token, seconds]);
    if (!result.rows.length) throw new StorageError('LEASE_LOST');
  }
  async publish(token: string, expectedRevision: string, input: HostedPublication): Promise<string> {
    this.writable(); const publication = validatePublication(input);
    if (!/^(0|[1-9][0-9]{0,18})$/.test(expectedRevision)) throw new StorageError('INVALID_REVISION');
    const result = await this.client.query(`WITH permitted AS (
      SELECT token FROM primusscope.collector_lease
      WHERE singleton=true AND token=$1 AND expires_at > clock_timestamp() FOR UPDATE
    ) UPDATE primusscope.publication SET state=$3::jsonb,revision=revision+1,updated_at=clock_timestamp()
      WHERE singleton=true AND revision=$2::bigint AND EXISTS(SELECT 1 FROM permitted)
      RETURNING revision::text`, [token, expectedRevision, JSON.stringify(publication)]);
    if (!result.rows.length) throw new StorageError('PUBLICATION_CONFLICT');
    return String(result.rows[0]!.revision);
  }
  async releaseLease(token: string): Promise<void> {
    this.writable(); await this.client.query('DELETE FROM primusscope.collector_lease WHERE singleton=true AND token=$1', [token]);
  }
}
