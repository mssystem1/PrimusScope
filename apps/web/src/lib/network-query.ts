import { z } from 'zod';
import { NetworkEventFiltersSchema } from '@primusscope/api-schema';
import { rangeQuery, intervalQuery } from './analytics-query';

const positive = z.string().regex(/^[1-9][0-9]{0,15}$/).pipe(z.coerce.number<string>().int().positive().max(Number.MAX_SAFE_INTEGER));
export const networkFiltersQuery = NetworkEventFiltersSchema.extend({ chainId: positive.optional() });
export const networkPageQuery = networkFiltersQuery.extend({
  limit: positive.pipe(z.number().max(100)).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const dashboardPageQuery=networkPageQuery.extend({range:rangeQuery.optional(),interval:intervalQuery.optional()});

/** HTML forms submit empty optional controls; API queries remain strict. */
export function parseNetworkPageQuery(input: Record<string, string | string[] | undefined>) {
  const entries: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || (value === '' && Object.hasOwn(dashboardPageQuery.shape, key))) continue;
    entries[key] = value;
  }
  const result = dashboardPageQuery.parse(entries);
  if (result.taskId) result.taskId = result.taskId.toLowerCase();
  if (result.contractAddress) result.contractAddress = result.contractAddress.toLowerCase();
  return result;
}

export function networkViewQuery(filters: ReturnType<typeof parseNetworkPageQuery>, includeCursor = false) {
  const params = new URLSearchParams();
  for (const key of ['chainId', 'contractAddress', 'fromBlock', 'toBlock', 'eventKind', 'taskId', 'limit'] as const) {
    const value = filters[key]; if (value !== undefined) params.set(key, String(value));
  }
  if (includeCursor && filters.cursor) params.set('cursor', filters.cursor);
  return params;
}
