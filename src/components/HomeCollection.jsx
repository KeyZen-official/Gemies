'use client';
import { useResource, Loading, ErrorState, Empty } from '../components.jsx';
import { CollectionSection } from './CollectionSection.jsx';
import { ProductGrid } from './ProductGrid.jsx';

/**
 * One titled product section on the homepage: heading, supporting line, a grid
 * of products and a link through to the full listing.
 *
 * Each section fetches its own products from GET /api/products using the
 * `query` on its entry in src/data/home-content.js, so the heading and the
 * products under it come from the same place and cannot disagree.
 *
 * This replaces the previous arrangement, where the homepage made one
 * `/products?limit=48` request and split the result in the component with
 * `filter(p => p.category_slug === 'sneakers')`. That was left over from a
 * sneaker catalogue and had gone silently wrong: no product has that slug, so
 * "Just Dropped" always fell through to its empty state, and the other section
 * took `category_slug !== 'sneakers'`, which is *every* product -- which is
 * why six T-shirts were sitting under a "Bottom Wear" heading.
 *
 * `limit` defaults to 8 rather than 6 so a four-column grid fills two whole
 * rows instead of leaving a row of two.
 */
export function HomeCollection({ section, align = 'centred', limit = 8, priorityCount = 0 }) {
  const { data, error, loading, reload } = useResource(`/products?${section.query}&limit=${limit}`);
  const products = data?.products ?? [];

  return (
    <CollectionSection
      id={section.id}
      align={align}
      heading={section.heading}
      text={section.text}
      cta={section.cta}
    >
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : products.length ? (
        <ProductGrid products={products} priorityCount={priorityCount} />
      ) : (
        <Empty title={section.empty.title} text={section.empty.text} />
      )}
    </CollectionSection>
  );
}
