import React, { createContext, useContext, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  LuLayoutDashboard, LuSearch, LuGitCompare, LuListChecks, LuTarget, LuFileText, LuCalculator, LuAward, LuCalendarDays,
  LuFlaskConical, LuSettings, LuDatabase, LuUser, LuMessageSquare, LuUsers, LuMenu, LuX, LuGraduationCap, LuEllipsis, LuMic, LuBookOpen, LuSearch as LuSearchIcon,
  LuMessagesSquare, LuLibrary, LuCreditCard,
} from 'react-icons/lu';
import { Assistant, VoiceFab, openAssistant } from './components/assistant';
import Interview from './pages/Interview';
import Glossary from './pages/Glossary';
import { Portal, Providers, cx } from './components/ui';
import { store, useStore } from './lib/store';
import { auth, serverCaps, type ServerCaps } from './lib/services';
import { reconcile, startAutoSync, syncStatus } from './lib/sync';
import { startReminders } from './lib/reminders';
import { registerColleges } from './data/colleges';
import ResetPassword from './pages/ResetPassword';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Profile from './pages/Profile';
import Colleges from './pages/Colleges';
import CollegePage from './pages/CollegePage';
import Compare from './pages/Compare';
import CollegeList from './pages/CollegeList';
import Analysis from './pages/Analysis';
import Essays from './pages/Essays';
import Costs from './pages/Costs';
import Scholarships from './pages/Scholarships';
import Tracker from './pages/Tracker';
import Strategist from './pages/Strategist';
import Research from './pages/Research';
import Community from './pages/Community';
import Preferences from './pages/Preferences';
import DataPage from './pages/DataPage';
import Advisor from './pages/Advisor';
import Library from './pages/Library';
import Pricing from './pages/Pricing';
import Admin from './pages/Admin';

export const NAV = [
  { group: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard', icon: LuLayoutDashboard }, { id: 'profile', label: 'Profile', icon: LuUser }] },
  { group: 'Colleges', items: [{ id: 'colleges', label: 'College search', icon: LuSearch }, { id: 'compare', label: 'Compare', icon: LuGitCompare }, { id: 'list', label: 'My college list', icon: LuListChecks }, { id: 'analysis', label: 'Admissions analysis', icon: LuTarget }] },
  { group: 'Apply', items: [{ id: 'essays', label: 'Essay lab', icon: LuFileText }, { id: 'interview', label: 'Interview coach', icon: LuMic }, { id: 'tracker', label: 'Application tracker', icon: LuCalendarDays }, { id: 'advisor', label: 'AI advisor', icon: LuMessagesSquare }, { id: 'strategist', label: 'AI strategist', icon: LuMessageSquare }] },
  { group: 'Pay', items: [{ id: 'costs', label: 'Cost calculator', icon: LuCalculator }, { id: 'scholarships', label: 'Scholarships', icon: LuAward }] },
  { group: 'Research', items: [{ id: 'research', label: 'Research center', icon: LuFlaskConical }, { id: 'library', label: 'Source library', icon: LuLibrary }, { id: 'community', label: 'Student experiences', icon: LuUsers }, { id: 'glossary', label: 'Glossary', icon: LuBookOpen }] },
  { group: 'Account', items: [{ id: 'pricing', label: 'Plans & billing', icon: LuCreditCard }, { id: 'preferences', label: 'Settings', icon: LuSettings }, { id: 'data', label: 'Data & privacy', icon: LuDatabase }] },
];
const MOBILE_TABS = [{ id: 'dashboard', label: 'Home', icon: LuLayoutDashboard }, { id: 'colleges', label: 'Search', icon: LuSearch }, { id: 'list', label: 'List', icon: LuListChecks }, { id: 'essays', label: 'Essays', icon: LuFileText }];

// ---------- routing ----------
const parse = () => (typeof location !== 'undefined' ? decodeURIComponent(location.hash.replace(/^#/, '')) : '') || 'home';
export function navigate(route: string) {
  if (parse() === route) { window.scrollTo({ top: 0 }); return; }
  location.hash = route;
}
export function useRoute() {
  const [r, setR] = useState(parse());
  useEffect(() => {
    const h = () => {
      const next = parse();
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      const reduce = document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Smooth cross-fade between pages where the browser supports View Transitions.
      if (doc.startViewTransition && !reduce) doc.startViewTransition(() => { flushSync(() => setR(next)); window.scrollTo({ top: 0 }); });
      else { setR(next); window.scrollTo({ top: 0 }); }
    };
    window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h);
  }, []);
  return r;
}
export function Link({ to, className, children, ...p }: { to: string; className?: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={`#${to}`} className={className} {...p}>{children}</a>;
}

// ---------- server capabilities ----------
const CapsCtx = createContext<{ caps: ServerCaps | null; checked: boolean }>({ caps: null, checked: false });
export const useCaps = () => useContext(CapsCtx);

function useTheme() {
  const prefs = useStore((s) => s.prefs);
  useEffect(() => {
    const root = document.documentElement;
    const viewer = root.getAttribute('data-viewer-theme') ?? root.getAttribute('data-theme');
    if (root.getAttribute('data-viewer-theme') === null) root.setAttribute('data-viewer-theme', viewer || '');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const v = root.getAttribute('data-viewer-theme');
      const t = prefs.theme === 'system' ? (v === 'dark' || v === 'light' ? v : mq.matches ? 'dark' : 'light') : prefs.theme;
      root.setAttribute('data-theme', t);
    };
    apply();
    mq.addEventListener('change', apply);
    if (prefs.reduceMotion) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
    return () => mq.removeEventListener('change', apply);
  }, [prefs.theme, prefs.reduceMotion]);
}

function Page({ route }: { route: string }) {
  if (route.startsWith('college-')) return <CollegePage id={route.slice(8)} />;
  switch (route) {
    case 'dashboard': return <Dashboard />;
    case 'profile': case 'profile-academics': case 'profile-transcript': case 'profile-activities': case 'profile-personal': case 'profile-financial': return <Profile route={route} />;
    case 'colleges': return <Colleges />;
    case 'compare': return <Compare />;
    case 'list': return <CollegeList />;
    case 'analysis': return <Analysis />;
    case 'essays': return <Essays />;
    case 'costs': return <Costs />;
    case 'scholarships': return <Scholarships />;
    case 'tracker': return <Tracker />;
    case 'strategist': return <Strategist />;
    case 'research': return <Research />;
    case 'community': return <Community />;
    case 'preferences': return <Preferences />;
    case 'data': return <DataPage />;
    case 'interview': return <Interview />;
    case 'glossary': return <Glossary />;
    case 'advisor': return <Advisor />;
    case 'library': return <Library />;
    case 'pricing': case 'billing': return <Pricing />;
    case 'admin': return <Admin />;
    default: return <NotFound />;
  }
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 text-muted">That link doesn't match any AdmitIQ page.</p>
      <a href="#dashboard" className="mt-6 inline-flex h-11 items-center rounded-xl bg-ink px-5 font-medium text-canvas">Go to dashboard</a>
    </div>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight text-ink', className)}>
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden><rect x="2" y="2" width="2.4" height="26" rx="1" fill="currentColor" /><path d="M4.4 4 L28 11.5 L4.4 19 Z" fill="var(--accent)" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
      <span className="font-display text-[24px] font-extrabold uppercase leading-none tracking-wide">AdmitIQ</span>
    </span>
  );
}

function Sidebar({ route, onNav }: { route: string; onNav?: () => void }) {
  const name = useStore((s) => s.profile.name);
  const demo = useStore((s) => s.meta.demo);
  const base = route.startsWith('college-') ? 'colleges' : route.startsWith('profile') ? 'profile' : route;
  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <a href="#home" className="px-5 pt-5 pb-3" onClick={onNav}><Logo /></a>
      <button onClick={() => { onNav?.(); setTimeout(() => openAssistant(), 220); }} className="mx-3 mb-4 flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm text-muted shadow-card transition-colors hover:border-ink/20 hover:text-ink">
        <LuSearchIcon className="shrink-0" /><span className="flex-1 text-left">Search or ask…</span><kbd className="hidden rounded border border-line px-1.5 text-[11px] lg:inline">⌘K</kbd>
      </button>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="px-3 pb-1.5 text-xs font-medium text-muted">{g.group}</div>
            <ul className="space-y-0.5">
              {g.items.map((it) => {
                const on = base === it.id;
                return (
                  <li key={it.id}>
                    <a href={`#${it.id}`} onClick={onNav} aria-current={on ? 'page' : undefined}
                      className={cx('group flex h-10 items-center gap-3 rounded-xl px-3 text-[14.5px] transition-colors', on ? 'bg-surface font-medium text-ink shadow-card ring-1 ring-line' : 'text-muted hover:bg-surface/60 hover:text-ink')}>
                      <it.icon className={cx('shrink-0 text-[17px] transition-colors', on ? 'text-accent' : 'text-muted group-hover:text-ink')} />{it.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line px-5 py-4 text-xs text-muted">
        <div className="truncate font-medium text-ink">{name || 'Your profile'}</div>
        <div>{demo ? 'Demo data loaded' : <SyncLabel />}</div>
      </div>
    </nav>
  );
}

function SyncLabel() {
  const [st, setSt] = useState(syncStatus.get());
  useEffect(() => syncStatus.subscribe(setSt), []);
  const u = auth.current();
  if (!u) return <>Stored privately in this browser</>;
  if (st.state === 'syncing') return <>Syncing…</>;
  if (st.state === 'error') return <span className="text-rose-600" title={st.error}>Sync failed — will retry on next change</span>;
  return <>Synced to {u.user.email}</>;
}

function AppShell({ route }: { route: string }) {
  const [menu, setMenuRaw] = useState(false);
  const [closing, setClosing] = useState(false);
  const setMenu = (v: boolean) => { if (v) { setClosing(false); setMenuRaw(true); } else if (menu) { setClosing(true); setTimeout(() => { setMenuRaw(false); setClosing(false); }, 200); } };
  const demo = useStore((s) => s.meta.demo);
  useEffect(() => { setMenuRaw(false); setClosing(false); }, [route]);
  useEffect(() => { document.body.style.overflow = menu ? 'hidden' : ''; }, [menu]);
  const base = route.startsWith('college-') ? 'colleges' : route;
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_minmax(0,1fr)]">
      <aside className="ivy-side sticky top-0 hidden h-dvh bg-ivy text-ivy-ink lg:block"><Sidebar route={route} /></aside>
      {/* Mobile top bar */}
      <header className="glass sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line px-4 lg:hidden">
        <a href="#dashboard"><Logo /></a>
        <div className="flex items-center"><button onClick={() => openAssistant()} aria-label="Search or ask" className="grid h-11 w-11 place-items-center rounded-xl text-ink hover:bg-raised"><LuSearchIcon className="text-xl" /></button><button onClick={() => setMenu(true)} aria-label="Open menu" className="grid h-11 w-11 place-items-center rounded-xl text-ink hover:bg-raised"><LuMenu className="text-xl" /></button></div>
      </header>
      {menu && (
        <Portal>
        <div className="fixed inset-0 z-[70] lg:hidden" role="dialog" aria-modal="true" aria-label="Menu" onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false); }}>
          <div className={cx(closing ? 'fade-out' : 'fade-in', 'absolute inset-0 bg-ink/30')} onClick={() => setMenu(false)} />
          <div className={cx(closing ? 'drawer-out' : 'drawer-in', 'absolute inset-y-0 left-0 w-[84%] max-w-[320px] bg-canvas shadow-2xl')}>
            <button onClick={() => setMenu(false)} aria-label="Close menu" className="absolute top-4 right-3 grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-raised"><LuX /></button>
            <Sidebar route={route} onNav={() => setMenu(false)} />
          </div>
        </div>
        </Portal>
      )}
      <main id="main" className="min-w-0 pb-[calc(88px+env(safe-area-inset-bottom))] lg:pb-12">
        {demo && <div className="border-b border-line bg-violet-500/[0.07] px-4 py-2 text-center text-xs text-ink sm:text-sm">You're exploring a fictional <b>demo student</b>. Nothing here is a real person or a real admissions result. <a href="#data" className="font-medium text-accent underline-offset-2 hover:underline">Clear demo data</a></div>}
        <div key={route} className={cx(!('startViewTransition' in document) && 'fade-up', 'mx-auto w-full max-w-[1240px] px-4 pt-6 sm:px-6 sm:pt-8 lg:px-10 lg:pt-10')}><Page route={route} /></div>
      </main>
      {/* Mobile bottom tab bar */}
      <nav aria-label="Quick" className="glass fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line pb-[env(safe-area-inset-bottom)] lg:hidden">
        {MOBILE_TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} aria-current={base === t.id ? 'page' : undefined} className={cx('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', base === t.id ? 'text-accent' : 'text-muted')}>
            <t.icon className="text-[21px]" />{t.label}
          </a>
        ))}
        <button onClick={() => setMenu(true)} className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted"><LuEllipsis className="text-[21px]" />More</button>
      </nav>
      <VoiceFab />
      <Assistant />
    </div>
  );
}

// Reveal cards and sections as they scroll into view, staggered within each batch.
function startReveal() {
  if (typeof IntersectionObserver === 'undefined') { document.querySelectorAll('.rv').forEach((e) => e.classList.add('in')); return () => {}; }
  const io = new IntersectionObserver((entries) => {
    let k = 0;
    for (const e of entries) if (e.isIntersecting) { const el = e.target as HTMLElement; el.style.setProperty('--rv-d', `${Math.min(6, k++) * 55}ms`); el.classList.add('in'); io.unobserve(el); }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  const scan = () => document.querySelectorAll('.rv:not(.in):not([data-rv-seen])').forEach((el) => { el.setAttribute('data-rv-seen', ''); io.observe(el); });
  scan();
  const mo = new MutationObserver(scan); mo.observe(document.body, { childList: true, subtree: true });
  return () => { io.disconnect(); mo.disconnect(); };
}

export default function App() {
  const route = useRoute();
  useTheme();
  const [caps, setCaps] = useState<{ caps: ServerCaps | null; checked: boolean }>({ caps: null, checked: false });
  useEffect(() => { serverCaps().then((c) => setCaps({ caps: c, checked: true })); }, []);
  useEffect(() => {
    const cfg = caps.caps?.supabase;
    if (!cfg) return;
    let fresh = false;
    try { fresh = sessionStorage.getItem('admitiq:justSignedIn') === '1'; sessionStorage.removeItem('admitiq:justSignedIn'); } catch { /* ignore */ }
    if (auth.current()) reconcile(cfg).then((r) => { if (fresh && r === 'pulled') store.set((s) => { s.meta.onboarded = true; }); });
    return startAutoSync(cfg);
  }, [caps.caps]);
  useEffect(() => startReminders(), []);
  useEffect(() => startReveal(), []);
  const onboarded = useStore((s) => s.meta.onboarded);
  registerColleges(useStore((s) => s.customColleges)); // colleges added from the national directory
  useEffect(() => { document.title = route === 'home' ? 'AdmitIQ — Your college strategy, backed by data' : `${route.replace(/^college-/, '').replace(/-/g, ' ').replace(/^\w/, (m) => m.toUpperCase())} · AdmitIQ`; }, [route]);
  void store; void onboarded;
  let content: React.ReactNode;
  if (route === 'home') content = <Landing />;
  else if (route === 'login') content = <Login />;
  else if (route === 'onboarding') content = <Onboarding />;
  else if (route === 'reset-password') content = <ResetPassword />;
  else content = <AppShell route={route} />;
  return <CapsCtx.Provider value={caps}><Providers>{content}</Providers></CapsCtx.Provider>;
}
