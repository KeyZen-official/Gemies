import { Checkout } from '@/storefront.jsx';

export const metadata = {
  title: 'Checkout',
  description: 'Confirm your delivery address and pay securely.',
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return <Checkout />;
}
