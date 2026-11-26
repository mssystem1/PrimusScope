"use client";

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { PublicIndexerStatus } from '@primusscope/data';

function fingerprint(status?: PublicIndexerStatus | null) {
  return status ? JSON.stringify([status.publication, status.collectorFailure ?? null,
    status.domains.map(d => [d.domain, d.toBlock, d.lastAttemptAt, d.lastOutcome, d.lastErrorCode, d.stale, d.lagBlocks])]) : null;
}

/** Refresh public analytics when a newer publication exists; keep URL selections. */
export function PublicationRefresh({ snapshotId, indexerStatus }: { snapshotId: string; indexerStatus?: PublicIndexerStatus | null }) {
  const router = useRouter(), current = useRef({ snapshotId, fingerprint: fingerprint(indexerStatus) });
  useEffect(() => { current.current = { snapshotId, fingerprint: fingerprint(indexerStatus) }; }, [snapshotId, indexerStatus]);
  useEffect(() => {
    let active = true, pending = false, controller: AbortController | undefined;
    async function check() {
      if (!active || pending || document.visibilityState !== 'visible') return;
      pending = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await fetch('/api/v1/status/indexer', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const status = await response.json();
        if (active && status.publication === 'available' && !status.recovery
          && typeof status.snapshotId === 'string' && /^[0-9a-f]{64}$/i.test(status.snapshotId)
          && Array.isArray(status.domains)) {
          const nextFingerprint = fingerprint(status);
          if (status.snapshotId !== current.current.snapshotId
            || (current.current.fingerprint !== null && nextFingerprint !== current.current.fingerprint)) router.refresh();
          else current.current.fingerprint = nextFingerprint;
        }
      } catch { /* A transient status failure must not clear readable analytics. */ }
      finally { clearTimeout(timeout); pending = false; }
    }
    const interval = setInterval(() => { void check(); }, 60_000);
    function visible() { if (document.visibilityState === 'visible') void check(); }
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; clearInterval(interval); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [router]);
  return null;
}
