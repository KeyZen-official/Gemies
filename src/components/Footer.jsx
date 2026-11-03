'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '../api.js';
import { useStore, Logo } from '../components.jsx';
import { footerMenus } from '../data/home-content.js';
import { Container } from './ui/Container.jsx';

// Social profiles come from store settings, so the footer only links to an
// account the store owner actually entered. Nothing shows until then.
const socialPlatforms = [
  ['X', 'social_x'],
  ['Facebook', 'social_facebook'],
  ['Instagram', 'social_instagram'],
  ['LinkedIn', 'social_linkedin'],
];

/**
 * Footer. The dark background spans the viewport; the inner blocks sit in the
 * shared Container so they line up with every other section.
 */
export function Footer() {
  const { config, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const social = socialPlatforms
    .map(([label, key]) => [label, config.settings?.[key]])
    .filter(([, href]) => typeof href === 'string' && href.startsWith('https://'));

  async function onSubscribe(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get('email');
    setError('');
    setBusy(true);
    try {
      const result = await api('/newsletter', { method: 'POST', body: { email, consent: true } });
      notify(result.message);
      form.reset();
    } catch (requestError) {
      setError(requestError.message);
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <footer className="bg-ink pt-9 pb-6 text-[#fafafa] md:pt-[50px]">
      <Container className="grid grid-cols-2 gap-6 md:grid-cols-[1.6fr_1fr_1fr] md:gap-[30px] lg:grid-cols-[2.1fr_1fr_1fr_1fr] lg:gap-9 xl:gap-[50px]">
        <div className="col-span-full max-w-full md:col-span-full lg:col-span-1 lg:max-w-[370px]">
          {/* The footer sits on bg-ink, so it takes the cream artwork. */}
          <Link href="/" aria-label="Gemies home"><Logo tone="light" className="text-[22px]" /></Link>
          <p className="mt-4 max-w-[330px] text-[11px] leading-relaxed text-[#a2a29d] md:text-[13px]">
            We make well-cut men’s essentials — T-shirts, shirts and bottom wear — from honest
            fabrics, built to be worn on repeat rather than replaced.
          </p>

          <strong id="newsletter-heading" className="mt-[22px] block text-xs">Subscribe to Newsletter</strong>
          <form
            onSubmit={onSubscribe}
            aria-labelledby="newsletter-heading"
            className="mt-3 flex max-w-[340px] gap-[3px] rounded-[25px] bg-[#2a2a28] p-[5px]"
          >
            <input
              name="email"
              type="email"
              placeholder="Enter your email address"
              aria-label="Newsletter email address"
              aria-invalid={error ? 'true' : undefined}
              maxLength={254}
              required
              className="min-h-7 min-w-0 flex-1 border-0 bg-transparent px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-[#8d8d88]"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-[20px] bg-white px-4 py-[7px] text-[10px] font-bold whitespace-nowrap text-ink"
            >
              {busy ? 'Joining…' : 'Subscribe'}
            </button>
          </form>
          {error && <small role="alert" className="mt-2 block text-[10px] text-[#e8a39c]">{error}</small>}
          <small className="mt-2 block text-[9px] leading-normal text-[#969692]">
            By subscribing, you agree to receive store news.{' '}
            <Link href="/info/privacy" className="hover:text-white hover:underline hover:underline-offset-[3px]">Privacy policy</Link>
          </small>
        </div>

        {footerMenus.map((menu) => (
          <nav key={menu.heading} aria-label={menu.heading} className="flex flex-col pt-1.5">
            <h4 className="mb-4 text-[11px] font-semibold md:text-xs">{menu.heading}</h4>
            {menu.links.map(([label, href]) => (
              <Link
                key={label + href}
                href={href}
                className="mb-3.5 text-[11px] text-[#a8a8a3] hover:text-white hover:underline hover:underline-offset-[3px] md:text-xs"
              >
                {label}
              </Link>
            ))}
          </nav>
        ))}
      </Container>

      <Container className="mt-[34px] flex flex-col items-start gap-4 border-t border-[#262624] pt-[22px] text-[9px] text-[#93938e] md:mt-[52px] md:flex-row md:items-center md:justify-between md:gap-5 md:text-[11px]">
        <span>© {new Date().getFullYear()} Copyright by Gemies. All rights reserved.</span>
        {social.length > 0 && (
          <ul className="m-0 flex list-none gap-2.5 p-0">
            {social.map(([label, href]) => (
              <li key={label}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center rounded-[20px] bg-[#222220] px-3 py-[7px] text-[9px] text-[#d8d8d4] hover:bg-[#2e2e2b] hover:text-white md:px-[15px] md:py-2 md:text-[11px]"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Container>

      {config.development && (
        <Container className="mt-5 border-t border-[#292927] pt-[18px] text-[9px] text-[#99958d]">
          Development preview · reference catalogue · payments require test configuration
        </Container>
      )}
    </footer>
  );
}
