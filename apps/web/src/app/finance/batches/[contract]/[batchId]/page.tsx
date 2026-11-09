import { notFound } from "next/navigation";
import { getServingState } from "@primusscope/data";
import { BatchDetailView, financeBatches } from "../../../../../components/data-ui";

export default async function BatchPage({ params }: { params: Promise<{ contract: string; batchId: string }> }) {
  const { contract, batchId } = await params;
  const { snapshot, mode } = await getServingState();
  if (!financeBatches(snapshot).some((batch) => batch.contractAddress.toLowerCase() === contract.toLowerCase() && batch.batchId === batchId)) notFound();
  return <BatchDetailView snapshot={snapshot} mode={mode} contract={contract} batchId={batchId} />;
}
