import { createRepository, DataAccessError, getServingState, type NetworkEventPageOptions } from "@primusscope/data";
import { NetworkView } from "../../components/data-ui";
import { NetworkActivity } from '../../components/network-activity';
import { parseNetworkPageQuery, networkViewQuery } from '../../lib/network-query';
import { NetworkAnalyticsDashboard } from '../../components/analytics-dashboards';
import { parseAnalyticsPage } from '../../lib/analytics-query';
import { AnalyticsSelectionError } from '../../components/analytics-controls';
import type { AnalyticsOptions } from '@primusscope/data';

export default async function NetworkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { snapshot, ...context } = await getServingState();
  let filters: NetworkEventPageOptions = {}, result, error;
  const query=await searchParams;
  const selectedDates=Object.fromEntries(Object.entries(query).filter(([key])=>['range','interval','from','to'].includes(key)));
  const selected=parseAnalyticsPage(selectedDates,{});
  const explicitAnalytics:AnalyticsOptions=selected.options;
  const analyticsOptions:AnalyticsOptions={range:'24h',interval:'hour',...explicitAnalytics};
  try {
    const {range,interval,from,to,...activityFilters}=parseNetworkPageQuery(query);
    filters=activityFilters;
    result = createRepository(snapshot, () => new Date(), context).getNetworkEvents(filters);
  } catch (caught) {
    error = caught instanceof DataAccessError ? { code: caught.code, message: caught.message }
      : { code: 'INVALID_FILTER', message: 'Use supported filters, canonical block numbers and an exact 32-byte task ID. Each field may appear only once.' };
  }
  return <NetworkView snapshot={snapshot} mode={context.mode}
    dashboard={selected.error?<AnalyticsSelectionError action="/network"/>:<NetworkAnalyticsDashboard snapshot={snapshot} options={analyticsOptions} preservedFields={Array.from(networkViewQuery(filters))}/> }
    activity={<NetworkActivity coverage={snapshot.network.coverage} filters={filters} result={result} error={error} analyticsOptions={explicitAnalytics} />} />;
}
