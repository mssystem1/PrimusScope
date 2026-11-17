import {
  buildNetworkAnalytics, buildStrategyAnalytics, getNeonHistoryState,
} from '@primusscope/data';
import type { AnalyticsSelection } from '@primusscope/api-schema';
import type { ObservationSet } from '@primusscope/api-schema';
import { AnalyticsChart, type ChartRow } from '../../components/analytics-chart';
import {HistoryPeriod as PeriodForm} from '../../components/history-period';
import { parseAnalyticsPage } from '../../lib/analytics-query';

export const dynamic = 'force-dynamic';

function utc(value: string | null): string {
  return value ? new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC' : 'not recorded';
}

function Coverage({ title, snapshot, domain }: { title: string; snapshot: ObservationSet; domain: 'finance' | 'network' }) {
  const coverage = snapshot[domain].coverage;
  const source = snapshot.sources.find(item => item.id === coverage.sourceId);
  let host = 'source unavailable';
  try { host = new URL(source?.url ?? '').hostname; } catch { /* validated source metadata is optional for display */ }
  return <section className="analytics-coverage-card">
    <strong>{title}</strong>
    <p>Source: {source?.label ?? coverage.sourceId} · {host}</p>
    <p>Time bounds: {utc(coverage.fromTime)} – {utc(coverage.toTime)}</p>
    <p>Block bounds: {coverage.fromBlock} – {coverage.toBlock}</p>
    <small>{coverage.completeForRegisteredContracts ? 'Complete for registered contracts.' : 'Partial registered-contract coverage.'} Historical observations only.</small>
  </section>;
}


function HistoricalCharts({ snapshot, options }: { snapshot: ObservationSet; options: AnalyticsSelection }) {
  const strategy = buildStrategyAnalytics(snapshot, options);
  const network = buildNetworkAnalytics(snapshot, options);
  const strategyRows: ChartRow[] = strategy.points.map(point => ({
    label: point.label, assets: point.assets, shares: point.shares, nav: point.nav, apy7d: point.apy7d, apy30d: point.apy30d,
  }));
  const flowRows: ChartRow[] = strategy.flows;
  const networkRows: ChartRow[] = network.series.map(row => ({
    label: row.at, SubmitTask: row.SubmitTask ?? 0, ReportResult: row.ReportResult ?? 0,
    WithdrawBalance: row.WithdrawBalance ?? 0, CallbackFailed: row.CallbackFailed ?? 0,
  }));
  const cumulativeRows: ChartRow[] = (network.cumulative as { at: string; SubmitTask: number; ReportResult: number }[]).map(row => ({
    label: row.at, SubmitTask: row.SubmitTask, ReportResult: row.ReportResult,
  }));
  const distributionRows: ChartRow[] = network.reportCountDistribution.map(row => ({ label: `${row.reportCount} reports`, requests: row.requestCount }));
  const strategySource = `Historical public Unitas strategy samples · ${strategy.requestedFrom.slice(0, 10)} – ${strategy.requestedTo.slice(0, 10)} UTC. No Primus route attribution.`;
  const flowSource = strategy.flowCoverage?.complete
    ? `Historical shared ERC-4626 deposits and withdrawals · ${strategy.flowCoverage.fromTime.slice(0, 10)} – ${strategy.flowCoverage.toTime.slice(0, 10)} UTC. No Primus route attribution.`
    : 'Historical flow coverage is incomplete. Missing ranges are not plotted as zero.';
  const networkSource = `Historical registered Network task-contract events · ${network.requestedFrom.slice(0, 10)} – ${network.requestedTo.slice(0, 10)} UTC. Reports are event counts, not proof checks or task outcomes.`;

  return <>
    <section className="analytics-section-heading"><h2>Finance · shared strategy history</h2><span className="muted">USDu assets and sUSDu shares · no private positions</span></section>
    <div className="analytics-grid">
      <AnalyticsChart title="Strategy assets · TVL" description="Historical USDu assets backing the shared sUSDu strategy." rows={strategyRows} maxGapHours={36} series={[{ key: 'assets', label: 'Shared staked assets', color: '#ff9d73' }]} unit="USDu" precision={2} source={strategySource}/>
      <AnalyticsChart title="Strategy share supply" description="Historical sUSDu share supply for the shared strategy." rows={strategyRows} maxGapHours={36} series={[{ key: 'shares', label: 'sUSDu shares', color: '#a79cf4' }]} unit="sUSDu" precision={2} source={strategySource}/>
      <AnalyticsChart title="NAV per strategy share" description="USDu exchange price for one sUSDu share." rows={strategyRows} maxGapHours={36} series={[{ key: 'nav', label: 'USDu / sUSDu', color: '#53d9b5' }]} unit="USDu/share" precision={6} startAtZero={false} source={strategySource}/>
      <AnalyticsChart title="Strategy APY · 7D and 30D" description="Annualized historical NAV growth using the available lookback samples." rows={strategyRows} maxGapHours={36} series={[{ key: 'apy7d', label: '7D APY', color: '#ff9d73' }, { key: 'apy30d', label: '30D APY', color: '#a79cf4' }]} unit="%" precision={2} startAtZero={false} source="Historical annualized NAV growth, not a forecast or private user return."/>
      <AnalyticsChart title="Strategy deposits and withdrawals" description="Public shared-strategy ERC-4626 asset flows." rows={flowRows} series={[{ key: 'deposits', label: 'Deposits', color: '#ff9d73' }, { key: 'withdrawals', label: 'Withdrawals', color: '#a79cf4' }]} type="bar" unit="USDu" precision={2} source={flowSource}/>
    </div>

    <section className="analytics-section-heading"><h2>Network · historical activity</h2><span className="muted">Requests and reports are separate measures</span></section>
    <div className="analytics-grid">
      <AnalyticsChart title="Requests and attestor reports" description="Observed SubmitTask requests and ReportResult events by UTC bucket." rows={networkRows} series={[{ key: 'SubmitTask', label: 'Requests', color: '#ff9d73' }, { key: 'ReportResult', label: 'Attestor reports', color: '#a79cf4' }]} type="bar" unit="events" source={networkSource}/>
      <AnalyticsChart title="Cumulative requests and reports" description="Cumulative public event counts within the selected period." rows={cumulativeRows} series={[{ key: 'SubmitTask', label: 'Requests', color: '#ff9d73' }, { key: 'ReportResult', label: 'Reports', color: '#a79cf4' }]} unit="events" source={networkSource}/>
      <AnalyticsChart title="Requests by observed report count" description="Requests grouped by the number of later ReportResult events in the selected period." rows={distributionRows} series={[{ key: 'requests', label: 'Requests', color: '#53d9b5' }]} type="bar" unit="tasks" source="Historical observation coverage only. No proof contents, participants, or success verdicts are shown."/>
    </div>
  </>;
}

function HistoryUnavailable() {
  return <div className="page-content">
    <header className="page-intro"><div><span className="eyebrow">HISTORICAL DATA</span><h1>Neon history</h1><p>Neon history currently unavailable; no data has been removed. New observations are stored separately in Blob.</p></div></header>
    <div className="notice" role="status"><div><strong>Historical observations could not be loaded</strong><p>The current app remains available with its current observations.</p><a className="text-link" href="/">Return to the current app</a></div></div>
  </div>;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const selected = parseAnalyticsPage(query, { range: 'all', interval: 'day' });
  if (selected.error) {
    return <div className="page-content"><header className="page-intro"><div><span className="eyebrow">HISTORICAL DATA</span><h1>Neon history</h1><p>Neon historical observations · new data in Blob.</p></div></header>
      <div className="notice" role="alert"><div><strong>Check the selected dates</strong><p>Choose All available, 7 days, 30 days, or a valid custom UTC range of at most 366 days.</p><a className="text-link" href="/history">Reset the period</a></div></div>
    </div>;
  }
  try {
    const { snapshot } = await getNeonHistoryState();
    return <div className="page-content">
      <header className="page-intro"><div><span className="eyebrow">HISTORICAL DATA · READ ONLY</span><h1>Neon history</h1><p>Neon historical observations · new data in Blob. This view reads the retained Neon history and does not change it.</p></div></header>
      <div className="notice"><div><strong>Historical Neon observations</strong><p>Current observations are stored separately in Blob. This page reads historical data only.</p></div></div>
      <PeriodForm options={selected.options}/>
      <div className="analytics-coverage-grid">
        <Coverage title="Finance source bounds" snapshot={snapshot} domain="finance"/>
        <Coverage title="Network source bounds" snapshot={snapshot} domain="network"/>
      </div>
      <HistoricalCharts snapshot={snapshot} options={selected.options}/>
    </div>;
  } catch {
    return <HistoryUnavailable/>;
  }
}
