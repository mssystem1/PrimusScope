'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from 'react';
import { Check, LoaderCircle } from 'lucide-react';

const NavigationContext = createContext<{ pending: boolean; navigate: (href: string, label: string) => void } | null>(null);

export function useAnalyticsNavigation() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('Analytics navigation requires its dashboard provider.');
  return value;
}

export function AnalyticsNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('dashboard');
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [pending]);

  function navigate(href: string, nextLabel: string) {
    if (pending) return;
    const target = new URL(href, window.location.href), current = new URL(window.location.href);
    target.searchParams.sort(); current.searchParams.sort();
    if (target.href === current.href) return;
    setLabel(nextLabel);
    startTransition(() => router.push(href, { scroll: false }));
  }

  return <NavigationContext.Provider value={{ pending, navigate }}>
    {pending && <div className="analytics-pending" role="status" aria-live="polite">
      <div className="analytics-progress" role="progressbar" aria-label="Updating analytics"><span /></div>
      <div className="analytics-pending-message"><LoaderCircle size={18} aria-hidden="true" /><div><strong>{slow ? 'Still loading' : 'Loading'} {label}…</strong><p>The earlier period stays visible until the new dashboard is ready.</p></div></div>
    </div>}
    <div className="analytics-navigation-content" aria-busy={pending}>{children}</div>
  </NavigationContext.Provider>;
}

export function AnalyticsPeriodLink({ href, label, active, compact = false }: { href: string; label: string; active: boolean; compact?: boolean }) {
  const { pending, navigate } = useAnalyticsNavigation();
  return <Link className="button button-secondary button-small" href={href} prefetch={false}
    aria-label={label} aria-current={active ? 'page' : undefined} aria-disabled={pending || undefined}
    onNavigate={event => { event.preventDefault(); if (!active) navigate(href, label.replace(/^Compare /, '')); }}>{active&&<Check size={14} aria-hidden="true"/>}{compact ? label.replace(/^Compare /, '').replace(' hours', 'h').replace(' days', 'd') : label}</Link>;
}
