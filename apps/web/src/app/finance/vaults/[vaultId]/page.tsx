import { notFound } from "next/navigation";
import { buildStrategyAnalytics, getServingState } from "@primusscope/data";
import { FinanceView } from "../../../../components/data-ui";
import { FinanceAnalyticsDashboard } from '../../../../components/analytics-dashboards';
import { AnalyticsSelectionError } from '../../../../components/analytics-controls';
import { parseAnalyticsPage, analyticsQueryString } from '../../../../lib/analytics-query';

export default async function VaultPage({ params, searchParams }: { params: Promise<{ vaultId: string }>;searchParams:Promise<Record<string,string|string[]|undefined>> }) {
  const { vaultId } = await params;
  const { snapshot, mode } = await getServingState();
  if (!snapshot.finance.contracts.some((contract) => contract.routeId === vaultId)) notFound();
  const query=await searchParams;
  const parsed=parseAnalyticsPage(query,{range:'30d',interval:'day'});
  const options={...parsed.options,routeId:vaultId};
  const selectionQuery=Object.keys(query).length?'?'+analyticsQueryString(options):'';
  return <FinanceView snapshot={snapshot} mode={mode} routeId={vaultId} selectionQuery={selectionQuery} strategyApy7d={parsed.error?null:buildStrategyAnalytics(snapshot,options).latest?.apy7d}
    dashboard={parsed.error?<AnalyticsSelectionError action={'/finance/vaults/'+vaultId}/>:<FinanceAnalyticsDashboard snapshot={snapshot} options={options} action={'/finance/vaults/'+vaultId}/>}/>;
}
