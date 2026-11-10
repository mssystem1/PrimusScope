import Link from 'next/link';
import { createHash } from 'node:crypto';
import type { AnalyticsOptions, createRepository, NetworkEventPageOptions } from '@primusscope/data';
import type { Coverage, NetworkEvent } from '@primusscope/api-schema';
import { ArrowRight, ArrowUpRight, FileJson } from 'lucide-react';
import { CopyButton, SaveButton } from './public-actions';
import { networkViewQuery } from '../lib/network-query';
import { SnapshotExport } from './snapshot-export';

type Page = ReturnType<ReturnType<typeof createRepository>['getNetworkEvents']>;
const names = { SubmitTask: 'Task request', ReportResult: 'Attestor report', WithdrawBalance: 'Withdrawal', CallbackFailed: 'Callback failed' };
const short = (value: string) => value.slice(0, 8) + '…' + value.slice(-6);
const format = (value: number | string) => new Intl.NumberFormat('en-US').format(BigInt(value));
const time = (value: string | null) => value ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) + ' UTC' : 'Time not sampled';

export function NetworkActivity({ coverage, filters, result, error, analyticsOptions={} }: {
  coverage: Coverage; filters: NetworkEventPageOptions; result?: Page; error?: { code: string; message: string };
  analyticsOptions?:AnalyticsOptions;
}) {
  const params = networkViewQuery(filters);
  if(analyticsOptions.range)params.set('range',analyticsOptions.range);
  if(analyticsOptions.interval)params.set('interval',analyticsOptions.interval);
  const viewHref = '/network' + (params.size ? '?' + params : '') + '#activity';
  const blockTitle = (value: string | undefined, fallback: string) => value ? value.length > 15 ? value.slice(0, 6) + '…' + value.slice(-6) : format(value) : fallback;
  const title = `Network activity · ${filters.eventKind ? names[filters.eventKind] : 'All events'}`
    + (filters.fromBlock || filters.toBlock ? ` · ${blockTitle(filters.fromBlock, 'start')}–${blockTitle(filters.toBlock, 'latest')}` : '')
    + (filters.taskId ? ` · Task ${short(filters.taskId)}` : '');
  const exportParams = new URLSearchParams(params); exportParams.delete('limit'); exportParams.set('domain', 'network');
  exportParams.delete('range');exportParams.delete('interval');
  if (result) exportParams.set('snapshotId', result.snapshotId);
  const nextParams = new URLSearchParams(params); if (result?.nextCursor) nextParams.set('cursor', result.nextCursor);
  const jsonParams = networkViewQuery(filters, true);
  return <section id="activity" className="panel network-activity" aria-labelledby="network-activity-title">
    <div className="panel-heading activity-heading"><div><span className="eyebrow">EXPLORE PUBLIC EVENTS</span><h2 id="network-activity-title">Network activity explorer</h2><p>Filter requests, reports, withdrawals and callback failures within published coverage.</p></div>{result && <div className="activity-actions">
      <CopyButton value={viewHref} label="Copy view link" copyAsUrl />
      <SaveButton compact item={{ id: 'view:network:' + createHash('sha256').update(viewHref).digest('hex'), title, href: viewHref, domain: 'view' }} />
    </div>}</div>
    <form key={params.toString()} className="activity-filters" method="get" action="/network#activity" aria-label="Network activity filters" aria-describedby="activity-filter-scope">
      {analyticsOptions.range&&<input type="hidden" name="range" value={analyticsOptions.range}/>}
      {analyticsOptions.interval&&<input type="hidden" name="interval" value={analyticsOptions.interval}/>}
      {filters.chainId !== undefined && <input type="hidden" name="chainId" value={filters.chainId} />}
      {filters.contractAddress && <input type="hidden" name="contractAddress" value={filters.contractAddress} />}
      <div className="activity-field"><label htmlFor="activity-kind">Event type</label><select id="activity-kind" name="eventKind" defaultValue={filters.eventKind ?? ''}><option value="">All event types</option>{Object.entries(names).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div>
      <label htmlFor="activity-from">From block, inclusive<input id="activity-from" name="fromBlock" inputMode="numeric" pattern="0|[1-9][0-9]*" maxLength={78} defaultValue={filters.fromBlock ?? ''} placeholder={coverage.fromBlock} /></label>
      <label htmlFor="activity-to">To block, inclusive<input id="activity-to" name="toBlock" inputMode="numeric" pattern="0|[1-9][0-9]*" maxLength={78} defaultValue={filters.toBlock ?? ''} placeholder={coverage.toBlock} /></label>
      <label className="activity-task-filter" htmlFor="activity-task">Exact task ID, optional<input id="activity-task" name="taskId" maxLength={66} pattern="0x[0-9a-fA-F]{64}" defaultValue={filters.taskId ?? ''} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>
      <div className="activity-field"><label htmlFor="activity-limit">Events per page</label><select id="activity-limit" name="limit" defaultValue={filters.limit ?? 25}>{[...new Set([25, 50, 100, filters.limit ?? 25])].sort((a,b)=>a-b).map(limit => <option key={limit} value={limit}>{limit}</option>)}</select></div>
      <div className="activity-filter-buttons"><button className="button button-primary" type="submit">Apply filters</button><Link className="text-link" href="/network#activity" prefetch={false}>Reset filters</Link></div>
      <p id="activity-filter-scope">Published blocks {format(coverage.fromBlock)}–{format(coverage.toBlock)} · Base, registered task contract. Filters affect this list and its export; the summary and chart above use full coverage.</p>
    </form>
    {error ? <div className="activity-empty" role="alert"><h3>{error.code === 'SNAPSHOT_EXPIRED' ? 'New observations arrived' : 'Check this selection'}</h3><p>{error.message}</p><Link className="button button-secondary" href={error.code === 'SNAPSHOT_EXPIRED' || error.code === 'INVALID_CURSOR' ? viewHref : '/network#activity'} prefetch={false}>{error.code === 'SNAPSHOT_EXPIRED' || error.code === 'INVALID_CURSOR' ? 'Restart matching events' : 'Use published coverage'}</Link></div> : result && <>
      <div className="activity-summary"><div><strong>{format(result.total)} matching events</strong><p>Blocks {format(result.selection.fromBlock)}–{format(result.selection.toBlock)} · newest first</p></div><div className="activity-actions">
        <a className="text-link" href={'/api/v1/network/events' + (jsonParams.size ? '?' + jsonParams : '')} target="_blank" rel="noopener noreferrer">View JSON <FileJson size={14} /></a>
        {result.total <= result.exportRowLimit ? <SnapshotExport key={exportParams.toString()} href={'/api/v1/exports/metrics.csv?' + exportParams} restartHref={viewHref} /> : <p>Narrow the selection to {format(result.exportRowLimit)} events or fewer to export.</p>}
      </div></div>
      {result.items.length ? <div className="activity-table-wrap"><table className="activity-table"><caption className="sr-only">Filtered Network activity</caption><thead><tr><th scope="col">Event</th><th scope="col">Source block / time</th><th scope="col">Task evidence</th><th scope="col">Transaction source</th></tr></thead><tbody>{result.items.map((event: NetworkEvent) => <tr key={event.id} data-event-id={event.id}>
        <th scope="row"><span className={`event-status ${event.kind === 'CallbackFailed' ? 'warning' : 'neutral'}`}><span />{names[event.kind]}</span></th>
        <td data-label="Source block / time"><span className="mono">{format(event.blockNumber)}</span><small>{time(event.timestamp)}</small></td>
        <td data-label="Task evidence">{event.taskId ? <Link className="text-link mono" href={`/network/tasks/8453/${event.contractAddress}/${event.taskId}`} aria-label={`Open task evidence ${event.taskId}`} prefetch={false}>{short(event.taskId)} <ArrowRight size={13} /></Link> : <span className="muted">No task ID in this event</span>}</td>
        <td data-label="Transaction source"><a className="text-link mono" href={`https://basescan.org/tx/${event.transactionHash}`} target="_blank" rel="noopener noreferrer" aria-label={`Transaction ${event.transactionHash}`}>{short(event.transactionHash)} <ArrowUpRight size={13} /></a><small>Log {event.logIndex}</small></td>
      </tr>)}</tbody></table></div> : <div className="activity-empty"><h3>No matching events in this selection</h3><p>Change an event type, task ID or covered block range. This result applies only to the published scope.</p></div>}
      <nav className="activity-pagination" aria-label="Activity pagination"><span>Showing {format(result.pageStart)}–{format(result.pageEnd)} of {format(result.total)}</span><div className="activity-actions">{filters.cursor && <Link className="text-link" href={viewHref} prefetch={false}>Newest matching events</Link>}{result.nextCursor && <Link className="button button-secondary" href={'/network?' + nextParams + '#activity'} aria-label="Next activity page" prefetch={false}>Next page <ArrowRight size={14} /></Link>}</div></nav>
      <div className="panel-footnote">Exports include all matching events across pages from snapshot {result.snapshotId.slice(0, 8)}. A report or withdrawal does not establish proof validity. Task links open all covered evidence for that task.</div>
    </>}
  </section>;
}
