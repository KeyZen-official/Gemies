import { Cart } from '@/storefront.jsx';

export const metadata = {
  title: 'Your shopping bag',
  description: 'Review the items in your Gemies bag before checkout.',
  robots: { index: false, follow: false },
};

export default function CartPage() {
  return <Cart />;
}
