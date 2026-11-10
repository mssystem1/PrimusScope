import { AnalyticsSelectionSchema, type AnalyticsSelection } from '@primusscope/api-schema';

const day = 86400000;
const durations = { '24h': day, '7d': 7 * day, '30d': 30 * day };
export function analyticsWindow(coveredStart: number, coveredEnd: number, options: AnalyticsSelection = {}, sourceComplete = true, requestedBounds?:{from:number;to:number}) {
  const selection = AnalyticsSelectionSchema.parse(options);
  const requestedStart = requestedBounds?.from ?? (selection.range === 'custom' ? Date.parse(selection.from! + 'T00:00:00.000Z')
    : !selection.range || selection.range === 'all' ? coveredStart : coveredEnd - durations[selection.range]);
  const requestedEnd = requestedBounds?.to ?? (selection.range === 'custom' ? Date.parse(selection.to! + 'T00:00:00.000Z') + day - 1 : coveredEnd);
  const start = Math.max(coveredStart, requestedStart), end = Math.min(coveredEnd, requestedEnd);
  const hasCoverage = start <= end;
  const step = selection.interval === 'hour' ? 3600000 : day;
  const iso = (value: number) => new Date(value).toISOString();
  const buckets = [];
  if (hasCoverage) for (let at = Math.floor(start / step) * step; at <= end; at += step) {
    const from = Math.max(at, start), to = Math.min(at + step - 1, end);
    buckets.push({ at: iso(at), from: iso(from), to: iso(to), partial: from !== at || to !== at + step - 1 });
  }
  return { start, end, step, hasCoverage, historyComplete: sourceComplete && hasCoverage && requestedStart >= coveredStart && requestedEnd <= coveredEnd,
    from: iso(hasCoverage ? start : requestedStart), to: iso(hasCoverage ? end : requestedEnd),
    requestedFrom: iso(requestedStart), requestedTo: iso(requestedEnd),
    coveredFrom: hasCoverage ? iso(start) : null, coveredTo: hasCoverage ? iso(end) : null,
    bucketCoverage: buckets,
  };
}
