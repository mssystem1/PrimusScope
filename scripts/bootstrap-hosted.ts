import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore, StorageError } from '@primusscope/storage';
import { neonClient, PostgresPublicationStore } from '@primusscope/storage/postgres';
import { configureRuntimeRoles } from '@primusscope/storage/roles';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../data/observations/current.json';
import { seedAnchors } from '../apps/worker/src/indexer';
import { CurlRpc, DEFAULT_RPC_LIMITS } from '../apps/worker/src/rpc';
import { sourceFor, WorkerError } from '../apps/worker/src/registry';

/** Run from repository root. Both credential files are ignored and never printed. */
async function main() {
  const adminFile = '.local/neon-admin.env', runtimeFile = '.local/hosted-credentials.env';
  if (!existsSync(adminFile)) throw new StorageError('ADMIN_CREDENTIALS_NOT_CONFIGURED');
  chmodSync(adminFile, 0o600); process.loadEnvFile(adminFile);
  const admin = process.env.DATABASE_URL;
  if (!admin) throw new StorageError('ADMIN_CREDENTIALS_NOT_CONFIGURED');
  const client = neonClient(admin);
  if (!existsSync(runtimeFile)) {
    const connection = (role: string) => {
      const url = new URL(admin); url.username = role; url.password = randomBytes(32).toString('base64url');
      return url.href;
    };
    const values = { WEB_DATABASE_URL: connection('primusscope_web'),
      WORKER_DATABASE_URL: connection('primusscope_worker'), CRON_SECRET: randomBytes(32).toString('base64url') };
    writeFileSync(runtimeFile, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n',
      { mode: 0o600, flag: 'wx' });
  }
  chmodSync(runtimeFile, 0o600); process.loadEnvFile(runtimeFile);
  const web = process.env.WEB_DATABASE_URL!, worker = process.env.WORKER_DATABASE_URL!;
  if ([web, worker].some(value => new URL(value).host !== new URL(admin).host
    || new URL(value).pathname !== new URL(admin).pathname)) throw new StorageError('DATABASE_RESOURCE_MISMATCH');
  const store = new PostgresPublicationStore(client); await store.migrate();
  await configureRuntimeRoles(client, new URL(web).password, new URL(worker).password);
  const runtime = new PostgresPublicationStore(neonClient(worker));
  if (!await runtime.read()) {
    const snapshot = ObservationSetSchema.parse(recorded);
    const anchors = await seedAnchors(snapshot, domain => new CurlRpc(sourceFor(domain, snapshot).endpoint,
      { ...DEFAULT_RPC_LIMITS, maxRequests: 200, maxSeconds: 180 }));
    const directory = mkdtempSync(join(tmpdir(), 'primusscope-bootstrap-'));
    const local = new SQLiteStore(join(directory, 'seed.sqlite'));
    try { local.initialize(snapshot, anchors); await runtime.initialize(local.exportPublication()); }
    finally { local.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  const webClient = neonClient(web), readable = await new PostgresPublicationStore(webClient, true).read();
  if (!readable) throw new StorageError('NOT_INITIALIZED');
  const privileges = await webClient.query(`SELECT
    has_table_privilege(current_user,'primusscope.publication','SELECT') AS readable,
    has_table_privilege(current_user,'primusscope.publication','UPDATE') AS writable,
    has_table_privilege(current_user,'primusscope.collector_lease','SELECT') AS lease_access`);
  const row = privileges.rows[0];
  if (!row?.readable || row.writable || row.lease_access) throw new StorageError('UNSAFE_RUNTIME_PRIVILEGES');
  process.stdout.write(JSON.stringify({ outcome: 'ready', revision: readable.revision, webReadOnly: true,
    credentialsFile: runtimeFile }) + '\n');
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ outcome: 'failed', code: error instanceof StorageError || error instanceof WorkerError
    ? error.code : 'BOOTSTRAP_FAILED' }) + '\n'); process.exitCode = 1;
});
