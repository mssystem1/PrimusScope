'use client';

import { ArrowRight, Download } from 'lucide-react';
import type { ComparisonGroup, ComparisonMetric } from '@primusscope/data';
import { AnalyticsPeriodLink } from './analytics-navigation';
import { ComparisonBars, downloadComparisonCsv, formatComparisonValue } from './period-comparison';

const title = 'Shared strategy comparison';
const fullDate = (value: string | null) => value?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') ?? 'Unavailable';
function dateRange(from: string | null, to: string | null) {
  if (!from || !to) return 'Choose a period';
  const format = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const start = format.format(new Date(from)), end = format.format(new Date(to));
  return start === end ? start : start + ' – ' + end;
}

function MetricValue({ metric, value }: { metric: ComparisonMetric; value: string | null }) {
  return <><strong className={value === null ? 'strategy-value-unavailable' : undefined}>{formatComparisonValue(value, metric.key === 'nav' ? 6 : 2)}</strong>
    {metric.key === 'netFlows' && value !== null && <small>{Number(value) > 0 ? 'Inflow' : Number(value) < 0 ? 'Outflow' : 'Balanced'}</small>}</>;
}

export function StrategyComparison({ flows, stock, snapshotId, periodLinks, periodLabels }: {
  flows: ComparisonGroup; stock: ComparisonGroup; snapshotId: string;
  periodLinks: { label: string; href: string; active: boolean }[];
  periodLabels: { current: string; previous: string };
}) {
  const groups = [
    { name: 'Capital flows', caption: 'Totals during each period', data: flows, source: 'Public Unitas ERC-4626 flows · BSC · shared strategy, without Primus route attribution.' },
    { name: 'Pool value', caption: 'Observations near each period’s end', data: { ...stock, metrics: stock.metrics.filter(metric => !metric.key.startsWith('apy')) }, source: 'Public Unitas sUSDu stock observations · BSC · shared strategy.' },
    { name: 'Yield', caption: 'Trailing NAV growth · changes in percentage points', data: { ...stock, metrics: stock.metrics.filter(metric => metric.key.startsWith('apy')) }, source: 'Public Unitas sUSDu NAV-derived APY · BSC · each observation uses its own historical anchor.' },
  ];
  const fixed = flows.reason !== 'NO_FIXED_PERIOD';
  const hasValues = groups.some(group => group.data.metrics.some(metric => metric.current !== null || metric.previous !== null));
  return <section className="panel strategy-comparison" aria-label={title} data-comparison-status={flows.status === 'available' && stock.status === 'available' ? 'available' : 'unavailable'}>
    <div className="panel-heading"><div><h2>{title}</h2><p>Capital moving through the pool, alongside changes in value and yield.</p></div>
      <div className="strategy-comparison-controls"><nav className="comparison-actions" aria-label={title + ' periods'}>{periodLinks.map(link => <AnalyticsPeriodLink key={link.href} {...link} compact />)}</nav>
      {hasValues && <button className="button button-secondary button-small" aria-label={'Export comparison CSV for ' + title} onClick={() => downloadComparisonCsv(title, groups, snapshotId)}><Download size={14} aria-hidden="true" />Export CSV</button>}</div>
    </div>
    {!fixed ? <p className="strategy-comparison-empty">All available history has no equivalent preceding window. Choose a period above to compare it with the one before it.</p> : <>
      <div className="strategy-period-strip">
        <div data-period="prior"><strong><i className="comparison-swatch-previous" aria-hidden="true" />{periodLabels.previous}</strong><span>{dateRange(flows.previous.from, flows.previous.to)}</span></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div data-period="current"><strong><i className="comparison-swatch-selected" aria-hidden="true" />{periodLabels.current}</strong><span>{dateRange(flows.current.from, flows.current.to)}</span></div>
        <small>Dates in UTC · compare paired bars within each row</small>
      </div>
      <div className="strategy-comparison-columns" aria-hidden="true"><span>Metric</span><div><span>{periodLabels.previous}</span><span>{periodLabels.current}</span><span>Change</span></div><span>Comparison</span></div>
      {groups.map(group => <section className="strategy-metric-group" aria-label={group.name} key={group.name}>
        <header><h3>{group.name}</h3><span>{group.caption}</span></header>
        {group.data.reason && <p className="strategy-group-notice">{group.data.basis === 'end_observations' ? 'A recent endpoint measurement is missing for one or both periods.' : group.data.reason === 'MISSING_TIMESTAMPS' ? 'Some events cannot be placed in time. Calendar totals are unavailable.' : 'One or both periods are not fully covered. Missing history is unavailable.'}</p>}
        {group.data.metrics.map(metric => <article className="strategy-comparison-row" data-metric={metric.key} aria-label={metric.label} key={metric.key}>
          <div className="strategy-row-name"><h4>{metric.label}</h4><span>{metric.unit}</span></div>
          <dl className="strategy-row-values">
            <div className="strategy-value-prior"><dt>{periodLabels.previous}</dt><dd><MetricValue metric={metric} value={metric.previous} /></dd></div>
            <div className="strategy-value-current"><dt>{periodLabels.current}</dt><dd><MetricValue metric={metric} value={metric.current} /></dd></div>
            <div className="strategy-row-change"><dt>Change</dt><dd><strong>{metric.delta !== null && Number(metric.delta) > 0 ? '+' : ''}{formatComparisonValue(metric.delta, metric.key === 'nav' ? 6 : 2)}{metric.deltaUnit && metric.delta !== null ? ' ' + metric.deltaUnit : ''}</strong>
              {metric.percentChange !== null && <small>{metric.percentChange > 0 ? '+' : ''}{new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(metric.percentChange)}%</small>}</dd></div>
          </dl>
          <div className="strategy-row-visual">{metric.current !== null && metric.previous !== null ? <ComparisonBars metric={metric} previousFirst compact /> : <small>Needs both periods</small>}</div>
        </article>)}
      </section>)}
    </>}
    <details className="panel-footnote strategy-comparison-details"><summary>Sources, coverage &amp; measurement times</summary>
      <p>Period totals and endpoint observations use different time bases. Assets, shares and NAV use a verified observation inside each window, within 36 hours of its end. APY requires a verified historical NAV anchor; missing values remain unavailable.</p>
      {fixed && <dl><div><dt>{periodLabels.previous}</dt><dd>{fullDate(flows.previous.from)} – {fullDate(flows.previous.to)}</dd></div><div><dt>{periodLabels.current}</dt><dd>{fullDate(flows.current.from)} – {fullDate(flows.current.to)}</dd></div>
        <div><dt>Prior value / yield measurement</dt><dd>{fullDate(stock.previous.measuredAt ?? null)}</dd></div><div><dt>Current value / yield measurement</dt><dd>{fullDate(stock.current.measuredAt ?? null)}</dd></div></dl>}
      <p>Public Unitas strategy on BSC. Flow totals have no Primus route attribution. Assets display two decimals, NAV six; CSV retains exact values, coverage, timestamps and change units. APY differences use percentage points. Relative net-flow changes use the absolute prior value; a zero baseline has no percentage change.</p>
    </details>
  </section>;
}
