'use client';
import { CategoryCard } from './CategoryCard.jsx';
import { CollectionSection } from './CollectionSection.jsx';
import { categoryTiles, recommended } from '../data/home-content.js';

/**
 * The asymmetric category mosaic: a tall T-Shirts tile with Shirts and Bottom
 * Wear stacked beside it, one tile per category the store sells.
 *
 * Built with explicit column and row placement rather than
 * grid-template-areas, which has no Tailwind utility. Each tile carries its
 * own placement classes in CategoryCard. Single column on mobile so nothing
 * is clipped.
 */
export function RecommendedCollections() {
  return (
    <CollectionSection id="collections" heading={recommended.heading} text={recommended.text}>
      <div className="grid grid-cols-1 gap-2.5 md:gap-3 lg:grid-cols-2 lg:grid-rows-[1fr_1fr] lg:gap-[18px]">
        {categoryTiles.map((tile) => <CategoryCard key={tile.slug} tile={tile} />)}
      </div>
    </CollectionSection>
  );
}
