import { Wishlist } from '@/storefront.jsx';

export const metadata = {
  title: 'Saved favourites',
  description: 'The Gemies pieces you have saved for later.',
  robots: { index: false, follow: false },
};

export default function WishlistPage() {
  return <Wishlist />;
}
