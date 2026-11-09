import { getServingMode } from "@primusscope/data";
import type { Metadata } from "next";
import { AppShell } from "../components/shell";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "PrimusScope — Primus ecosystem intelligence", template: "%s · PrimusScope" },
  description: "Source-backed analytics for Primus confidential finance and zkTLS Network. Explore public batches, tasks, coverage and developer interfaces.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let mode: "recorded_observations" | "indexed_observations" | "unavailable";
  try { mode = getServingMode(); } catch { mode = "unavailable"; }
  return <html lang="en"><body><AppShell mode={mode}>{children}</AppShell></body></html>;
}
