import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AddressSchema, DecimalStringSchema, HashSchema } from '@primusscope/api-schema';
import {
  buildFinanceAnalytics, buildFinanceComparison, buildNetworkAnalytics, buildNetworkComparison,
  buildStrategyAnalytics, createRepository, getNeonHistoryState,
} from '@primusscope/data';
import type { AnalyticsOptions } from '@primusscope/data';
import { HttpError, errorResponse, jsonResponse, readQuery } from '../../../../../../lib/http';
import { analyticsQuery, networkAnalyticsQuery } from '../../../../../../lib/analytics-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ segments: string[] }> };
const emptyQuery = z.object({}).strict();
const positiveIntegerParameter = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .pipe(z.coerce.number<string>().int().positive());

export async function GET(request: NextRequest, context: Context) {
  try {
    const { segments: parts } = await context.params;
    const path = parts.join('/');
    const url = request.nextUrl;
    const networkTask = parts[0] === 'network' && parts[1] === 'tasks' && parts.length === 5;
    const financeBatch = parts[0] === 'finance' && parts[1] === 'batches' && parts.length === 4;
    if (path !== 'overview' && path !== 'finance/analytics' && path !== 'network/analytics' && !networkTask && !financeBatch) {
      throw new HttpError('NOT_FOUND', 'This historical Neon resource is not available.', 404);
    }

    if (path === 'overview') {
      readQuery(url, emptyQuery);
      const state = await getNeonHistoryState();
      const repository = createRepository(state.snapshot, () => new Date(), state);
      return jsonResponse({ historySource: 'neon', ...repository.getOverview(),
        historyBounds: { finance: state.snapshot.finance.coverage, network: state.snapshot.network.coverage } });
    }

    if (path === 'finance/analytics') {
      const query = readQuery(url, analyticsQuery);
      const state = await getNeonHistoryState();
      if (query.routeId && !state.snapshot.finance.contracts.some(contract => contract.routeId === query.routeId)) {
        throw new HttpError('UNSUPPORTED_SCOPE', 'Select a registered historical Finance route.', 422);
      }
      const options: AnalyticsOptions = { range: 'all', interval: 'day', ...query };
      return jsonResponse({ historySource: 'neon', mode: state.mode, snapshotId: state.snapshot.snapshotId,
        coverage: state.snapshot.finance.coverage,
        operations: buildFinanceAnalytics(state.snapshot, options),
        strategy: buildStrategyAnalytics(state.snapshot, options),
        comparison: buildFinanceComparison(state.snapshot, options) });
    }

    if (path === 'network/analytics') {
      const query = readQuery(url, networkAnalyticsQuery);
      const state = await getNeonHistoryState();
      const options: AnalyticsOptions = { range: 'all', interval: 'day', ...query };
      return jsonResponse({ historySource: 'neon', mode: state.mode, snapshotId: state.snapshot.snapshotId,
        coverage: state.snapshot.network.coverage,
        analytics: buildNetworkAnalytics(state.snapshot, options),
        comparison: buildNetworkComparison(state.snapshot, options) });
    }

    const state = await getNeonHistoryState();
    const repository = createRepository(state.snapshot, () => new Date(), state);
    if (networkTask) {
      readQuery(url, emptyQuery);
      const chainId = positiveIntegerParameter.parse(parts[2]);
      AddressSchema.parse(parts[3]);
      HashSchema.parse(parts[4]);
      return jsonResponse({ historySource: 'neon', ...repository.getNetworkTask(chainId, parts[3]!, parts[4]!) });
    }
    if (financeBatch) {
      readQuery(url, emptyQuery);
      AddressSchema.parse(parts[2]);
      DecimalStringSchema.parse(parts[3]);
      return jsonResponse({ historySource: 'neon', ...repository.getFinanceBatch(parts[2]!, parts[3]!) });
    }

    throw new HttpError('NOT_FOUND', 'This historical Neon resource is not available.', 404);
  } catch (error) {
    return errorResponse(error);
  }
}
