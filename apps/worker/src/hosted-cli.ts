import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageError } from '@primusscope/storage';
import { neonClient, PostgresPublicationStore } from '@primusscope/storage/postgres';
import { collectHosted } from './hosted';

export async function main(command = process.argv[2]) {
  if (command !== 'once' && command !== 'status') throw new StorageError('INVALID_COMMAND');
  const connection = process.env.WORKER_DATABASE_URL;
  if (!connection) throw new StorageError('DATABASE_NOT_CONFIGURED');
  const store = new PostgresPublicationStore(neonClient(connection), command === 'status');
  if (command === 'status') {
    const state = await store.read();
    process.stdout.write(JSON.stringify({ initialized: !!state, revision: state?.revision,
      checkpoints: state?.publication.checkpoints.map(c => ({ domain: c.domain, toBlock: c.toBlock,
        lagBlocks: c.lagBlocks, lastOutcome: c.lastOutcome, quarantined: c.quarantined })) }) + '\n');
    return;
  }
  const result = await collectHosted({ store, collector: {
    mode: 'manual', provider: 'manual', intervalMinutes: null, runUrl: null,
  } });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.outcome === 'partial') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stdout.write(JSON.stringify({ outcome: 'failed', code: error instanceof StorageError ? error.code : 'INDEXER_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}
