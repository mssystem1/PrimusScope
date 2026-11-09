import { getServingMode } from "@primusscope/data";
import { DevelopersView } from "../../components/data-ui";

export default function DevelopersPage() { return <DevelopersView mode={getServingMode()} />; }
