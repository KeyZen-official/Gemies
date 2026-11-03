// Editorial content for the homepage sections, kept out of the presentation
// components so copy and links can change without touching markup.
//
// Photography comes from public/assets, which scripts/extract-assets.mjs
// produces with the reference design's own headings and buttons removed. Every
// heading, caption and call to action below is rendered as real markup by the
// components, never baked into an image.
//
// The images carry alt="" because each one sits beside a real heading or label
// that already names it; describing them again would just repeat it.

// The hero photograph, its intrinsic size and its crop.
//
// This one asset does not come from extract-assets.mjs: it is the supplied
// photograph, converted by scripts/build-hero-asset.mjs from the 1.86 MB PNG
// in public/assets to a 92 KB WebP at native size.
//
// `focal` is the object-position the <img> uses. The asset is very wide
// (2103x748, a 2.81 ratio), so at phone and tablet widths `object-cover` can
// only show a slice of it: 30% of the width at 390px, 51% at 768px. Centring
// that slice lands on the stone archway and leaves the model out of frame, so
// below lg the crop is biased to 78% across, chosen by rendering the candidate
// windows and looking at them.
//
// From lg the band is tall enough that the window opens to 67% at 1024 and 95%
// at 1440, and there centring is the better value: it holds the model at about
// two thirds across, clear of the left-aligned copy, where 78% would pull him
// back under it.
export const hero = {
  image: '/assets/hero-everyday-edit.webp',
  width: 2103,
  height: 748,
  focal: 'object-[78%_center] lg:object-center',
  eyebrow: 'THE EVERYDAY EDIT',
  heading: 'Build Your Everyday Wardrobe',
  text: 'Thoughtful essentials. Clean fits. Made to wear on repeat.',
  cta: { label: 'Shop Now', href: '/shop' },
};

// The two garment promo cards.
//
// Each shows one isolated garment on a tinted card, never a model or a
// lifestyle photograph: the garment is the subject.
//
// Images come from public/assets/products/promo/, the tight-cropped variants
// scripts/build-product-assets.mjs writes. The ordinary product asset pads
// every garment into a square frame so the catalogue grid shows them all at
// one scale; on a promo card that square frame is wrong, because a garment
// narrower than it is tall ends up height-bound and leaves most of the card's
// width empty. The promo variants keep each garment's own aspect ratio, so
// `widthPct` below is the share of the card width the garment really occupies.
//
// `tint` is the card background, paired with the garment deliberately: a white
// shirt needs a mid-tone behind it or it disappears.
export const promoCards = [
  {
    id: 'tshirts',
    tint: 'bg-card-tshirt',
    // The store mark, shown top-centre on this card only, matching the
    // reference. This is the real asset from brand-logos/gemies.png — the dark
    // tone, because this card is light. Nothing here invents a logo.
    logo: '/assets/brands/gemies.webp',
    image: '/assets/products/promo/plain-black-bella-canvas-3001-01.webp',
    alt: 'Black cotton T-shirt',
    // Spec: 72-78% of the card's width.
    widthPct: 'w-[76%]',
    text: 'Everyday Essentials.\nBuilt for Comfort.',
    cta: { label: 'Shop T-Shirts', href: '/shop/t-shirts' },
  },
  {
    id: 'shirts',
    tint: 'bg-card-shirt',
    image: '/assets/products/promo/casual-camp-collar-shirt-01.webp',
    alt: 'White camp collar shirt',
    // Spec: 70-76%. Set to the top of that range, matching the tee above, so
    // the two garments share one width and read as a pair. This garment is
    // wider than it is tall, so at an equal width it still occupies less
    // height -- that is the shape of a shirt, not a sizing mistake.
    widthPct: 'w-[76%]',
    text: 'Clean Fits. Better Fabrics.\nMade for Every Day.',
    cta: { label: 'Shop Shirts', href: '/shop/shirts' },
  },
];

/**
 * Third tile: the bottoms edit.
 *
 * No discount is claimed, and the "UP TO 40% OFF*" of the design reference is
 * deliberately not reproduced. The store has no coupon configured and no
 * product carries a compare_price, so a percentage-off headline would promise
 * a customer something they could not claim at checkout. Configure a coupon
 * and a compare_price first, then `headline` can carry the real number.
 */
export const offer = {
  label: 'THE CLOTHING EDIT',
  headline: 'NEW SEASON\nESSENTIALS',
  subhead: 'FRESH STYLES.\nEVERYDAY COMFORT.',
  image: '/assets/products/promo/joggers-mens-lounge-pant-01.webp',
  alt: 'Men’s lounge jogger',
  // Narrower than the garments above because trousers are a tall, narrow
  // shape: at this width the garment is bound by the height of the space
  // between the offer text and the button, which is what sets its real size.
  widthPct: 'w-[46%]',
  cta: { label: 'Shop Bottoms', href: '/shop/bottom-wear' },
};

// The product sections down the homepage.
//
// `query` is the real query string each section sends to GET /api/products,
// which is what decides the products shown. It has to be a server query, not a
// filter applied to one big fetch: a product's `category_slug` is its *leaf*
// category -- `t-shirts-regular-fit`, `shirts-casual`, `bottom-wear-joggers`
// -- so matching it against a top-level slug like `bottom-wear` finds nothing.
// The endpoint resolves a top-level slug to all of its descendants, so
// `category=bottom-wear` is the only thing that actually returns the bottoms.
//
// `empty` is what the section says when its query returns nothing, worded for
// that section rather than a generic line about a collection.
export const justDropped = {
  id: 'just-dropped',
  query: 'sort=newest',
  heading: 'Just Dropped',
  text: 'Cut from considered fabrics for long-lasting comfort and everyday wear.',
  cta: { label: 'See More', href: '/shop?sort=newest' },
  empty: { title: 'A new collection is on its way', text: 'Check back soon for our latest arrivals.' },
};

/**
 * The two category edits below "Shop By Category", in page order.
 *
 * Shirts is here because the homepage previously showed T-shirts and bottoms
 * only, so the middle of the three things the store sells had no section of
 * its own.
 */
export const homeCollections = [
  {
    id: 'shirts-edit',
    query: 'category=shirts',
    heading: 'Shirts',
    text: 'Camp collars and clean button-downs, cut to wear open or buttoned.',
    cta: { label: 'See More', href: '/shop/shirts' },
    empty: { title: 'Shirts are on their way', text: 'Check back soon for our latest arrivals.' },
  },
  {
    id: 'bottom-wear-edit',
    query: 'category=bottom-wear',
    heading: 'Bottom Wear',
    text: 'Joggers and shorts cut for comfort, finished to hold their shape.',
    cta: { label: 'See More', href: '/shop/bottom-wear' },
    empty: { title: 'Bottom wear is on its way', text: 'Check back soon for our latest arrivals.' },
  },
];

export const recommended = {
  heading: 'Shop By Category',
  text: 'T-shirts, shirts and bottom wear, built for everyday wear in cuts that last.',
};

// `area` maps each tile onto the CSS grid: one tall tile, two stacked, one wide.
// The three categories the store actually sells. `href` is the real category
// route, so a tile cannot point at a category that no longer exists.
// Tile images are composed from the product photography by
// scripts/build-product-assets.mjs.
export const categoryTiles = [
  { slug: 't-shirts', area: 'tall', label: 'T-Shirts', cta: 'Shop T-shirts', href: '/shop/t-shirts', image: '/assets/collection-t-shirts.webp' },
  { slug: 'shirts', area: 'top', label: 'Shirts', cta: 'Shop shirts', href: '/shop/shirts', image: '/assets/collection-shirts.webp' },
  { slug: 'bottom-wear', area: 'bottom', label: 'Bottom Wear', cta: 'Shop bottom wear', href: '/shop/bottom-wear', image: '/assets/collection-bottom-wear.webp' },
];


export const bottomBanner = {
  image: '/assets/footer-banner.webp',
  // Not "Build Your Everyday Wardrobe ...": that is now the hero headline at
  // the top of this same page, and the two banners would echo each other.
  heading: 'Well-Made Basics, Chosen Once And Worn For Years.',
  text: "Looking for well-made men's basics? You're in the right place. Considered cuts, honest fabrics and straightforward sizing.",
  cta: { label: 'Shop Now', href: '/shop' },
};

export const footerMenus = [
  {
    heading: 'Shop',
    links: [
      ['New Arrivals', '/shop?sort=newest'],
      ['T-Shirts', '/shop/t-shirts'],
      ['Shirts', '/shop/shirts'],
      ['Bottom Wear', '/shop/bottom-wear'],
      ['Collections', '/#collections'],
    ],
  },
  {
    heading: 'Legal',
    links: [
      ['Privacy Policy', '/info/privacy'],
      ['Terms and Conditions', '/info/terms'],
      ['Refund Policy', '/info/returns'],
      ['About Us', '/info/about'],
    ],
  },
  {
    heading: 'Help',
    links: [
      ['How To Order', '/info/how-to-order'],
      ['Track Order', '/account'],
      ['Shipping & Delivery', '/info/shipping'],
      ['FAQ', '/info/how-to-order'],
      ['Contact Us', '/info/contact'],
    ],
  },
];

// The navbar no longer reads from here. Its static items live in
// src/data/navigation.js and its category items come from the database through
// GET /api/categories/tree, so the menu cannot drift from the category pages.
