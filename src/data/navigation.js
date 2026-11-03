// Navigation items that are not categories.
//
// The category items — T-Shirts, Shirts, Bottom Wear and their subcategories —
// are not listed here. They come from the database through
// GET /api/categories/tree, so the menu and the category pages cannot drift
// apart and adding a subcategory needs no code change.
//
// `position` places each static item relative to the category block.
export const staticNavItems = [
  {label: 'Home', href: '/', position: 'before'},
  // New Arrivals is a sort of the whole catalogue, not a category, so it has no
  // row in `categories` and no subcategories.
  {label: 'New Arrivals', href: '/shop?sort=newest', position: 'before'},
  {label: 'Collections', href: '/#collections', position: 'after'},
];

export const navItemsBefore = staticNavItems.filter((item) => item.position === 'before');
export const navItemsAfter = staticNavItems.filter((item) => item.position === 'after');
