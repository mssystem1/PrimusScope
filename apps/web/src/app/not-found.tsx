import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";

export default function NotFound() {
  return <div className="page-content"><section className="panel empty-state"><div className="empty-icon"><Search size={26} /></div><span className="eyebrow">OUTSIDE THIS COVERED VIEW</span><h1>No record in this coverage</h1><p>This page or public object is not available in the covered observations. It may exist outside the sampled contracts or block ranges.</p><div className="button-row"><Link className="button button-primary" href="/explore">Search observations <ArrowRight size={15} /></Link><Link className="button button-secondary" href="/sources">Inspect source coverage</Link></div></section></div>;
}
