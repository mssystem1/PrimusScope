import { getServingMode, getServingState, type PublicIndexerStatus } from "@primusscope/data";
import type { Metadata } from "next";
import { AppShell } from "../components/shell";
import { PublicationRefresh } from '../components/publication-refresh';
import { CollectionSchedule } from '../components/collection-schedule';
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "PrimusScope — Primus ecosystem intelligence", template: "%s · PrimusScope" },
  description: "Source-backed analytics for Primus confidential finance and zkTLS Network. Explore public batches, tasks, coverage and developer interfaces.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let mode: "recorded_observations" | "indexed_observations" | "unavailable";
  try { mode = getServingMode(); } catch { mode = "unavailable"; }
  let recovery:string|undefined;
  let publication:{snapshotId:string;publishedAt:string;indexerStatus:PublicIndexerStatus|null}|undefined;
  if(mode==='indexed_observations')try{const state=await getServingState();mode=state.mode;recovery=state.indexerStatus?.recovery?.source;publication={snapshotId:state.snapshot.snapshotId,publishedAt:state.snapshot.generatedAt,indexerStatus:state.indexerStatus};}catch{}
  return <html lang="en"><body><AppShell mode={mode}>{publication&&<PublicationRefresh snapshotId={publication.snapshotId} indexerStatus={publication.indexerStatus}/>} {recovery&&<aside className="storage-recovery-notice" role="status"><strong>Live storage is temporarily unavailable.</strong> {recovery==='bundled_snapshot'?'Showing the retained recovery snapshot.':'Showing the last validated observations available to this server.'} Source dates below show its age. New collection may be delayed; Neon history has been preserved.</aside>}{publication?.indexerStatus&&<CollectionSchedule status={publication.indexerStatus} publishedAt={publication.publishedAt} initialNow={Date.now()}/>} {children}</AppShell></body></html>;
}
