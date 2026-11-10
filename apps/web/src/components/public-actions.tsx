"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ArrowRight, Bookmark, Check, Copy, ExternalLink, Play, RefreshCw, Search, Trash2 } from "lucide-react";

export function RefreshObservations() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button className="button button-secondary" disabled={pending} onClick={() => startTransition(() => router.refresh())} aria-label="Refresh view from stored observations"><RefreshCw size={15} aria-hidden="true" />{pending ? "Refreshing…" : "Refresh view"}</button>;
}

export type SavedItem = { id: string; title: string; href: string; domain: "finance" | "network" | "view"; savedAt: string };
const STORAGE = "primusscope.public-workspace.v1";
const EVENT = "primusscope-workspace-change";

function readSaved(): SavedItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).filter((item): item is SavedItem => typeof item === "object" && item !== null && typeof item.id === "string" && item.id.length <= 256 && typeof item.title === "string" && item.title.length <= 200 && typeof item.href === "string" && item.href.length <= 512 && /^\/(finance|network|explore)(\/|$|\?|#)/.test(item.href) && ["finance", "network", "view"].includes(item.domain) && typeof item.savedAt === "string" && Number.isFinite(Date.parse(item.savedAt))).slice(0, 50).map(({ id, title, href, domain, savedAt }) => ({ id, title, href, domain, savedAt }));
  } catch { return []; }
}

function writeSaved(items: SavedItem[]) {
  localStorage.setItem(STORAGE, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT));
}

export function SaveButton({ item, compact = false }: { item: Omit<SavedItem, "savedAt">; compact?: boolean }) {
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const sync = () => setSaved(readSaved().some((entry) => entry.id === item.id));
    sync(); window.addEventListener(EVENT, sync); window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, [item.id]);
  return <><button className={`button ${compact ? "button-small" : ""} ${saved ? "is-saved" : "button-secondary"}`} aria-label={`${saved ? "Saved" : "Save"} ${item.title}`} aria-pressed={saved} onClick={() => {
    try {
      const items = readSaved();
      writeSaved(saved ? items.filter((entry) => entry.id !== item.id) : [{ ...item, savedAt: new Date().toISOString() }, ...items.filter((entry) => entry.id !== item.id)].slice(0, 50));
      setMessage(saved ? "Removed from this browser." : "Saved in this browser.");
    } catch { setMessage("Browser storage is unavailable. This item could not be saved."); }
  }}>{saved ? <Check size={15} /> : <Bookmark size={15} />}{saved ? "Saved" : "Save view"}</button><span className="sr-only" role="status">{message}</span></>;
}

export function CopyButton({ value, label = "Copy", copyAsUrl = false }: { value: string; label?: string; copyAsUrl?: boolean }) {
  const [message, setMessage] = useState("");
  useEffect(() => setMessage(''), [value]);
  return <button className="button button-small button-secondary" aria-label={message || label} onClick={async () => {
    try { await navigator.clipboard.writeText(copyAsUrl ? new URL(value, window.location.origin).href : value); setMessage("Copied"); } catch { setMessage("Copy unavailable"); }
  }}><Copy size={14} />{message || label}<span className="sr-only" role="status">{message}</span></button>;
}

export function PublicWorkspace() {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const sync = () => { setItems(readSaved()); setReady(true); };
    sync(); window.addEventListener(EVENT, sync); window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  function remove(id?: string) {
    try { writeSaved(id ? readSaved().filter((item) => item.id !== id) : []); setMessage(id ? "Item removed." : "All saved items cleared."); } catch { setMessage("Browser storage is unavailable."); }
  }
  return <section className="panel workspace-panel"><div className="panel-heading"><div><h2>Saved in this browser</h2><p>Public objects and views you choose to follow.</p></div><button className="button button-secondary button-small" onClick={() => remove()} disabled={!items.length}><Trash2 size={14} />Clear saved items</button></div>
    {!ready ? <p className="empty-copy">Loading your saved views…</p> : items.length === 0 ? <div className="empty-state"><div className="empty-icon"><Bookmark size={26} /></div><h3>Your next visit starts here.</h3><p>Save a vault, a task or a network view to keep it close. No wallet connection is needed.</p><div className="button-row"><Link className="button button-primary" href="/finance">Explore finance <ArrowRight size={15} /></Link><Link className="button button-secondary" href="/network">Explore network</Link></div></div> : <div className="saved-list">{items.map((item) => <div className="saved-item" key={item.id}><span className={`domain-icon ${item.domain}`}><Bookmark size={17} /></span><div><span className="eyebrow">{item.domain === "view" ? "SAVED VIEW" : item.domain.toUpperCase()}</span><Link href={item.href}>{item.title}</Link><small>Saved {new Date(item.savedAt).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })} · This browser only</small></div><button className="icon-button" aria-label={`Remove ${item.title}`} onClick={() => remove(item.id)}><Trash2 size={16} /></button></div>)}</div>}
    <p className="muted small" role="status">{message}</p><div className="panel-footnote">Saved preferences contain public object identifiers only. Private balances, signatures and proof payloads are never saved here.</div>
  </section>;
}

type LookupMatch = { type: string; id: string; label: string; chainId: number; href: string; contractAddress?: string; taskId?: string; transactionHash?: string };
export function ExplorerSearch({ exampleTask, mode = "recorded_observations" }: { exampleTask?: string; mode?: "recorded_observations" | "indexed_observations" }) {
  const [identifier, setIdentifier] = useState("");
  const [type, setType] = useState("auto");
  const [pending, setPending] = useState(false);
  const [matches, setMatches] = useState<LookupMatch[] | null>(null);
  const [error, setError] = useState("");
  async function search(value: string) {
    setPending(true); setError(""); setMatches(null);
    try {
      const response = await fetch("/api/v1/explore/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, identifier: value.trim() }), cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? result.message ?? "The search could not be completed.");
      if (!Array.isArray(result.matches)) throw new Error("Search results are temporarily unavailable.");
      setMatches(result.matches);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The search could not be completed."); }
    finally { setPending(false); }
  }
  return <section className="panel search-panel"><form onSubmit={(event) => { event.preventDefault(); void search(identifier); }}><label className="field-label" htmlFor="explorer-query">Task ID, transaction hash, or contract address</label><div className="search-controls"><div className="large-search"><Search size={19} /><input id="explorer-query" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="Paste a public identifier, starting with 0x…" maxLength={256} autoComplete="off" spellCheck={false} required /></div><select aria-label="Identifier type" value={type} onChange={(event) => setType(event.target.value)}><option value="auto">Detect type</option><option value="task">Task ID</option><option value="transaction">Transaction hash</option><option value="contract">Contract address</option></select><button className="button button-primary" disabled={pending} type="submit">{pending ? "Searching…" : "Search observations"}<ArrowRight size={16} /></button></div><p className="small muted">Searches the {mode === "indexed_observations" ? "indexed" : "recorded"} coverage only. A task hash can also match a transaction; all matching objects are shown.</p></form>
    {exampleTask && <button className="example-query" onClick={() => { setIdentifier(exampleTask); void search(exampleTask); }}>Try an observed task <ArrowRight size={13} /></button>}
    <div aria-live="polite">{error && <p className="inline-error" role="alert">{error}</p>}{matches && <section className="lookup-results" aria-label="Search results"><div className="result-summary">{matches.length ? `${matches.length} matching ${matches.length === 1 ? "object" : "objects"}` : mode === "indexed_observations" ? "No match in this indexed scope" : "No match in this recorded scope"}</div>{matches.length === 0 && <p className="muted">Check the identifier and source coverage. This result does not establish that a task or transaction does not exist elsewhere.</p>}{matches.map((match) => <Link className="lookup-result" key={`${match.type}:${match.id}`} href={match.href}><div><span className="eyebrow">{match.type.toUpperCase()} · {match.chainId === 56 ? "BNB SMART CHAIN" : "BASE"}</span><strong>{match.label}</strong><span className="mono">{(match.taskId ?? match.transactionHash ?? match.contractAddress ?? match.id).slice(0, 18)}…</span></div><ArrowRight size={18} /></Link>)}</section>}</div>
  </section>;
}

const endpoints = [
  { label: "Ecosystem overview", path: "/api/v1/overview" },
  { label: "Finance vault directory", path: "/api/v1/finance/vaults" },
  { label: "Finance dashboard analytics", path: "/api/v1/finance/analytics?range=30d" },
  { label: "Network dashboard analytics", path: "/api/v1/network/analytics?range=24h&interval=hour" },
  { label: "Network summary", path: "/api/v1/network/summary" },
  { label: "Network activity events", path: "/api/v1/network/events?limit=10" },
  { label: "Source status", path: "/api/v1/status/sources" },
];

export function ApiPlayground({ mode = "recorded_observations" }: { mode?: "recorded_observations" | "indexed_observations" }) {
  const [path, setPath] = useState(endpoints[0].path);
  const [response, setResponse] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  return <section className="panel playground"><div className="panel-heading"><div><span className="eyebrow">READ-ONLY API</span><h2>Explore the response</h2><p>Anonymous endpoints. The same {mode === "indexed_observations" ? "stored indexed" : "recorded"} observations used in the app.</p></div><span className="pill teal">GET</span></div><div className="playground-controls"><label className="sr-only" htmlFor="api-endpoint">API endpoint</label><select id="api-endpoint" value={path} onChange={(event) => { setPath(event.target.value); setResponse(""); setStatus(""); }}>{endpoints.map((endpoint) => <option key={endpoint.path} value={endpoint.path}>{endpoint.label} — {endpoint.path}</option>)}</select><button className="button button-primary" disabled={pending} onClick={async () => { setPending(true); try { const result = await fetch(path, { cache: "no-store" }); const json = await result.json(); setStatus(`${result.status} ${result.ok ? "OK" : "Error"}`); setResponse(JSON.stringify(json, null, 2)); } catch { setStatus("Request failed"); setResponse("The endpoint could not be reached. Try again when the service is available."); } finally { setPending(false); } }}><Play size={14} />{pending ? "Running…" : "Run request"}</button></div><div className="code-toolbar"><code>GET {path}</code><span role="status">{status || "Awaiting request"}</span></div><pre className="json-response" tabIndex={0} aria-label="API response">{response || "// Run a request to inspect source, scope and observation metadata."}</pre><div className="panel-footnote"><a href={path} target="_blank" rel="noopener noreferrer">Open endpoint <ExternalLink size={12} /></a>{response && <CopyButton value={response} label="Copy response" />}</div></section>;
}
