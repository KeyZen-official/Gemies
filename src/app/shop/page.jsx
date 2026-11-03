import { Suspense } from 'react';
import { Shop } from '@/storefront.jsx';
import { Loading } from '@/components.jsx';

export const metadata = {
  title: 'Shop',
  description:
    'Browse the full Gemies collection. Filter by audience, brand, and category, then sort to find your everyday pair.',
};

// Shop reads the query string for filters, search, sort, and pagination, so it
// needs a Suspense boundary to let the static shell render first.
export default function ShopPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Shop />
    </Suspense>
  );
}
