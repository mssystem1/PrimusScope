import { getServingState } from "@primusscope/data";
import { NetworkView } from "../../components/data-ui";

export default async function NetworkPage() {
  const { snapshot, mode } = await getServingState();
  return <NetworkView snapshot={snapshot} mode={mode} />;
}
