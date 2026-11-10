import { notFound } from "next/navigation";
import { buildStrategyAnalytics, getServingState } from "@primusscope/data";
import { FinanceView } from "../../../../components/data-ui";
import { FinanceAnalyticsDashboard } from '../../../../components/analytics-dashboards';
import { parseAnalyticsPage } from '../../../../lib/analytics-query';

export default async function VaultPage({ params, searchParams }: { params: Promise<{ vaultId: string }>;searchParams:Promise<Record<string,string|string[]|undefined>> }) {
  const { vaultId } = await params;
  const { snapshot, mode } = await getServingState();
  if (!snapshot.finance.contracts.some((contract) => contract.routeId === vaultId)) notFound();
  const options={...parseAnalyticsPage(await searchParams,{range:'30d',interval:'day'}),routeId:vaultId};
  return <FinanceView snapshot={snapshot} mode={mode} routeId={vaultId} strategyApy7d={buildStrategyAnalytics(snapshot,options).latest?.apy7d}
    dashboard={<FinanceAnalyticsDashboard snapshot={snapshot} options={options} action={'/finance/vaults/'+vaultId}/>}/>;
}
