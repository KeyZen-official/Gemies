import { Order } from '@/account.jsx';

export const metadata = {
  title: 'Your order',
  description: 'Payment status, invoice, and delivery updates for your order.',
  robots: { index: false, follow: false },
};

export default function OrderPage() {
  return <Order />;
}
