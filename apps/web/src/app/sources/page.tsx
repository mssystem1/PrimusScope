import { getIndexerStatus, getServingState } from "@primusscope/data";
import { SourcesUnavailableView, SourcesView } from "../../components/data-ui";

export default async function SourcesPage() {
  const indexerStatus = await getIndexerStatus();
  if (indexerStatus.mode === "indexed_observations" && indexerStatus.publication !== "available") {
    return <SourcesUnavailableView status={indexerStatus} />;
  }
  const { snapshot, mode } = await getServingState();
  return <SourcesView snapshot={snapshot} mode={mode} indexerStatus={indexerStatus} />;
}
