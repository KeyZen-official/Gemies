'use client';
import { useEffect, useRef } from 'react';
import { Icon } from '../../components.jsx';

/**
 * Size guide.
 *
 * Explains the sizing system in use and lists the sizes this product is
 * offered in. It deliberately carries no UK-to-EU-to-centimetre conversion
 * chart: those vary by brand and last, none is recorded in the catalogue, and
 * a wrong chart causes returns.
 */
export function SizeGuide({ sizes, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-180 grid place-items-center p-[5vmin]" role="dialog" aria-modal="true" aria-labelledby="size-guide-title">
      <button type="button" className="absolute inset-0 bg-[rgba(14,14,12,0.6)]" onClick={onClose} tabIndex={-1} aria-hidden="true" />
      <div className="relative max-h-[85vh] w-[min(560px,100%)] overflow-y-auto rounded-xl bg-white p-[22px] shadow-[0_24px_60px_rgba(0,0,0,0.22)] md:p-7 [&_p]:text-[13px] [&_p]:leading-relaxed">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="size-guide-title" className="m-0 text-xl">Size guide</h2>
          <button ref={closeRef} type="button" className="inline-flex size-9 items-center justify-center" onClick={onClose} aria-label="Close size guide">
            <Icon name="close" size={20} />
          </button>
        </div>

        <p>Sizes are listed in UK adult sizing, as printed on the product.</p>

        <table className="w-full border-collapse text-[13px] [&_td]:border-b [&_td]:border-rule [&_td]:py-[13px] [&_th]:w-[160px] [&_th]:border-b [&_th]:border-rule [&_th]:py-[13px] [&_th]:text-left [&_th]:font-medium [&_th]:text-ink-soft">
          <tbody>
            <tr><th scope="row">Offered in</th><td>{sizes.map((entry) => entry.size).join(', ')}</td></tr>
            <tr><th scope="row">In stock now</th><td>{sizes.filter((e) => e.available > 0).map((e) => e.size).join(', ') || 'None in this colourway'}</td></tr>
          </tbody>
        </table>

        <p className="mt-3.5 text-[11px] leading-relaxed">
          A UK to EU and centimetre conversion chart is not published for this catalogue. Fit varies
          between brands and lasts, so no conversion is shown rather than an approximate one. If you
          are between sizes, contact the store before ordering.
        </p>
      </div>
    </div>
  );
}
