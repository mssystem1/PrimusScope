import { getServingState } from "@primusscope/data";
import { ExplorerView } from "../../components/data-ui";

export default async function ExplorerPage() {
  const { snapshot, mode } = await getServingState();
  return <ExplorerView snapshot={snapshot} mode={mode} />;
}
