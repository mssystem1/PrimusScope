import { createRepository, DataAccessError, getServingState, type NetworkEventPageOptions } from "@primusscope/data";
import { NetworkView } from "../../components/data-ui";
import { NetworkActivity } from '../../components/network-activity';
import { parseNetworkPageQuery } from '../../lib/network-query';
import { NetworkAnalyticsDashboard } from '../../components/analytics-dashboards';
import type { AnalyticsOptions } from '@primusscope/data';

export default async function NetworkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { snapshot, ...context } = await getServingState();
  let filters: NetworkEventPageOptions = {}, result, error;
  let analyticsOptions:AnalyticsOptions={range:'24h',interval:'hour'};
  let explicitAnalytics:AnalyticsOptions={};
  try {
    const {range,interval,...activityFilters}=parseNetworkPageQuery(await searchParams);
    filters=activityFilters;
    explicitAnalytics={range,interval};analyticsOptions={range:range??'24h',interval:interval??'hour'};
    result = createRepository(snapshot, () => new Date(), context).getNetworkEvents(filters);
  } catch (caught) {
    error = caught instanceof DataAccessError ? { code: caught.code, message: caught.message }
      : { code: 'INVALID_FILTER', message: 'Use supported filters, canonical block numbers and an exact 32-byte task ID. Each field may appear only once.' };
  }
  return <NetworkView snapshot={snapshot} mode={context.mode}
    dashboard={<NetworkAnalyticsDashboard snapshot={snapshot} options={analyticsOptions}/>}
    activity={<NetworkActivity coverage={snapshot.network.coverage} filters={filters} result={result} error={error} analyticsOptions={explicitAnalytics} />} />;
}
