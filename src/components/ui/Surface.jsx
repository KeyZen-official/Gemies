'use client';

/**
 * Small layout and status primitives shared across the shop, account and
 * admin screens. They exist so the same Tailwind class strings are not
 * repeated in a dozen files.
 *
 * Each one replaces a class from the old stylesheet, named in its comment.
 */

/** Replaces `.panel`. */
export function Panel({ as: Tag = 'div', narrow = false, className = '', children, ...rest }) {
  return (
    <Tag
      className={`mb-5 rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 ${narrow ? 'max-w-[560px]' : ''} ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Replaces `.badge`, `.badge.paid`, `.badge.refunded`. */
const badgeTones = {
  pending: 'bg-[#eee8db] text-[#846734]',
  paid: 'bg-[#e8eee5] text-[#46663b]',
  refunded: 'bg-[#e7e7e7] text-[#555]',
};

export function Badge({ tone = 'pending', className = '', children }) {
  return (
    <span
      className={`inline-flex items-center justify-center justify-self-start rounded-[20px] px-3 py-[7px] text-[10px] tracking-[0.3px] capitalize ${badgeTones[tone] ?? badgeTones.pending} ${className}`}
    >
      {children}
    </span>
  );
}

/** Replaces `.notice`. */
export function Notice({ className = '', children }) {
  return (
    <p className={`rounded-[5px] border border-[#e6ddcb] bg-[#f5efe4] px-[18px] py-3.5 text-xs leading-relaxed text-[#765e35] ${className}`}>
      {children}
    </p>
  );
}

/** Replaces `.error-text`. */
export function ErrorText({ className = '', children, ...rest }) {
  return <p className={`text-xs text-[#a83329] ${className}`} {...rest}>{children}</p>;
}

/** Replaces `.text-button`: an underlined inline action. */
export function TextButton({ className = '', children, ...rest }) {
  return (
    <button type="button" className={`py-2.5 text-[11px] underline underline-offset-4 ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Replaces `.table-wrap`, giving wide tables their own scroll area. */
export function TableWrap({ className = '', children }) {
  return <div className={`overflow-x-auto ${className}`}>{children}</div>;
}

/** Shared table cell classes, so every admin table matches. */
export const tableClasses = {
  table: 'w-full min-w-[650px] border-collapse text-left text-xs',
  th: 'border-b border-[#ccc] px-3 py-4 text-[10px] font-medium tracking-widest uppercase text-[#888]',
  td: 'max-w-[280px] border-b border-rule px-3 py-[17px] [overflow-wrap:anywhere]',
};

/** Replaces `.account-tabs`. */
export function Tabs({ className = '', children }) {
  return (
    <div className={`mb-[26px] flex gap-6 overflow-x-auto border-b border-rule md:mb-9 md:gap-7 ${className}`}>
      {children}
    </div>
  );
}

export function Tab({ active = false, className = '', children, ...rest }) {
  return (
    <button
      type="button"
      className={`border-b-2 py-[15px] text-[11px] whitespace-nowrap capitalize md:text-xs ${active ? 'border-ink font-semibold' : 'border-transparent'} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Replaces `.section-heading`. */
export function SectionBar({ className = '', children }) {
  return (
    <div className={`my-[22px] flex flex-wrap items-start justify-between gap-5 md:flex-nowrap md:items-center ${className}`}>
      {children}
    </div>
  );
}
