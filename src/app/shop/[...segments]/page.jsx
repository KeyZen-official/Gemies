import { CategoryBrowser } from '@/components/shop/CategoryBrowser.jsx';
import { fetchFromApi } from '@/api-server.js';

// Category pages: /shop/t-shirts and /shop/t-shirts/oversized.
//
// Only the first two segments are used, matching the two-level taxonomy. A
// deeper path resolves to nothing and the browser shows its not-found state
// rather than silently listing the whole catalogue.
export async function generateMetadata({ params }) {
  const { segments = [] } = await params;
  const path = segments.slice(0, 2).join('/');
  const category = await fetchFromApi(`/categories/resolve?path=${encodeURIComponent(path)}`);
  if (!category) return { title: 'Shop' };

  const name = category.parent ? `${category.name}` : category.name;
  return {
    title: name,
    description: `Shop ${category.name.toLowerCase()} at Gemies.`,
    alternates: { canonical: `/shop/${segments.slice(0, 2).join('/')}` },
  };
}

export default async function CategoryPage({ params }) {
  const { segments = [] } = await params;
  return <CategoryBrowser path={segments.slice(0, 2)} />;
}
