import { buildStrategyAnalytics, getServingState } from "@primusscope/data";
import { FinanceView } from "../../components/data-ui";
import { FinanceAnalyticsDashboard } from '../../components/analytics-dashboards';
import { parseAnalyticsPage } from '../../lib/analytics-query';

export default async function FinancePage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const { snapshot, mode } = await getServingState();
  const options=parseAnalyticsPage(await searchParams,{range:'30d',interval:'day'});
  return <FinanceView snapshot={snapshot} mode={mode} strategyApy7d={buildStrategyAnalytics(snapshot,options).latest?.apy7d}
    dashboard={<FinanceAnalyticsDashboard snapshot={snapshot} options={options} action="/finance"/>} />;
}
