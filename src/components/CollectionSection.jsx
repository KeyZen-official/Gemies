'use client';
import { Button } from './ui/Button.jsx';
import { SectionHeading } from './ui/SectionHeading.jsx';

/**
 * Shared wrapper for the homepage's titled sections. `align="split"` puts the
 * heading on the left and the action on the right (New Era); otherwise the
 * heading is centred and the action sits below the content.
 */
export function CollectionSection({ id, heading, text, cta, align = 'centred', children }) {
  const split = align === 'split';

  return (
    <section id={id} className="mt-[42px] md:mt-[52px] lg:mt-[70px]">
      <SectionHeading
        heading={heading}
        text={text}
        align={split ? 'split' : 'centred'}
        action={split && cta
          ? <Button variant="outline" href={cta.href} className="shrink-0 min-h-8 px-3 py-2 text-[9px] md:min-h-11 md:px-6 md:py-3 md:text-xs">{cta.label}</Button>
          : null}
      />

      {children}

      {!split && cta && (
        <div className="mt-[26px] text-center md:mt-9">
          <Button variant="outline" href={cta.href}>{cta.label}</Button>
        </div>
      )}
    </section>
  );
}
