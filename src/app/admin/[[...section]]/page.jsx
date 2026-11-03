import { Admin } from '@/admin.jsx';

// Optional catch-all so /admin and /admin/<section> both resolve to the same
// shell. The Admin component reads the section back off the pathname and pushes
// a new one when a tab is clicked, which is what gives the panel deep links, a
// working back button, and a refresh that stays where you were.
export const metadata = {
  title: 'Store dashboard',
  description: 'Gemies store administration.',
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <Admin />;
}
