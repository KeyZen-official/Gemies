'use client';
import { useEffect, useState } from 'react';
import { ClothingRailHero } from './ui/product-rail-gallery.jsx';
import { Button } from './ui/Button.jsx';
import { api } from '../api.js';
import { railItems as fallbackItems } from '../data/rail-items.js';

/**
 * The homepage hero: every top the store makes, hanging on one rail.
 *
 * The garments come from GET /api/rail, built from the catalogue at request
 * time, so an operator changing a rail image or a hang tag in the admin panel
 * sees it on the next page load. Hang tags show each product's real price
 * unless an override was typed, so a tag cannot disagree with what checkout
 * charges.
 *
 * This used to import a generated file (src/data/rail-items.js) that a build
 * script wrote from the catalogue. That file is still imported, but only as a
 * fallback for the first paint and for the case where the API is unreachable
 * or no product has been put on the rail yet -- an empty hero is worse than a
 * slightly stale one, and the rail is the first thing on the page.
 *
 * Background is set as an inline style rather than a className. The component
 * puts `bg-background` on its own section, and a `bg-*` utility passed through
 * className would be competing at equal specificity, so which one won would
 * depend on Tailwind's output order. An inline style is unambiguous.
 *
 * Cream, not the component's default white, because most of these garments are
 * white or light grey. Rendered on white their edges dissolve into the page and
 * the only thing separating them is the garment's own 16% drop shadow. On
 * #f2eee6, which is the store's existing --color-card-tshirt, every piece holds
 * its outline.
 */
export function HomeRail() {
  const [items, setItems] = useState(fallbackItems);

  useEffect(() => {
    let live = true;
    api('/rail')
      // An empty rail means nothing has been put on it yet, so the seeded
      // fallback stays rather than the hero collapsing.
      .then((data) => { if (live && data.items?.length) setItems(data.items); })
      .catch(() => { /* the fallback is already rendered */ });
    return () => { live = false; };
  }, []);

  return (
    <ClothingRailHero
      items={items}
      hanger="wood"
      /* Resting garments stay real photographs, turned to the component's
         REST angle of -58deg so just over half of each one is visible.

         The alternative is sideFallback="illustration", which swaps in the
         component's drawn edge-on side view. That was tried and rejected: it
         is geometrically truthful and the colour comes out right, but a
         garment seen truly edge-on is so narrow that it reads as a column
         rather than a shirt. Real side-on photography would beat both -- add
         it as a third rail image and it wins automatically. */
      autoplay
      interval={2800}
      style={{ background: '#f2eee6' }}
      eyebrow={`Everyday essentials · ${items.length} ${items.length === 1 ? 'piece' : 'pieces'} on the rail`}
      heading="Every top we make, on one rail."
      caption="Brush along the rail, slide a hanger, or lift a piece to see it close up."
      action={<Button variant="dark" href="/shop">Shop the edit</Button>}
    />
  );
}
