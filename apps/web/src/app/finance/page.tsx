import { buildStrategyAnalytics, getServingState } from "@primusscope/data";
import { FinanceView } from "../../components/data-ui";
import { FinanceAnalyticsDashboard } from '../../components/analytics-dashboards';
import { AnalyticsSelectionError } from '../../components/analytics-controls';
import { parseAnalyticsPage, analyticsQueryString } from '../../lib/analytics-query';

export default async function FinancePage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const { snapshot, mode } = await getServingState();
  const query=await searchParams;
  const {options,error}=parseAnalyticsPage(query,{range:'30d',interval:'day'});
  const selectionQuery=Object.keys(query).length?'?'+analyticsQueryString(options):'';
  return <FinanceView snapshot={snapshot} mode={mode} selectionQuery={selectionQuery} strategyApy7d={error?null:buildStrategyAnalytics(snapshot,options).latest?.apy7d}
    dashboard={error?<AnalyticsSelectionError action="/finance"/>:<FinanceAnalyticsDashboard snapshot={snapshot} options={options} action="/finance"/>} />;
}
