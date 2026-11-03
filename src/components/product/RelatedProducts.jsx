'use client';
import { useResource, Loading } from '../../components.jsx';
import { ProductGrid } from '../ProductGrid.jsx';

/**
 * Related products from the same category, reusing the shared ProductCard via
 * ProductGrid so these tiles behave exactly like every other grid on the site.
 * Renders nothing rather than an empty shelf when the category has no siblings.
 */
export function RelatedProducts({ product, limit = 4 }) {
  const { data, loading, error } = useResource(
    `/products?category=${encodeURIComponent(product.category_slug ?? '')}&limit=12`,
  );

  if (loading) return <Loading />;
  if (error) return null;

  const related = (data?.products ?? []).filter((candidate) => candidate.id !== product.id).slice(0, limit);
  if (!related.length) return null;

  return (
    <section className="mt-[42px] md:mt-[52px] lg:mt-[70px]">
      <div className="mb-6 text-center md:mb-8">
        <h2 className="mb-3 text-[23px] font-semibold tracking-[-0.03em] md:text-[27px] lg:text-[31px]">You might also like</h2>
        <p className="mx-auto max-w-[62ch] text-[11px] leading-normal text-ink-soft md:text-xs lg:text-sm">More from {product.category ?? 'this collection'}.</p>
      </div>
      <ProductGrid products={related} />
    </section>
  );
}
