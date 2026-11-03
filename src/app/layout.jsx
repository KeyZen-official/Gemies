// Tailwind first: utilities and @layer base. Components migrated to Tailwind
// carry their own classes; the two stylesheets below still serve the pages
// that have not been migrated yet (see docs/tailwind-migration.md).
// The only stylesheet: Tailwind's import, the @theme tokens and @layer base
// element defaults. All component and page styling is utility classes.
import '../styles/tailwind.css';
import { Manrope, Inter } from 'next/font/google';
import { Shell } from './shell.jsx';

/**
 * Manrope, for the homepage promotional cards.
 *
 * next/font ships with Next, so this adds no dependency. It self-hosts the
 * files out of .next at build time, so there is no request to Google at
 * runtime and no layout shift from a late-loading webfont.
 *
 * The variable is exposed on <html> and picked up by the `--font-manrope`
 * theme token in tailwind.css, which Tailwind turns into `font-manrope`. The
 * site-wide `--font-sans` is deliberately left on Arial: only the components
 * that opt in with `font-manrope` change, so this cannot restyle the rest of
 * the site as a side effect.
 *
 * Weights are the four the card design uses: 400 supporting text, 500 offer
 * line, 600 headings and buttons, 700 the card-three promotional type.
 */
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-manrope-src',
  display: 'swap',
});

/**
 * Inter, for the admin panel only.
 *
 * Self-hosted by next/font like Manrope above, rather than the @import the
 * brief suggested: an @import in the stylesheet is a render-blocking request
 * to Google on every page load, and it would apply to the storefront too.
 * Exposed as `--font-inter` in tailwind.css, which the admin opts into with
 * `font-inter`; nothing on the shop changes.
 */
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter-src',
  display: 'swap',
});

// Replaces the old static index.html <head>. Next.js renders this on the
// server, so every route ships real, crawlable metadata.
export const metadata = {
  // Lets relative canonical and Open Graph URLs resolve to absolute ones.
  metadataBase: new URL(process.env.APP_URL || 'http://localhost:3000'),
  title: {
    default: 'Gemies — Men’s everyday essentials',
    template: '%s · Gemies',
  },
  description:
    'Gemies — men’s T-shirts, shirts and bottom wear. Explore the latest collections.',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#111111',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${manrope.variable} ${inter.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
