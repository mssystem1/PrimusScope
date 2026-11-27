import type { PublicIndexerStatus } from '@primusscope/data';

const MINUTE_MS = 60_000;
const UPDATE_WINDOW_MS = 10 * MINUTE_MS;

export function getCollectionSchedule(status: PublicIndexerStatus, now: number) {
  const intervalMinutes = status.intervalMinutes;
  if (status.collectionMode !== 'scheduled' || status.historical || !intervalMinutes) return null;

  const cadenceMs = intervalMinutes * MINUTE_MS;
  const currentSlot = Math.floor(now / cadenceMs) * cadenceMs;
  const latestAttempt = status.domains.reduce((latest, domain) => {
    const attempt = Date.parse(domain.lastAttemptAt ?? '');
    return Number.isFinite(attempt) && attempt <= now ? Math.max(latest, attempt) : latest;
  }, -Infinity);
  const needsAttention = Boolean(status.collectorFailure || status.recovery || status.publication === 'quarantined'
    || status.domains.some(domain => domain.lastOutcome === 'failed' || domain.quarantined || domain.stale));

  if (needsAttention || latestAttempt >= currentSlot) {
    return { intervalMinutes, needsAttention, label: 'Next scheduled collection', scheduledAt: currentSlot + cadenceMs };
  }
  const label = now - currentSlot < UPDATE_WINDOW_MS ? 'Update window' : 'Awaiting scheduled publication';
  return { intervalMinutes, needsAttention, label, scheduledAt: currentSlot };
}
