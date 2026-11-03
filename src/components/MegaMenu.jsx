'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from '../components.jsx';
import { navItemsBefore, navItemsAfter } from '../data/navigation.js';

/**
 * Main navigation: static links plus one dropdown per top-level category.
 *
 * Driven entirely by the category tree from the API, so there is one menu
 * component rather than one per category, and a new subcategory appears here
 * as soon as it exists in the database.
 *
 * Desktop opens on hover and on click, because hover alone is unusable by
 * keyboard and unreliable on hybrid touch laptops. Closing is delayed slightly
 * so moving the pointer diagonally from the trigger into the panel does not
 * dismiss it. Mobile is a plain expandable list inside the existing drawer.
 */
export function MegaMenu({ tree = [], overlay = false, mobileOpen = false, onNavigate }) {
  const [openSlug, setOpenSlug] = useState('');
  const closeTimer = useRef(null);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const open = (slug) => {
    clearTimeout(closeTimer.current);
    setOpenSlug(slug);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenSlug(''), 120);
  };

  // Escape closes whatever is open, from anywhere in the bar.
  useEffect(() => {
    if (!openSlug) return;
    const onKey = (event) => { if (event.key === 'Escape') setOpenSlug(''); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSlug]);

  const linkClasses =
    'whitespace-nowrap border-b border-rule py-3 text-sm transition-opacity hover:opacity-65 ' +
    'lg:border-0 lg:py-0 lg:text-xs xl:text-sm';

  return (
    <>
      {navItemsBefore.map((item) => (
        <Link key={item.label} href={item.href} className={linkClasses} onClick={onNavigate}>
          {item.label}
        </Link>
      ))}

      {tree.map((category) => (
        <CategoryItem
          key={category.slug}
          category={category}
          overlay={overlay}
          mobile={mobileOpen}
          isOpen={openSlug === category.slug}
          onOpen={() => open(category.slug)}
          onClose={scheduleClose}
          onToggle={() => setOpenSlug(openSlug === category.slug ? '' : category.slug)}
          onNavigate={onNavigate}
        />
      ))}

      {navItemsAfter.map((item) => (
        <Link key={item.label} href={item.href} className={linkClasses} onClick={onNavigate}>
          {item.label}
        </Link>
      ))}
    </>
  );
}

function CategoryItem({ category, overlay, mobile, isOpen, onOpen, onClose, onToggle, onNavigate }) {
  const panelId = useId();
  const hasChildren = category.children?.length > 0;

  // A category with no subcategories is just a link.
  if (!hasChildren) {
    return (
      <Link
        href={category.href}
        className="whitespace-nowrap border-b border-rule py-3 text-sm transition-opacity hover:opacity-65 lg:border-0 lg:py-0 lg:text-xs xl:text-sm"
        onClick={onNavigate}
      >
        {category.name}
      </Link>
    );
  }

  return (
    <div
      className="border-b border-rule lg:relative lg:border-0"
      onMouseEnter={() => !mobile && onOpen()}
      onMouseLeave={() => !mobile && onClose()}
    >
      {/* Two controls on purpose: the name navigates to the category page, the
          chevron expands. Making the whole row a button would strip the ability
          to open "all T-Shirts", and making it only a link would leave the
          subcategories unreachable without a pointer. */}
      <div className="flex items-center justify-between gap-2 lg:gap-1.5">
        <Link
          href={category.href}
          className="flex-1 py-3 text-sm whitespace-nowrap transition-opacity hover:opacity-65 lg:flex-none lg:py-0 lg:text-xs xl:text-sm"
          onClick={onNavigate}
        >
          {category.name}
        </Link>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          aria-label={`${isOpen ? 'Hide' : 'Show'} ${category.name} subcategories`}
          onClick={onToggle}
          className="grid size-9 shrink-0 place-items-center transition-transform lg:size-4"
        >
          <Icon
            name="arrow"
            size={14}
            className={`rotate-90 transition-transform ${isOpen ? '-rotate-90' : ''}`}
          />
        </button>
      </div>

      {/* Desktop panel: absolutely positioned so opening it shifts nothing. */}
      <div
        id={panelId}
        hidden={!isOpen}
        className={
          'lg:absolute lg:top-full lg:left-0 lg:z-40 lg:min-w-[260px] lg:rounded-b-lg lg:border lg:border-rule lg:bg-white lg:pt-5 lg:pb-6 lg:text-ink lg:shadow-[0_18px_40px_rgba(0,0,0,0.12)] ' +
          (overlay ? '' : '')
        }
      >
        <ul className="m-0 list-none p-0 pb-3 pl-3 lg:columns-1 lg:gap-0 lg:pb-0 lg:pl-0">
          {category.children.map((child) => (
            <li key={child.slug}>
              <Link
                href={child.href}
                onClick={onNavigate}
                className="block py-2 text-[13px] text-ink-soft transition-colors hover:text-ink lg:px-6 lg:py-[7px] lg:text-[13px]"
              >
                {child.name}
              </Link>
            </li>
          ))}
          <li className="lg:mt-2 lg:border-t lg:border-rule lg:pt-3">
            <Link
              href={category.href}
              onClick={onNavigate}
              className="block py-2 text-[13px] font-medium underline underline-offset-4 lg:px-6 lg:py-[7px]"
            >
              All {category.name}
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
