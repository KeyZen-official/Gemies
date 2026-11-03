'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Inbox, Search, X, Loader2, MoreHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { useResource } from '../../components.jsx';
import { pageList } from '../../lib/page-list.js';

/**
 * The admin design system: every surface, control and state the panels are
 * built from.
 *
 * One file rather than one per component because these are small and only
 * meaningful together -- a Card whose radius disagrees with a Modal's is the
 * exact problem this is meant to prevent. The tokens live in tailwind.css
 * under the `admin-` prefix.
 *
 * Scale, fixed here so no panel invents its own:
 *
 *   page heading   28px / 700      section heading  18px / 600
 *   KPI value      30px / 700      card label       13px / 500
 *   body           14px / 400      navigation       14px / 500
 *   table head     11px / 600 caps buttons          13px / 600
 */

/* ------------------------------------------------------------------ surfaces */

export const CARD = 'rounded-[14px] border border-admin-border bg-admin-surface';

export function Card({ className = '', children, ...rest }) {
  return <section className={`${CARD} ${className}`} {...rest}>{children}</section>;
}

/**
 * A card with a titled header, optionally introduced by an icon in a tinted
 * square, and an action on the right.
 */
export function SectionCard({ title, subtitle, icon: IconComponent, tone = 'slate', action, children, bodyClassName = 'p-5', className = '' }) {
  return (
    <Card className={className}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-admin-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            {IconComponent && (
              <span className={`grid size-9 shrink-0 place-items-center rounded-[10px] ${TINTS[tone]}`}>
                <IconComponent size={17} strokeWidth={1.9} />
              </span>
            )}
            <div className="min-w-0">
              <h2 className="m-0 text-[18px] leading-tight font-semibold tracking-[-0.01em] text-admin-text">{title}</h2>
              {subtitle && <p className="m-0 mt-0.5 text-[13px] text-admin-text-2">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}

/** Pale icon backgrounds. Deliberately tints, not full-bleed coloured cards. */
export const TINTS = {
  green: 'bg-[#dcfce7] text-admin-accent',
  blue: 'bg-[#dbeafe] text-admin-blue',
  orange: 'bg-[#ffedd5] text-admin-warning',
  purple: 'bg-[#ede9fe] text-admin-purple',
  red: 'bg-[#fee2e2] text-admin-danger',
  slate: 'bg-[#f1f5f9] text-admin-text-2',
};

/* -------------------------------------------------------------------- typography */

export function PageHeading({ title, subtitle, action }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-[28px] leading-tight font-bold tracking-[-0.02em] text-admin-text">{title}</h1>
        {subtitle && <p className="m-0 mt-1 text-[14px] text-admin-text-2">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------- buttons */

const BUTTON = 'inline-flex items-center justify-center gap-2 rounded-[9px] text-[13px] font-semibold '
  + 'transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTS = {
  primary: 'bg-admin-text text-white hover:bg-[#1f2937]',
  secondary: 'border border-admin-border bg-admin-surface text-admin-text hover:bg-admin-bg',
  danger: 'bg-admin-danger text-white hover:bg-[#b91c1c]',
  ghost: 'text-admin-text-2 hover:bg-admin-bg hover:text-admin-text',
};

const SIZES = { sm: 'h-8 px-3', md: 'h-9 px-3.5', lg: 'h-10 px-4' };

export function Btn({ variant = 'secondary', size = 'md', className = '', busy = false, children, icon: IconComponent, ...rest }) {
  return (
    <button className={`${BUTTON} ${VARIANTS[variant]} ${SIZES[size]} ${className}`} {...rest}>
      {busy ? <Loader2 size={15} strokeWidth={2.2} className="animate-spin" />
        : IconComponent && <IconComponent size={15} strokeWidth={2} />}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------- badges */

const BADGE_TONES = {
  success: 'bg-[#dcfce7] text-[#15803d]',
  warning: 'bg-[#fef3c7] text-[#b45309]',
  danger: 'bg-[#fee2e2] text-[#b91c1c]',
  info: 'bg-[#dbeafe] text-[#1d4ed8]',
  neutral: 'bg-[#f1f5f9] text-admin-text-2',
};

export function Badge({ tone = 'neutral', dot = false, children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap ${BADGE_TONES[tone]}`}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/**
 * The one place a domain status becomes a colour.
 *
 * Every table in the admin showed these as bare lowercase text, so "failed"
 * and "done" carried identical weight. Mapped in one function so the same
 * status cannot be amber in one tab and red in another.
 */
const STATUS_TONES = {
  paid: 'success', done: 'success', sent: 'success', delivered: 'success', processed: 'success',
  published: 'success', active: 'success', configured: 'success', verified: 'success',
  pending: 'warning', sending: 'warning', creating: 'warning', assigning: 'warning',
  refunding: 'warning', review: 'warning', unconfigured: 'warning', draft: 'warning',
  running: 'info', processing: 'info', confirmed: 'info', shipped: 'info', awb_assigned: 'info',
  failed: 'danger', cancelled: 'danger', error: 'danger', refunded: 'danger', inactive: 'danger',
};

export function StatusBadge({ value, label }) {
  const key = String(value ?? '').toLowerCase();
  return <Badge tone={STATUS_TONES[key] ?? 'neutral'} dot>{label ?? String(value ?? '—').replace(/_/g, ' ')}</Badge>;
}

/* ---------------------------------------------------------------------- tables */

export function DataTable({ head, children, loading, isEmpty, empty, minWidth = 760 }) {
  if (loading) return <TableSkeleton columns={head.length} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[14px]" style={{ minWidth }}>
        <thead>
          <tr>
            {head.map((label, i) => (
              <th key={i} className="border-b border-admin-border px-4 py-3 text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-admin-muted uppercase">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-admin-border [&_td]:px-4 [&_td]:py-3.5 [&_td]:align-middle [&_td]:text-admin-text [&_td_small]:mt-0.5 [&_td_small]:block [&_td_small]:text-[12px] [&_td_small]:text-admin-text-2 [&_tr:last-child_td]:border-b-0">
          {children}
        </tbody>
      </table>
      {isEmpty && <div className="border-t border-admin-border">{empty}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- empty / loading */

export function EmptyState({ icon: IconComponent = Inbox, title, text, action, compact = false }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'px-5 py-10' : 'px-5 py-16'}`}>
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-admin-bg text-admin-muted">
        <IconComponent size={22} strokeWidth={1.8} />
      </span>
      <p className="m-0 text-[15px] font-semibold text-admin-text">{title}</p>
      {text && <p className="m-0 mt-1 max-w-[42ch] text-[13px] leading-relaxed text-admin-text-2">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Shaped like the content it replaces, so nothing jumps when data arrives. */
export function Skeleton({ className = '' }) {
  return <span className={`block animate-pulse rounded-md bg-[#eef0f4] ${className}`} />;
}

export function TableSkeleton({ columns = 5, rows = 5 }) {
  return (
    <div className="px-4 py-3">
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex items-center gap-4 border-b border-admin-border py-3.5 last:border-b-0">
          {Array.from({ length: columns }).map((__, column) => (
            <Skeleton key={column} className={`h-4 ${column === 0 ? 'w-[28%]' : 'flex-1'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 5 }) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`${CARD} p-[18px]`}>
          <Skeleton className="size-11 rounded-[10px]" />
          <Skeleton className="mt-3 h-3 w-24" />
          <Skeleton className="mt-2 h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------- inputs */

export const INPUT = 'h-10 w-full rounded-[9px] border border-admin-border bg-admin-surface px-3 text-[14px] '
  + 'text-admin-text placeholder:text-admin-muted focus:border-admin-text focus:ring-2 focus:ring-admin-text/5 focus-visible:outline-none';

export function AdminField({ label, hint, error, className = '', children, ...props }) {
  const id = useId();
  return (
    <div className={`mb-4 ${className}`}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-admin-text">{label}</label>
      {children ?? <input id={id} className={INPUT} {...props} />}
      {hint && !error && <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-admin-text-2">{hint}</p>}
      {error && <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-admin-danger">{error}</p>}
    </div>
  );
}

export const SELECT = `${INPUT} appearance-none pr-8 bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat`;

/**
 * A checkbox, with the third state a select-all needs.
 *
 * `indeterminate` is not an attribute, only a DOM property, so it has to be
 * assigned through a ref -- React will not set it from JSX. It is suppressed
 * when `checked` is true, because "all selected" and "some selected" are
 * mutually exclusive and a checked box also showing a dash reads as neither.
 */
export function Checkbox({ checked = false, indeterminate = false, onChange, label, className = '', ...rest }) {
  const box = useRef(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={box}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className={`size-4 shrink-0 cursor-pointer rounded-[4px] accent-admin-text ${className}`}
      {...rest}
    />
  );
}

/** Submits rather than firing a request per keystroke. */
export function SearchField({ value, onSubmit, placeholder = 'Search…', label, className = '' }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <form
      className={`relative flex items-center gap-2 ${className}`}
      onSubmit={(event) => { event.preventDefault(); onSubmit(draft.trim()); }}
      role="search"
    >
      <span className="pointer-events-none absolute left-3 text-admin-muted"><Search size={15} strokeWidth={2} /></span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className={`${INPUT} pl-9 ${value ? 'pr-9' : ''}`}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => { setDraft(''); onSubmit(''); }}
          className="absolute right-2.5 grid size-6 place-items-center rounded-md text-admin-muted hover:bg-admin-bg hover:text-admin-text"
        >
          <X size={14} strokeWidth={2.2} />
        </button>
      )}
    </form>
  );
}

/** Segmented control, for small exclusive choices like a status filter. */
export function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-[9px] border border-admin-border bg-admin-surface p-0.5">
      {options.map(([key, text, count]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
            value === key ? 'bg-admin-text text-white' : 'text-admin-text-2 hover:text-admin-text'
          }`}
        >
          {text}
          {count > 0 && (
            <span className={`rounded-full px-1.5 text-[11px] font-semibold ${value === key ? 'bg-white/20' : 'bg-admin-bg'}`}>{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------- dialogs */

/**
 * A modal dialog.
 *
 * Portalled to the body so no ancestor's overflow or transform can clip it,
 * focus moves to the panel on open, Escape and the backdrop close it, and Tab
 * is trapped inside. Body scroll is locked while it is open and restored to
 * whatever it was before, not assumed to have been ''.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-[640px]' }) {
  const panel = useRef(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 font-inter sm:p-6">
      <div aria-hidden="true" className="fixed inset-0 bg-[#0f172a]/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative my-auto w-full ${width} rounded-[14px] border border-admin-border bg-admin-surface shadow-[0_20px_60px_rgba(15,23,42,0.18)] focus-visible:outline-none`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-admin-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="m-0 text-[18px] font-semibold tracking-[-0.01em] text-admin-text">{title}</h2>
            {subtitle && <p className="m-0 mt-0.5 text-[13px] text-admin-text-2">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-[8px] text-admin-text-2 hover:bg-admin-bg hover:text-admin-text"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-admin-border px-5 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Destructive confirmation, inline rather than a dialog.
 *
 * Two clicks in place: the second carries the subject's name, so what is about
 * to be deleted is on screen at the moment of confirming. Arming lapses after
 * six seconds so a forgotten armed button cannot be hit later by accident.
 */
export function ConfirmDelete({ onConfirm, label = 'Delete', confirmLabel = 'Confirm', disabled, busy }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => setArmed(true)}
        className="text-[13px] font-semibold text-admin-danger hover:underline hover:underline-offset-4 disabled:opacity-45 disabled:no-underline"
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Btn variant="danger" size="sm" busy={busy} onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</Btn>
      <Btn variant="ghost" size="sm" onClick={() => setArmed(false)}>Cancel</Btn>
    </span>
  );
}

/**
 * A switch, for a setting that saves itself.
 *
 * `role="switch"` with `aria-checked` rather than a styled checkbox, because
 * this is not part of a form being submitted -- it writes immediately.
 *
 * It is deliberately NOT optimistic. The caller is expected to await the
 * request and then reload, so the knob only moves once the server has agreed;
 * if the write fails the switch is still showing the truth. A switch that
 * slides to green and silently reverts on the next refresh is worse than one
 * that pauses for 200ms.
 */
export function Toggle({ checked = false, onChange, busy = false, disabled = false, label }) {
  const locked = busy || disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={locked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-admin-text/20 focus-visible:outline-none ${
        checked ? 'bg-admin-success' : 'bg-[#d1d5db]'
      } ${busy ? 'cursor-wait opacity-60' : disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 grid size-[18px] place-items-center rounded-full bg-white shadow-[0_1px_2px_rgba(16,24,40,0.3)] transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        }`}
      >
        {busy && <Loader2 size={11} strokeWidth={2.8} className="animate-spin text-admin-text-2" />}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ row menu */

/**
 * The three-dot overflow menu on a table row.
 *
 * Portalled to the body and positioned from the trigger's bounding rect
 * rather than absolutely positioned inside the row. A table that scrolls
 * sideways sits in `overflow-x-auto`, and an absolutely positioned menu inside
 * that box is clipped by it -- the last row's menu would be cut off or would
 * add a scrollbar. Fixed coordinates escape the clip entirely.
 *
 * It flips above the trigger when there is not room below, and closes on
 * Escape, on an outside click, and on scroll -- the coordinates are a snapshot,
 * so a menu left open during a scroll would hang away from its row.
 */
export function RowMenu({ items, label = 'More actions' }) {
  const [at, setAt] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus(); } };
    const onDown = (event) => {
      if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at]);

  const WIDTH = 216;
  function open() {
    const box = trigger.current.getBoundingClientRect();
    const height = items.length * 38 + 12;
    const below = window.innerHeight - box.bottom > height + 12;
    setAt({
      top: below ? box.bottom + 6 : Math.max(8, box.top - height - 6),
      left: Math.max(8, Math.min(box.right - WIDTH, window.innerWidth - WIDTH - 8)),
    });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at ? 'true' : 'false'}
        onClick={() => (at ? setAt(null) : open())}
        className={`grid size-8 shrink-0 place-items-center rounded-[8px] text-admin-muted transition-colors hover:bg-admin-bg hover:text-admin-text ${at ? 'bg-admin-bg text-admin-text' : ''}`}
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </button>

      {at && createPortal(
        <div
          ref={menu}
          role="menu"
          style={{ top: at.top, left: at.left, width: WIDTH }}
          className="fixed z-[70] rounded-[11px] border border-admin-border bg-admin-surface py-1.5 font-inter shadow-[0_14px_40px_rgba(15,23,42,0.16)]"
        >
          {items.map((item) => item.separator ? (
            <span key={item.key} aria-hidden="true" className="my-1.5 block h-px bg-admin-border" />
          ) : item.href ? (
            <a
              key={item.key}
              role="menuitem"
              href={item.href}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noreferrer' : undefined}
              onClick={() => setAt(null)}
              className="flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-medium text-admin-text no-underline hover:bg-admin-bg"
            >
              {item.icon && <item.icon size={15} strokeWidth={2} className="shrink-0 text-admin-text-2" />}
              {item.label}
            </a>
          ) : (
            <button
              key={item.key}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => { setAt(null); item.onSelect(); }}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-medium hover:bg-admin-bg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent ${
                item.tone === 'danger' ? 'text-admin-danger' : 'text-admin-text'
              }`}
            >
              {item.icon && <item.icon size={15} strokeWidth={2} className={`shrink-0 ${item.tone === 'danger' ? '' : 'text-admin-text-2'}`} />}
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ------------------------------------------------------------------ paging */

/**
 * The footer under an admin table: what you are looking at on the left, how to
 * move and resize it on the right.
 *
 * Separate from the storefront's Pagination component, which the shop, the
 * wishlist and the order history share: this one needs a rows-per-page control
 * and the admin palette, and growing the shared control to carry both would
 * put admin concerns into four customer-facing pages. The page-number logic is
 * still the shared `pageList`, so there is only one implementation of that.
 */
const STEP = 'grid size-9 place-items-center rounded-[9px] border border-admin-border bg-admin-surface '
  + 'text-admin-text-2 transition-colors hover:bg-admin-bg hover:text-admin-text '
  + 'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-admin-surface';

export function TablePagination({
  page, pages, total, limit, onPage, onLimit,
  unit = 'results',
  options = [8, 16, 24, 48],
  className = '',
}) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const go = (next) => { if (next >= 1 && next <= pages && next !== page) onPage(next); };

  return (
    <div className={`flex flex-col items-start gap-4 border-t border-admin-border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <p className="m-0 text-[13px] text-admin-text-2">
        {total === 0
          ? `No ${unit}`
          : <>Showing <span className="font-semibold text-admin-text">{from}</span> to <span className="font-semibold text-admin-text">{to}</span> of <span className="font-semibold text-admin-text">{total}</span> {unit}</>}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {onLimit && (
          <label className="flex items-center gap-2 text-[13px] text-admin-text-2">
            Rows per page
            <select
              value={limit}
              onChange={(event) => onLimit(Number(event.target.value))}
              className="h-9 rounded-[9px] border border-admin-border bg-admin-surface px-2.5 text-[13px] font-medium text-admin-text focus:border-admin-text focus-visible:outline-none"
            >
              {options.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        )}

        {/* One page needs no stepper, but the count above is still worth saying. */}
        {pages > 1 && (
          <nav aria-label="Pagination" className="flex items-center gap-1.5">
            <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page" className={STEP}>
              <ChevronLeft size={16} strokeWidth={2.2} />
            </button>
            {pageList(page, pages, 1).map((entry, index) => entry === 'gap' ? (
              <span key={`gap-${index}`} aria-hidden="true" className="px-0.5 text-[13px] text-admin-muted">…</span>
            ) : (
              <button
                key={entry}
                type="button"
                onClick={() => go(entry)}
                aria-label={`Page ${entry}`}
                aria-current={entry === page ? 'page' : undefined}
                className={`grid size-9 place-items-center rounded-[9px] text-[13px] font-semibold transition-colors ${
                  entry === page
                    ? 'bg-admin-text text-white'
                    : 'border border-admin-border bg-admin-surface text-admin-text-2 hover:bg-admin-bg hover:text-admin-text'
                }`}
              >
                {entry}
              </button>
            ))}
            <button type="button" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page" className={STEP}>
              <ChevronRight size={16} strokeWidth={2.2} />
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

/**
 * A paginated admin list.
 *
 * Returns the rows plus the paging metadata, and resets to page one whenever a
 * filter changes -- page seven of a previous search is page seven of nothing.
 * The same applies to the page size: page two of eight-per-page is not page two
 * of forty-eight-per-page.
 *
 * `limit` is the starting page size; callers that want a rows-per-page control
 * use the returned `setLimit`, and callers that do not simply ignore it.
 */
export function usePagedResource(path, { limit: initialLimit = 20, params = {} } = {}) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(initialLimit);
  const search = new URLSearchParams({ page: String(page), limit: String(limit) });
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value != null) search.set(key, String(value));
  }
  const { data, error, loading, refreshing, reload } = useResource(`${path}?${search.toString()}`);

  const filterKey = JSON.stringify(params);
  useEffect(() => { setPage(1); }, [filterKey, limit]);

  return {
    rows: data?.rows ?? [],
    total: data?.total ?? 0,
    pages: data?.pages ?? 1,
    meta: data,
    page, setPage, limit, setLimit, error, loading, refreshing, reload,
  };
}
