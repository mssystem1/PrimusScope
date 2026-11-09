import { notFound } from "next/navigation";
import { getServingState } from "@primusscope/data";
import { TaskDetailView } from "../../../../../../components/data-ui";

export default async function TaskPage({ params }: { params: Promise<{ chainId: string; taskContract: string; taskId: string }> }) {
  const { chainId, taskContract, taskId } = await params;
  const { snapshot, mode } = await getServingState();
  if (chainId !== "8453" || taskContract.toLowerCase() !== snapshot.network.taskContract.toLowerCase() || !snapshot.network.events.some((event) => event.taskId?.toLowerCase() === taskId.toLowerCase())) notFound();
  return <TaskDetailView snapshot={snapshot} mode={mode} taskId={taskId.toLowerCase()} />;
}
