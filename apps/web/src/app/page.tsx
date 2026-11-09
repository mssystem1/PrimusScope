import { getServingState } from "@primusscope/data";
import { OverviewView } from "../components/data-ui";

export default async function OverviewPage() {
  const { snapshot, mode } = await getServingState();
  return <OverviewView snapshot={snapshot} mode={mode} />;
}
