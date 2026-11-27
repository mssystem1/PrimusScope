'use client';

import type { PublicIndexerStatus } from '@primusscope/data';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getCollectionSchedule } from '../lib/collection-schedule';

const utcDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function ScheduleTime({ value }: { value: string | number }) {
  const time = new Date(value);
  return <time dateTime={time.toISOString()}>{utcDateTime.format(time)} UTC</time>;
}

export function CollectionSchedule({ status, publishedAt, initialNow }: {
  status: PublicIndexerStatus;
  publishedAt: string;
  initialNow: number;
}) {
  const pathname = usePathname();
  const [now, setNow] = useState(initialNow);
  const schedule = pathname.startsWith('/developers') ? null : getCollectionSchedule(status, now);

  useEffect(() => {
    if (pathname.startsWith('/developers') || status.collectionMode !== 'scheduled' || status.historical || !status.intervalMinutes) return;
    const update = () => setNow(Date.now());
    const interval = window.setInterval(update, 30_000);
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') update();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [pathname, status.collectionMode, status.historical, status.intervalMinutes]);

  if (!schedule) return null;
  const cadence = schedule.intervalMinutes === 60 ? 'Hourly collection' : `Collection every ${schedule.intervalMinutes} minutes`;
  return <aside className="collection-schedule" aria-label="Analytics update schedule">
    <strong>{cadence}</strong>
    <dl>
      <div><dt>Last publication</dt><dd><ScheduleTime value={publishedAt} /></dd></div>
      <div aria-live="polite"><dt>{schedule.label}</dt><dd><ScheduleTime value={schedule.scheduledAt} /></dd></div>
    </dl>
    <p>Pages check for new publications every minute.</p>
    {schedule.needsAttention && <p className="collection-schedule-warning" role="status">
      <strong>Collection needs attention</strong>{' '}<Link href="/sources">View source status</Link>
    </p>}
  </aside>;
}
