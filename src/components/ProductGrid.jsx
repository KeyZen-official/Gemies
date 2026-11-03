'use client';
import { ProductCard } from './ProductCard.jsx';

/**
 * Responsive product grid: two columns on mobile, three on tablet, four from
 * laptop up, which keeps each card near the reference tile size inside the
 * 1320px container instead of stretching on wide screens.
 */
export function ProductGrid({ products, priorityCount = 0 }) {
  return (
    <div className="grid grid-cols-2 gap-x-[9px] gap-y-5 min-[380px]:gap-x-3 min-[380px]:gap-y-6 md:grid-cols-3 md:gap-x-3.5 md:gap-y-7 lg:grid-cols-4 lg:gap-x-5 lg:gap-y-8">
      {products.map((product, index) => (
        <ProductCard key={product.id} product={product} priority={index < priorityCount} />
      ))}
    </div>
  );
}
