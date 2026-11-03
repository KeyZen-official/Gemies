'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard, Package, FolderTree, ShoppingCart, Tag, Users, Mail,
  Settings as SettingsIcon, ScrollText, Search, ExternalLink, LogOut, Menu, X, ShieldCheck,
  RefreshCcw, Wallet as WalletIcon,
} from 'lucide-react';
import { api } from '../../api.js';
import { useStore, useResource, Logo } from '../../components.jsx';
import { Btn } from './kit.jsx';

/**
 * The admin frame: a 56px header over a 220px sidebar and a grey canvas.
 *
 * Not the storefront chrome. An operator has no use for a cart, a wishlist or
 * the shop mega menu, and a marketing footer with a newsletter signup has no
 * business under an order list, so src/app/shell.jsx leaves all of it out for
 * /admin and this supplies what the tool actually needs.
 *
 * Sections are grouped rather than laid out as one flat strip. With nine of
 * them in a single horizontal row the ones on the right -- Settings, Audit --
 * were off-screen on a laptop and effectively undiscoverable.
 */

export const ADMIN_NAV = [
  { group: 'Overview', items: [['overview', 'Overview', LayoutDashboard]] },
  { group: 'Catalogue', items: [['products', 'Products', Package], ['categories', 'Categories', FolderTree]] },
  { group: 'Sales', items: [['orders', 'Orders', ShoppingCart], ['exchanges', 'Exchanges', RefreshCcw], ['coupons', 'Discount codes', Tag]] },
  { group: 'People', items: [['customers', 'Customers', Users], ['wallets', 'Wallets', WalletIcon], ['enquiries', 'Enquiries', Mail]] },
  { group: 'Store', items: [['settings', 'Settings', SettingsIcon], ['audit', 'Audit trail', ScrollText]] },
];

export const ADMIN_TABS = ADMIN_NAV.flatMap((section) => section.items.map(([id]) => id));
export const ADMIN_LABELS = Object.fromEntries(ADMIN_NAV.flatMap((s) => s.items.map(([id, label]) => [id, label])));

export function AdminShell({ tab, onTab, search, onSearch, children }) {
  const { user, refreshUser, notify } = useStore();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const searchRef = useRef(null);

  // Only the count, for the sidebar badge: limit=1 keeps the payload to a
  // single row while `open` in the envelope carries the real total.
  const enquiries = useResource('/admin/contact?status=open&limit=1');
  const openCount = enquiries.data?.open ?? 0;

  // Ctrl/Cmd+K focuses the search, which is what the hint in the field claims.
  // A shortcut shown in the UI that does nothing is worse than no shortcut.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The drawer must not survive a navigation, or the next section opens behind it.
  useEffect(() => { setDrawer(false); }, [tab]);

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
      await refreshUser();
      router.push('/');
    } catch (error) {
      notify(error.message);
    }
  }

  return (
    <div className="min-h-screen bg-admin-bg font-inter text-admin-text">
      <header className="sticky top-0 z-40 h-14 border-b border-admin-border bg-admin-surface">
        <div className="mx-auto flex h-full items-center gap-3 px-4 lg:px-6">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open navigation"
            className="grid size-9 shrink-0 place-items-center rounded-[9px] text-admin-text-2 hover:bg-admin-bg lg:hidden"
          >
            <Menu size={18} strokeWidth={2} />
          </button>

          <Link href="/admin" aria-label="Store dashboard" className="shrink-0">
            <Logo className="text-[17px] lg:text-[18px]" />
          </Link>
          <span className="hidden h-5 w-px shrink-0 bg-admin-border sm:block" />
          <span className="hidden shrink-0 text-[13px] font-medium text-admin-text-2 sm:block">Store management</span>

          {/* Scopes the search to whichever list is open, so it filters real
              rows rather than pretending to search the whole store. */}
          <form
            role="search"
            className="relative mx-auto hidden w-full max-w-[420px] md:block"
            onSubmit={(event) => { event.preventDefault(); onSearch(searchRef.current?.value.trim() ?? ''); }}
          >
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-admin-muted">
              <Search size={15} strokeWidth={2} />
            </span>
            <input
              ref={searchRef}
              defaultValue={search}
              key={tab}
              placeholder="Search anything…"
              aria-label={`Search ${ADMIN_LABELS[tab] ?? ''}`}
              className="h-9 w-full rounded-[9px] border border-admin-border bg-admin-bg pr-16 pl-9 text-[13px] text-admin-text placeholder:text-admin-muted focus:border-admin-text focus:bg-admin-surface focus-visible:outline-none"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-[5px] border border-admin-border bg-admin-surface px-1.5 py-0.5 text-[11px] font-medium text-admin-muted">
              Ctrl K
            </kbd>
          </form>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 md:ml-0">
            <Link
              href="/"
              className="hidden items-center gap-1.5 rounded-[9px] px-2.5 py-2 text-[13px] font-medium text-admin-text-2 hover:bg-admin-bg hover:text-admin-text lg:inline-flex"
            >
              View store <ExternalLink size={13} strokeWidth={2} />
            </Link>
            {user?.email && (
              <span className="hidden max-w-[200px] items-center gap-1.5 truncate px-2 text-[13px] text-admin-text-2 xl:inline-flex" title={user.email}>
                <ShieldCheck size={14} strokeWidth={2} className="shrink-0 text-admin-accent" />
                {user.email}
              </span>
            )}
            <Btn variant="secondary" size="sm" icon={LogOut} onClick={signOut}>
              <span className="hidden sm:inline">Sign out</span>
            </Btn>
          </div>
        </div>
      </header>

      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden border-r border-admin-border bg-admin-surface lg:block">
          <Nav tab={tab} onTab={onTab} openCount={openCount} className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-3 py-5" />
        </aside>

        {/* Mobile drawer. Rendered only while open so it cannot trap focus or
            intercept taps when closed. */}
        {drawer && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div aria-hidden="true" className="absolute inset-0 bg-[#0f172a]/40" onClick={() => setDrawer(false)} />
            <div className="relative h-full w-[260px] max-w-[82vw] overflow-y-auto border-r border-admin-border bg-admin-surface">
              <div className="flex h-14 items-center justify-between border-b border-admin-border px-4">
                <span className="text-[13px] font-semibold">Sections</span>
                <button
                  type="button"
                  onClick={() => setDrawer(false)}
                  aria-label="Close navigation"
                  className="grid size-8 place-items-center rounded-[8px] text-admin-text-2 hover:bg-admin-bg"
                >
                  <X size={16} strokeWidth={2.2} />
                </button>
              </div>
              <Nav tab={tab} onTab={onTab} openCount={openCount} className="px-3 py-4" />
            </div>
          </div>
        )}

        <main className="min-w-0 px-4 py-6 md:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  );
}

function Nav({ tab, onTab, openCount, className = '' }) {
  return (
    <nav aria-label="Admin sections" className={className}>
      {ADMIN_NAV.map((section, index) => (
        <div key={section.group} className={index ? 'mt-5' : ''}>
          {/* The first group's label is dropped: a single "Overview" item under
              an "OVERVIEW" heading is the same word twice. */}
          {index > 0 && (
            <h2 className="mb-1.5 px-3 text-[11px] font-semibold tracking-[0.1em] text-admin-muted uppercase">
              {section.group}
            </h2>
          )}
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {section.items.map(([id, label, IconComponent]) => {
              const active = tab === id;
              const badge = id === 'enquiries' && openCount > 0 ? openCount : null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onTab(id)}
                    className={`flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left text-[14px] font-medium transition-colors ${
                      active ? 'bg-admin-text text-white' : 'text-admin-text-2 hover:bg-admin-bg hover:text-admin-text'
                    }`}
                  >
                    <IconComponent size={16} strokeWidth={2} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {badge && (
                      <span className={`grid min-w-5 place-items-center rounded-full px-1.5 py-0.5 text-[11px] font-bold ${
                        active ? 'bg-white text-admin-text' : 'bg-admin-danger text-white'
                      }`}>
                        {badge}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Shown instead of the panels when a non-administrator reaches /admin. */
export function AdminDenied() {
  return (
    <div className="grid min-h-screen place-items-center bg-admin-bg px-6 font-inter">
      <div className="w-full max-w-[420px] rounded-[14px] border border-admin-border bg-admin-surface p-7 text-center">
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-[#f1f5f9] text-admin-text-2">
          <ShieldCheck size={22} strokeWidth={1.8} />
        </span>
        <h1 className="m-0 mb-2 text-[20px] font-bold text-admin-text">Administrator access required</h1>
        <p className="m-0 mb-6 text-[14px] leading-relaxed text-admin-text-2">
          Sign in with an authorised store administrator account.
        </p>
        <Link
          href="/login?next=/admin"
          className="inline-flex h-10 items-center justify-center rounded-[9px] bg-admin-text px-6 text-[13px] font-semibold text-white"
        >
          Sign in
        </Link>
        <Link href="/" className="mt-4 block text-[13px] text-admin-text-2 underline underline-offset-4">
          Back to the store
        </Link>
      </div>
    </div>
  );
}
