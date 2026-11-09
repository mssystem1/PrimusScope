import { getServingState } from "@primusscope/data";
import { FinanceView } from "../../components/data-ui";

export default async function FinancePage() {
  const { snapshot, mode } = await getServingState();
  return <FinanceView snapshot={snapshot} mode={mode} />;
}
