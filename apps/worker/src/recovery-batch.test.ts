import { expect, it, vi } from 'vitest';
import { recoverIndexer } from './recovery-batch';

function response(remaining: string, extra = {}) {
  return { status: 200, body: { outcome: 'partial', revision: '122', reports: [
    ...['finance', 'network'].map(domain => ({ domain, outcome: 'advanced', remainingBlocks: remaining,
      committedRanges: 8, code: null, ...extra })),
    { domain: 'strategy', outcome: 'failed', code: 'FLOW_SUPPLY_RECONCILIATION_FAILED' },
  ] } };
}

it('clears successive ranges and stops only when both chain heads are reached despite a separate strategy issue', async () => {
  const invoke = vi.fn().mockResolvedValueOnce(response('80000')).mockResolvedValueOnce(response('40000'))
    .mockResolvedValueOnce(response('0')), report = vi.fn();
  expect(await recoverIndexer({ invoke, report })).toMatchObject({ outcome: 'caught_up', invocations: 3 });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(report.mock.calls[0][0]).toEqual({ invocation: 1, revision: '122',
    remaining: { finance: '80000', network: '80000' }, strategyIssue: true });
});

it('yields to a scheduled collector lease and resumes without concurrent writes', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ status: 200, body: { outcome: 'busy', reports: [] } })
    .mockResolvedValueOnce(response('0')), pause = vi.fn(async () => {});
  expect(await recoverIndexer({ invoke, pause })).toMatchObject({ outcome: 'caught_up', invocations: 2 });
  expect(pause).toHaveBeenCalledWith(30_000);
});

it('tolerates bounded initial deployment propagation but fails closed on a later authorization error', async () => {
  const invoke=vi.fn().mockResolvedValueOnce({status:401,body:{code:'UNAUTHORIZED'}})
    .mockResolvedValueOnce(response('0')),pause=vi.fn(async()=>{});
  expect(await recoverIndexer({invoke,pause})).toMatchObject({outcome:'caught_up'});
  expect(pause).toHaveBeenCalledWith(30_000);
  const later=vi.fn().mockResolvedValueOnce(response('100')).mockResolvedValueOnce({status:401,body:{code:'UNAUTHORIZED'}});
  expect(await recoverIndexer({invoke:later,pause})).toEqual({outcome:'failed',code:'COLLECTOR_REJECTED',status:401});
  expect(later).toHaveBeenCalledTimes(2);
});

it('continues a budget-limited job only after validated progress', async () => {
  const invoke = vi.fn().mockResolvedValueOnce(response('50000', { outcome: 'failed', code: 'RUN_DEADLINE_EXHAUSTED' }))
    .mockResolvedValueOnce(response('0'));
  expect(await recoverIndexer({ invoke })).toMatchObject({ outcome: 'caught_up', invocations: 2 });
});

it('stops at capacity, quarantine, provider cooldown or no progress instead of masking failure', async () => {
  for (const first of [{ status: 503, body: { code: 'CAPACITY_EXCEEDED', payload: 'private' } },
    response('100', { outcome: 'failed', code: 'CHECKPOINT_HASH_CHANGED' }),
    response('100', { outcome: 'failed', code: 'RATE_LIMITED', committedRanges: 0 }),
    response('100', { committedRanges: 0 })]) {
    const invoke = vi.fn().mockResolvedValue(first);
    expect((await recoverIndexer({ invoke })).outcome).not.toBe('caught_up');
    expect(invoke).toHaveBeenCalledTimes(1);
  }
});

it('enforces invocation and wall-clock budgets before starting another long request', async () => {
  const invoke = vi.fn().mockResolvedValue(response('1000000'));
  expect(await recoverIndexer({ invoke, maxInvocations: 2 })).toEqual({ outcome: 'incomplete', code: 'RECOVERY_INVOCATION_LIMIT' });
  expect(invoke).toHaveBeenCalledTimes(2);
  invoke.mockClear(); let clock = 0;
  invoke.mockImplementation(async () => { clock += 250_000; return response('1000000'); });
  expect(await recoverIndexer({ invoke, now: () => clock, budgetMs: 500_000 })).toEqual({ outcome: 'incomplete', code: 'RECOVERY_BUDGET_EXHAUSTED' });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('never logs transport exception content or arbitrary provider payloads', async () => {
  const report = vi.fn();
  const result = await recoverIndexer({ report, invoke: async () => { throw new Error('private-secret'); } });
  expect(result).toEqual({ outcome: 'failed', code: 'COLLECTOR_UNAVAILABLE' });
  expect(report).not.toHaveBeenCalled();
});
