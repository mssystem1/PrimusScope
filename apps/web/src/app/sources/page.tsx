import { DataAccessError, getIndexerStatus, getServingState } from "@primusscope/data";
import { SourcesUnavailableView, SourcesView } from "../../components/data-ui";

export default async function SourcesPage() {
  try {
    const { snapshot, mode, indexerStatus } = await getServingState();
    return <SourcesView snapshot={snapshot} mode={mode} indexerStatus={indexerStatus ?? await getIndexerStatus()} />;
  } catch (error) {
    if (error instanceof DataAccessError && error.code === 'PUBLICATION_QUARANTINED') {
      return <SourcesUnavailableView status={await getIndexerStatus()} />;
    }
    throw error;
  }
}
