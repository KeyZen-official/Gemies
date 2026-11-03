'use client';
import Link from 'next/link';
import { useStore, Icon } from '../../components.jsx';

/**
 * Returns and exchange, in the buy box.
 *
 * The reference screenshot reads "14-day return and size exchange", but that
 * window is the retailer's own policy, not ours: `store_settings.returns_policy`
 * is the only source for it and is empty until the store writes one. So the
 * wording comes from settings when set, and otherwise says plainly that no
 * policy is published rather than promising a window nobody has agreed to.
 */
export function ProductReturns() {
  const { config } = useStore();
  const policy = config.settings?.returns_policy?.trim();

  return (
    <section className="mt-6 border-t border-rule pt-5">
      <div className="flex items-start justify-between gap-4">
        <p className="m-0 flex items-start gap-2.5 text-[15px] text-body">
          <Icon name="truck" size={18} className="mt-0.5 shrink-0" />
          <span>
            {policy || 'No returns or exchange policy has been published for this store yet.'}
          </span>
        </p>
        <Link
          href="/info/returns"
          className="shrink-0 text-[15px] underline underline-offset-4 hover:text-ink"
        >
          Know more
        </Link>
      </div>
    </section>
  );
}
