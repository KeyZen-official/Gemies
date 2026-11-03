# Navigation, categories and filters

Gemies sells men's clothing in three categories: T-Shirts, Shirts and Bottom
Wear. This records how the navigation, the category pages and the filters are
wired, and which parts are waiting on catalogue data.

## The taxonomy lives in the database

`categories` gained four columns, so the structure is data rather than code:

| column | purpose |
|---|---|
| `parent_id` | self-reference; a child is a subcategory |
| `segment` | the piece that appears in the URL |
| `display_order` | menu ordering |
| `in_nav` | whether it appears in the navigation at all |

Two slug-like columns are needed because `slug` is globally unique and the
taxonomy has both **Printed T-Shirts** and **Printed Shirts**. They cannot share
a `printed` slug, so `slug` stays the unique canonical key
(`t-shirts-printed`, `shirts-printed`) while `segment` is the URL piece
(`printed` for both), unique only within its parent.

`in_nav` is explicit rather than inferred. The reference catalogue's categories
(Sneakers, Bags, Headwear, Socks, Sunglasses) still own 12 products, so deleting
them would orphan those rows and break the homepage category tiles. They stay in
the database, keep resolving, and are flagged out of the navigation instead.

`scripts/taxonomy.mjs` applies the structure, matched on slug so re-running
renames and reorders rather than duplicating. `npm run taxonomy` runs it alone;
`npm run seed` calls it too, so a development database always has a working menu.

## Navigation

`GET /api/categories/tree` returns top-level categories with their children,
each carrying a ready-made `href`. `MegaMenu` renders that tree, so there is one
menu component rather than one per category and a new subcategory appears as
soon as it exists in the database. The only hardcoded items are the three that
are not categories, in `src/data/navigation.js`:

```
Home          /
New Arrivals  /shop?sort=newest
Collections   /#collections
```

New Arrivals is a sort of the whole catalogue, not a category, so it has no row
in `categories`.

Two interaction decisions worth recording:

- **Each category is a link and a separate expander button.** One control
  cannot do both jobs: a button-only row makes "all T-Shirts" unreachable, and
  a link-only row leaves subcategories unreachable without a pointer.
- **Desktop opens on hover *and* click**, and closing is delayed ~120ms. Hover
  alone is unusable by keyboard and unreliable on touch laptops; without the
  delay, moving the pointer diagonally from the trigger into the panel dismisses
  it. The panel is absolutely positioned, so opening it shifts nothing.

Removed from the navigation: Women, Men, Kids, Accessories, Brands. The
`/brands` route still exists and still works, but nothing links to it.

## Routes

```
/shop                        everything
/shop/t-shirts               a top-level category
/shop/t-shirts/oversized     a subcategory
```

`src/app/shop/[...segments]/page.jsx` handles category paths and uses the first
two segments only, matching the two-level taxonomy. Both it and `/shop` render
one `CategoryBrowser`, so filters, sorting, paging and the empty states exist in
a single place. `/shop?category=<slug>` still works, so existing links and the
homepage tiles are unaffected.

A category page lists the whole subtree: `/shop/t-shirts` includes everything
under it, via a recursive CTE, so nesting deeper than two levels would keep
working without touching the query.

## Filters

`GET /api/products` now accepts `size`, `color`, `fit`, `fabric` (comma-separated
multi-select), `minPrice`, `maxPrice` (minor units, as `products.price` is) and
`inStock`, and returns a `facets` block alongside the products.

Facets are computed over the **category and search scope only**, deliberately
ignoring the other active filters, so options stay put while a shopper ticks
boxes instead of disappearing underneath them.

Every option is a value the catalogue holds. A dimension with no data returns an
empty list and the panel omits that section rather than offering choices that
match nothing.

| filter | source | state today |
|---|---|---|
| Size | `variants.size` | working |
| Colour | `variants.color`, hex from `products.colorways` | working |
| Price | `products.price` | working |
| Availability | `variants.stock - reserved` | working |
| Fit | `products.fit` | **column added, no product records one, so the filter is hidden** |
| Fabric | `products.fabric` | **same** |

Fit and fabric are nullable columns added by the migration. Nothing was invented
for the existing products, so those two filters appear the moment real garments
carry the values.

## Waiting on catalogue data

**The three new categories are empty.** The catalogue holds 12 sneakers and
accessories; there are no T-shirts, shirts or bottom wear, and none were
fabricated. Every category page therefore shows an empty state, and
`CategoryBrowser` distinguishes the two kinds deliberately:

- *"Nothing matches those filters"* with a clear-filters action, when the
  shopper can fix it.
- *"No t-shirts yet — this category has been set up but has no products in it
  so far"*, when they cannot.

Add garments through the admin and the pages, the counts and the fit/fabric
filters populate with no code change.

Also still referring to the previous catalogue, and left alone because the brief
said not to touch the homepage or product-page layouts: the hero and promotional
copy in `src/data/home-content.js`, and the homepage category tiles, which point
at the retired sneaker categories.

## Verification performed

No browser was available, so nothing was confirmed by looking at the running
site.

- **57 checks against the live stack**: the tree has exactly three parents in
  the required order with 7/5/5 children; all 10 category routes return 200;
  the two Printed subcategories resolve to separate rows that each know their
  parent; an unknown category 404s; filters narrow results and multi-select
  behaves as a union; `inStock` matches its facet count; filtering by an
  unrecorded fit returns nothing rather than everything; the retired categories
  are absent from the menu but still list their products.
- **65 checks against rendered markup**, through a temporary route that fed
  `MegaMenu` and `ProductFilters` real API data, since both render on the
  client: the six navbar items in order, no Women/Men/Kids/Accessories/Brands,
  all 17 subcategory links, the two distinct `printed` URLs, `aria-expanded` and
  `aria-controls` wiring, the absolutely-positioned panel, touch-sized mobile
  expanders, and the Fit/Fabric sections correctly absent.
- 22/22 existing tests pass; production build clean; the navbar is still sticky;
  search, account, wishlist and bag icons intact with a live bag count; cart,
  wishlist, account, product and info routes unaffected.
- The only inline style in the new markup is the `--swatch` custom property on
  colour chips, which is the existing exception: a runtime hex cannot become a
  build-time Tailwind class.

**Not verified:** that the dropdown feels right on hover, that the mobile drawer
behaves through real touch, and that nothing clips at an intermediate width.
Those need a browser.
