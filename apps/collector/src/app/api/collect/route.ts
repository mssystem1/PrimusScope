import { timingSafeEqual } from 'node:crypto';
import { collectHosted } from '@primusscope/worker/hosted';
import { FetchRpc } from '@primusscope/worker/fetch-rpc';
import { StorageError } from '@primusscope/storage';
import { neonClient, PostgresPublicationStore } from '@primusscope/storage/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization') ?? '';
  const expected = secret ? Buffer.from('Bearer ' + secret) : Buffer.alloc(0);
  const actual = Buffer.from(authorization);
  const headers = { 'Cache-Control': 'no-store' };
  if (!secret || secret.length < 40 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ code: 'UNAUTHORIZED' }, { status: 401, headers });
  }
  if (new URL(request.url).search) return Response.json({ code: 'INVALID_REQUEST' }, { status: 400, headers });
  const connection = process.env.WORKER_DATABASE_URL;
  if (!connection) return Response.json({ code: 'DATABASE_NOT_CONFIGURED' }, { status: 503, headers });
  const started = Date.now();
  try {
    const store = new PostgresPublicationStore(neonClient(connection));
    const result = await collectHosted({ store,
      collector: { mode: 'scheduled', provider: 'vercel_cron', intervalMinutes: 15, runUrl: null },
      rpcFor: domain => new FetchRpc(domain === 'finance' ? 'https://bsc-rpc.publicnode.com' : 'https://base-rpc.publicnode.com', {
        maxRequests: 600, maxSeconds: Math.max(15, Math.min(220, Math.floor((240_000 - (Date.now() - started)) / 1000))),
        timeoutSeconds: 10, maxResponseBytes: 2_000_000, minIntervalMs: 350,
      }),
    });
    return Response.json(result, { status: result.outcome === 'partial' ? 207 : 200, headers });
  } catch (error) {
    return Response.json({ code: error instanceof StorageError ? error.code : 'COLLECTION_FAILED' }, { status: 503, headers });
  }
}
