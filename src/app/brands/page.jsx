import { Brands } from '@/storefront.jsx';

export const metadata = {
  title: 'Explore our brands',
  description: 'Discover the labels in the Gemies collection: Nike, Adidas, Puma, and New Balance.',
  alternates: { canonical: '/brands' },
};

export default function BrandsPage() {
  return <Brands />;
}
