'use client';
import Link from 'next/link';
import { useStore } from '../../components.jsx';

/**
 * Shipping, returns and product questions.
 *
 * Every policy sentence comes from the store's own configured settings. Where
 * a policy has not been written yet the section says so rather than promising
 * a return window the store has not agreed to.
 */
export function ProductPolicies() {
  const { config } = useStore();
  const settings = config.settings ?? {};
  const support = settings.support_email;

  const questions = [
    {
      q: 'How long does delivery take?',
      a: config.shipping
        ? 'Enter your PIN code above to see the couriers that serve your address and the estimate each one gives.'
        : 'Delivery estimates become available once the store connects its shipping account.',
    },
    {
      q: 'Can I return or exchange this?',
      a: settings.returns_policy
        || 'The store has not published a returns policy yet. Please confirm with the store before ordering.',
    },
    {
      q: 'What payment methods are accepted?',
      a: config.payments
        ? 'Checkout is handled by Razorpay, which offers the methods enabled on the store’s payment account.'
        : 'Payments are not configured yet, so checkout is unavailable. Your bag is saved in the meantime.',
    },
    {
      q: 'How do I track my order?',
      a: 'Your account shows payment status, the invoice, and courier tracking once the order is fulfilled.',
    },
    {
      q: 'Who do I contact about this product?',
      a: support
        ? `Email ${support} with the product name and your order number if you have one.`
        : 'The store has not published a support address yet.',
    },
  ];

  return (
    <div className="grid gap-[22px] md:grid-cols-[repeat(auto-fit,minmax(240px,1fr))] md:gap-8 lg:gap-12">
      <div>
        <h3 className="mb-2.5 text-sm">Shipping</h3>
        <p>
          Delivery is supported within India. Availability depends on the destination PIN code and
          courier serviceability. Shipping charges are calculated at checkout from the store’s
          configured rates.
        </p>
        <Link className="mt-6 inline-block border-b border-[#aaa] pb-[5px] text-xs" href="/info/shipping">Full delivery information</Link>
      </div>

      <div>
        <h3 className="mb-2.5 text-sm">Returns</h3>
        <p>
          {settings.returns_policy
            || 'No returns policy has been published for this store yet. Contact the store before ordering.'}
        </p>
        <Link className="mt-6 inline-block border-b border-[#aaa] pb-[5px] text-xs" href="/info/returns">Refund policy</Link>
      </div>

      <div className="[&_details]:border-b [&_details]:border-rule [&_details]:py-3.5 [&_details_p]:mt-2.5 [&_summary]:text-[13px]">
        <h3 className="mb-2.5 text-sm">Questions</h3>
        {questions.map(({ q, a }) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
