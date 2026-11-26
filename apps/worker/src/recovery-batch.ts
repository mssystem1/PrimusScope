import { z } from 'zod';

const Result = z.object({
  outcome: z.enum(['completed', 'partial', 'busy']),
  revision: z.string().regex(/^[0-9]+$/).optional(),
  reports: z.array(z.object({
    domain: z.enum(['finance', 'network', 'strategy']),
    outcome: z.enum(['advanced', 'idle', 'failed', 'busy']),
    remainingBlocks: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
    committedRanges: z.number().int().nonnegative().optional(),
    code: z.string().max(64).nullable().optional(),
  })).max(4),
});
const budgetErrors = new Set(['RUN_DEADLINE_EXHAUSTED', 'REQUEST_BUDGET_EXHAUSTED']);
type Progress = { invocation: number; revision?: string; remaining: Record<string, string | null>; strategyIssue: boolean };

/** One-off recovery; regular hourly collection and all source validation remain unchanged. */
export async function recoverIndexer(options: {
  invoke: () => Promise<{ status: number; body: unknown }>;
  report?: (progress: Progress) => void;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  maxInvocations?: number;
  budgetMs?: number;
}) {
  const now = options.now ?? Date.now, started = now();
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxInvocations = options.maxInvocations ?? 80, budgetMs = options.budgetMs ?? 150 * 60_000;
  if (!Number.isInteger(maxInvocations) || maxInvocations < 1 || maxInvocations > 80
    || !Number.isFinite(budgetMs) || budgetMs < 300_000 || budgetMs > 150 * 60_000) throw new Error('INVALID_RECOVERY_LIMITS');
  let authorizedOnce = false, initialAuthRetries = 0;
  for (let invocation = 1; invocation <= maxInvocations; invocation++) {
    if (now() - started > budgetMs - 300_000) return { outcome: 'incomplete', code: 'RECOVERY_BUDGET_EXHAUSTED' };
    let response;
    try { response = await options.invoke(); }
    catch { return { outcome: 'failed', code: 'COLLECTOR_UNAVAILABLE' }; }
    // Alias promotion can reach the health route before every function replica.
    // Bound the startup retry; never hide a later authorization failure.
    if (response.status === 401 && !authorizedOnce && initialAuthRetries++ < 3) { await pause(30_000); continue; }
    if (![200, 207].includes(response.status)) return { outcome: 'failed', code: 'COLLECTOR_REJECTED', status: response.status };
    authorizedOnce = true;
    const parsed = Result.safeParse(response.body);
    if (!parsed.success) return { outcome: 'failed', code: 'INVALID_COLLECTOR_RESPONSE' };
    const result = parsed.data;
    if (result.outcome === 'busy') { await pause(30_000); continue; }
    const domains = result.reports.filter(r => r.domain !== 'strategy');
    if (domains.length !== 2 || new Set(domains.map(r => r.domain)).size !== 2) return { outcome: 'failed', code: 'INCOMPLETE_DOMAIN_REPORTS' };
    options.report?.({ invocation, revision: result.revision,
      remaining: Object.fromEntries(domains.map(r => [r.domain, r.remainingBlocks ?? null])),
      strategyIssue: result.reports.some(r => r.domain === 'strategy' && r.outcome === 'failed') });
    // A completed range survives a finite invocation budget. Quarantine, capacity,
    // rate limits and other source failures must stop recovery for investigation.
    if (domains.some(r => r.outcome === 'failed' && (!budgetErrors.has(r.code ?? '') || !r.committedRanges))) {
      return { outcome: 'failed', code: 'DOMAIN_COLLECTION_FAILED' };
    }
    if (domains.every(r => ['advanced', 'idle'].includes(r.outcome) && r.remainingBlocks === '0')) {
      return { outcome: 'caught_up', invocations: invocation, revision: result.revision };
    }
    if (!domains.some(r => (r.committedRanges ?? 0) > 0)) return { outcome: 'incomplete', code: 'NO_PROGRESS' };
  }
  return { outcome: 'incomplete', code: 'RECOVERY_INVOCATION_LIMIT' };
}
