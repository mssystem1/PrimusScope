"use client";

import Link from "next/link";
import { RotateCcw, TriangleAlert } from "lucide-react";

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="page-content"><section className="panel empty-state"><div className="empty-icon"><TriangleAlert size={26} /></div><span className="eyebrow">OBSERVATIONS TEMPORARILY UNAVAILABLE</span><h1>This view could not be loaded</h1><p>The observation data service could not complete this request. Try loading the view again or inspect the source status.</p><div className="button-row"><button className="button button-primary" onClick={reset}><RotateCcw size={15} />Try again</button><Link className="button button-secondary" href="/sources">Sources & coverage</Link></div></section></div>;
}
