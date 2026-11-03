'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Provider } from '../components.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { Footer } from '../components/Footer.jsx';

// The persistent chrome around every route.
//
// The navbar lives here rather than inside HeroBanner so there is exactly one
// of them and its containing block is the whole page. Nested in the hero it
// could only stick while the hero was on screen. On the home page it gets the
// translucent treatment and is pulled over the hero photograph by CSS.
export function Shell({ children }) {
  const pathname = usePathname();
  // The admin area brings its own chrome. An operations screen has no use for
  // a cart icon, a wishlist, the shop mega menu, or a marketing footer with a
  // newsletter signup and social links under it, and the admin's own top bar
  // carries the two things it does need: a link back to the store and sign out.
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');

  // Product grids are fetched after first paint, so an in-page anchor such as
  // /#collections needs a moment before its target element exists.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    const timer = setTimeout(
      () => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' }),
      100,
    );
    return () => clearTimeout(timer);
  }, [pathname]);

  // The store context stays in both cases: the admin reads `user`, `config`
  // and `notify` from it, and the toast renders out of the Provider.
  if (isAdmin) {
    return (
      <Provider>
        <a className="fixed top-[-100px] left-5 z-[1000] bg-white p-4 text-black focus:top-2.5" href="#main-content">
          Skip to content
        </a>
        <div id="main-content">{children}</div>
      </Provider>
    );
  }

  return (
    <Provider>
      {/* Page wrapper. Full bleed and white; no overflow value, because any
          would make this the sticky navbar's scrollport and unpin it. */}
      <div className="min-h-screen w-full bg-white">
        <a
          className="fixed top-[-100px] left-5 z-[1000] bg-white p-4 text-black focus:top-2.5"
          href="#main-content"
        >
          Skip to content
        </a>
        {/* The standard bordered bar on every route, including home.
            
            The navbar component is unchanged and still supports its `overlay`
            treatment -- a translucent dark bar with its own height cancelled in
            flow by -mb-nav, so a full-bleed photograph runs underneath it. That
            was right for the photographic hero. It is wrong for the clothing
            rail, which is a light section carrying its own eyebrow and heading:
            -mb-nav would pull those 92px upwards and hide them behind the bar,
            and the bar's dark green gradient was mixed for a dark photograph,
            not for cream. Pass `overlay` again here to put it back. */}
        <Navbar />
        <div id="main-content">{children}</div>
        <Footer />
      </div>
    </Provider>
  );
}
