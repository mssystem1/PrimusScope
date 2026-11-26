import { expect, it } from 'vitest';
import { recordCollectorFailure, readCollectorFailure, type CollectorStatusTransport } from './collector-status';

it('stores only an allowlisted code and date and never lets an older failure replace a newer one', async () => {
  let bytes: Uint8Array | null = null, writes = 0;
  const transport: CollectorStatusTransport = {
    async read() { return bytes ? { etag: String(writes), bytes } : null; },
    async write(value) { bytes = value; writes++; },
  };
  const now = Date.parse('2026-11-26T16:00:00.000Z');
  await recordCollectorFailure('CAPACITY_EXCEEDED', { transport, now: () => now });
  await recordCollectorFailure('https://private.invalid/?token=never-log', { transport, now: () => now - 1000 });
  expect(writes).toBe(1);
  expect(await readCollectorFailure({ transport })).toEqual({ version: 1,
    failedAt: '2026-11-26T16:00:00.000Z', code: 'CAPACITY_EXCEEDED' });
  await recordCollectorFailure('https://private.invalid/?token=never-log', { transport, now: () => now + 1000 });
  expect(await readCollectorFailure({ transport })).toEqual({ version: 1,
    failedAt: '2026-11-26T16:00:01.000Z', code: 'COLLECTION_FAILED' });
  expect(new TextDecoder().decode(bytes!)).not.toContain('private');
});

it('rejects oversized or extra-field status instead of exposing arbitrary provider payloads', async () => {
  for (const body of ['x'.repeat(1025), JSON.stringify({ version: 1,
    failedAt: '2026-11-26T16:00:00.000Z', code: 'CAPACITY_EXCEEDED', payload: 'private' })]) {
    const transport: CollectorStatusTransport = { async read() { return { etag: '1', bytes: new TextEncoder().encode(body) }; }, async write() {} };
    await expect(readCollectorFailure({ transport })).rejects.toThrow('STATUS_UNAVAILABLE');
  }
});
