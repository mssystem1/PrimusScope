import { notFound } from "next/navigation";
import { getServingState } from "@primusscope/data";
import { FinanceView } from "../../../../components/data-ui";

export default async function VaultPage({ params }: { params: Promise<{ vaultId: string }> }) {
  const { vaultId } = await params;
  const { snapshot, mode } = await getServingState();
  if (!snapshot.finance.contracts.some((contract) => contract.routeId === vaultId)) notFound();
  return <FinanceView snapshot={snapshot} mode={mode} routeId={vaultId} />;
}
