import { Account } from '@/account.jsx';

export const metadata = {
  title: 'Your account',
  description: 'Your orders, saved addresses, and account settings.',
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return <Account />;
}
