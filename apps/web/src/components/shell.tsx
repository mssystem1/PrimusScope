"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bookmark, Boxes, Braces, ChevronRight, Database, LayoutDashboard, Menu, Search, Shield, X } from "lucide-react";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/finance", label: "Finance", icon: Boxes },
  { href: "/network", label: "zkTLS Network", icon: Activity },
  { href: "/explore", label: "Explorer", icon: Search },
  { href: "/workspace", label: "Workspace", icon: Bookmark },
  { href: "/developers", label: "Developers", icon: Braces },
  { href: "/sources", label: "Sources & coverage", icon: Database },
];

export function AppShell({ children, mode = "recorded_observations" }: { children: React.ReactNode; mode?: "recorded_observations" | "indexed_observations" | "unavailable" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => { setMobile(query.matches); if (!query.matches) setOpen(false); };
    sync(); query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!open || !mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKey); menuRef.current?.focus(); };
  }, [open, mobile]);
  const current = links.find((link) => link.href === "/" ? pathname === "/" : pathname.startsWith(link.href));
  return <div className="app-frame">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside ref={sidebarRef} className={`sidebar ${open ? "is-open" : ""}`} id="main-navigation" role={open && mobile ? "dialog" : undefined} aria-modal={open && mobile ? true : undefined} aria-label={open && mobile ? "Navigation menu" : undefined} inert={mobile && !open ? true : undefined}>
      {open && mobile && <button className="drawer-close icon-button" aria-label="Close navigation" onClick={() => setOpen(false)}><X size={20} /></button>}
      <Link className="brand" href="/" onClick={() => setOpen(false)} aria-label="PrimusScope home">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
        <span>Primus<span className="brand-accent">Scope</span><small>ECOSYSTEM INTELLIGENCE</small></span>
      </Link>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        {links.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return <Link key={href} href={href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}><Icon size={17} strokeWidth={1.7} /><span>{label}</span>{active && <ChevronRight className="nav-chevron" size={13} />}</Link>;
        })}
      </nav>
      <div className="sidebar-bottom">
        <div className="independent-card"><Shield size={16} /><div>Independent by design<span>Read-only. Source-backed.</span></div></div>
        <a className="official-link" href="https://dapp.primuslabs.xyz/" target="_blank" rel="noopener noreferrer">Open official Primus dApp <ArrowUpRight size={14} /></a>
        <span className="sidebar-version">PrimusScope · Observation release 01</span>
      </div>
    </aside>
    {open && <button className="nav-backdrop" aria-label="Close navigation backdrop" tabIndex={-1} onClick={() => setOpen(false)} />}
    <div className="app-main" inert={open && mobile ? true : undefined} aria-hidden={open && mobile ? true : undefined}>
      <header className="topbar">
        <button ref={menuRef} className="mobile-menu icon-button" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls="main-navigation" onClick={() => setOpen(!open)}>{open ? <X size={20} /> : <Menu size={20} />}</button>
        <div className="breadcrumb"><span>Primus ecosystem</span><ChevronRight size={12} /><strong>{current?.label ?? "Explorer"}</strong></div>
        <div className="topbar-actions"><Link className="global-search" href="/explore" aria-label="Search observations"><Search size={15} /><span>Search observations</span></Link><Link className="snapshot-pill" href="/sources"><span className="status-dot amber" /><span>{mode === "indexed_observations" ? "Indexed observations" : mode === "unavailable" ? "Data unavailable" : "Recorded observations"}</span></Link></div>
      </header>
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="app-footer"><span>Independent analytics for the Primus ecosystem.</span><Link href="/sources">Every number has a source <ArrowUpRight size={12} /></Link></footer>
    </div>
  </div>;
}
