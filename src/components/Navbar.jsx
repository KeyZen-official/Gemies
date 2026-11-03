'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useStore, useResource, Icon, Logo } from '../components.jsx';
import { Button, IconButton } from './ui/Button.jsx';
import { MegaMenu } from './MegaMenu.jsx';

/**
 * Site navigation, styled with Tailwind utilities.
 *
 * `overlay` is the homepage treatment: a translucent dark bar over the hero
 * photograph, with its own height cancelled in flow (-mb-nav) so the hero
 * starts at the top of the page while the bar still pins to the viewport.
 *
 * Height comes from the `nav` spacing token, which the hero's offset also
 * reads, so the two cannot drift apart across breakpoints.
 */
export function Navbar({ overlay = false }) {
  const { user, cart } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  // The category part of the menu comes from the database, so the navigation
  // and the category pages are built from one source.
  // Cached, so the mega menu is populated on the first paint after a refresh
  // instead of appearing a round trip later. Public, slow-changing data; the
  // live request still runs and replaces it.
  const { data: tree } = useResource('/categories/tree', { cacheKey: 'category-tree' });

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  const bagCount = cart.items.reduce((total, item) => total + item.quantity, 0);

  function onSearch(event) {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get('q');
    setSearchOpen(false);
    router.push(`/shop?q=${encodeURIComponent(query)}`);
  }

  return (
    <div className={`sticky top-0 z-50 ${overlay ? '-mb-nav' : ''}`}>
      <header
        className={
          'relative grid h-nav grid-cols-[1fr_auto_1fr] items-center gap-5 px-3 md:gap-6 md:px-4 lg:px-8 ' +
          (overlay
            ? 'border-b-0 bg-gradient-to-b from-[#181d14f0] to-[#20261bdb] text-white'
            : 'border-b border-rule bg-white')
        }
      >
        {/* The overlay treatment puts the bar over the dark hero, where the
            cream artwork is the one that reads. */}
        <Link href="/" className="justify-self-start" aria-label="Gemies home">
          <Logo tone={overlay ? 'light' : 'dark'} />
        </Link>

        {/* Centred on the bar itself by the 1fr/auto/1fr grid, so it does not
            drift with the width of the logo or the icon group. */}
        <nav
          aria-label="Main navigation"
          className={
            'justify-self-center lg:flex lg:items-center lg:justify-center lg:gap-[18px] xl:gap-[30px] ' +
            (menuOpen
              ? 'absolute inset-x-0 top-full flex flex-col items-stretch bg-white px-3 pb-5 pt-3.5 text-ink shadow-[0_14px_22px_rgba(0,0,0,0.09)] md:px-4 lg:static lg:flex-row lg:bg-transparent lg:p-0 lg:text-inherit lg:shadow-none'
              : 'hidden')
          }
        >
          <MegaMenu
            tree={tree ?? []}
            overlay={overlay}
            mobileOpen={menuOpen}
            onNavigate={() => setMenuOpen(false)}
          />
          {user?.role === 'admin' && (
            <Link href="/admin" className="whitespace-nowrap py-3 text-sm transition-opacity hover:opacity-65 lg:py-0 lg:text-xs xl:text-sm">
              Admin
            </Link>
          )}
        </nav>

        <div className="flex items-center justify-self-end gap-3.5 md:gap-4">
          <IconButton onClick={() => setSearchOpen(!searchOpen)} aria-label="Search products" aria-expanded={searchOpen}>
            <Icon name="search" className="size-5 md:size-[22px]" />
          </IconButton>

          <IconButton href={user ? '/account' : '/login'} aria-label={user ? 'Your account' : 'Sign in'}>
            <Icon name="user" className="size-5 md:size-[22px]" />
          </IconButton>

          <IconButton href="/wishlist" aria-label="Saved products" className="hidden md:inline-flex">
            <Icon name="heart" className="size-5 md:size-[22px]" />
          </IconButton>

          <IconButton href="/cart" className="relative" aria-label={`Shopping bag, ${bagCount} item${bagCount === 1 ? '' : 's'}`}>
            <Icon name="bag" className="size-5 md:size-[22px]" />
            <span
              aria-hidden="true"
              className={
                'absolute -top-1.5 -right-1 grid h-[15px] min-w-[15px] place-items-center rounded-full px-[3px] text-[9px] font-semibold ' +
                (overlay ? 'bg-white text-ink' : 'bg-ink text-white')
              }
            >
              {bagCount}
            </span>
          </IconButton>

          <IconButton onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation" aria-expanded={menuOpen} className="lg:hidden">
            <Icon name={menuOpen ? 'close' : 'menu'} className="size-5 md:size-[22px]" />
          </IconButton>
        </div>
      </header>

      {searchOpen && (
        <form
          onSubmit={onSearch}
          role="search"
          className={
            'z-[19] flex items-center gap-2.5 border-b border-rule bg-white px-3 py-4 md:gap-4 md:px-4 lg:px-8 lg:py-5 ' +
            (overlay ? 'absolute inset-x-0 top-full' : 'relative')
          }
        >
          <Icon name="search" />
          <input
            autoFocus
            name="q"
            placeholder="Search T-shirts, shirts, bottom wear…"
            aria-label="Search products"
            required
            className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-xs outline-none placeholder:text-[#92928e] md:text-sm"
          />
          <Button variant="dark" type="submit">Search</Button>
        </form>
      )}
    </div>
  );
}
