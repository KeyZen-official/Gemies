'use client';
import Link from 'next/link';

/**
 * Pill button, replacing the `.button` / `.button.dark` / `.button.outline`
 * CSS classes. Renders an <a> when given `href`, otherwise a <button>, so the
 * same styling serves links and actions without duplicating class strings.
 */
const base =
  'inline-flex items-center justify-center gap-3 rounded-full text-center ' +
  'text-xs font-semibold leading-snug min-h-11 px-6 py-3 ' +
  'transition-[background-color,transform] duration-200 ' +
  'hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-45 ' +
  'disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0';

const variants = {
  light: 'bg-white text-ink hover:bg-[#eeeeeb]',
  dark: 'bg-ink text-white border border-ink hover:bg-[#333]',
  outline: 'border border-[#8c8c86] bg-transparent text-ink hover:bg-[#ecece7]',
};

/**
 * The same classes as a string, for the few places that cannot use the
 * component: external links such as `mailto:` (Button routes href through
 * next/link) and `<a download>` targets.
 */
export function buttonClasses(variant = 'light', extra = '') {
  return `${base} ${variants[variant] ?? variants.light} ${extra}`;
}

export function Button({ variant = 'light', href, className = '', full = false, children, ...rest }) {
  const classes = `${base} ${variants[variant] ?? variants.light} ${full ? 'w-full' : ''} ${className}`;
  if (href) return <Link href={href} className={classes} {...rest}>{children}</Link>;
  return <button className={classes} {...rest}>{children}</button>;
}

/** Square tap target for the navbar and card icons, replacing `.icon-button`. */
export function IconButton({ as: Tag = 'button', href, className = '', children, ...rest }) {
  const classes = `inline-flex h-9 min-w-7 items-center justify-center p-1 transition-opacity hover:opacity-65 ${className}`;
  if (href) return <Link href={href} className={classes} {...rest}>{children}</Link>;
  return <Tag className={classes} {...rest}>{children}</Tag>;
}
