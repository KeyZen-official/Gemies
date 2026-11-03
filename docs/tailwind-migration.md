# Tailwind CSS migration — complete

## Starting point

Tailwind was **not installed**. There was no `tailwindcss` package, no
`tailwind.config.*` and no `postcss.config.*`, so there was no existing version
to match. **Tailwind v4.3.3** was installed, the current stable line.

v4 takes its configuration from CSS, so there is no `tailwind.config.js`. The
theme lives in `@theme` inside `src/styles/tailwind.css`.

Measured surface at the start: **632 CSS rules** across three stylesheets
(53 KB) and **321 `className` attributes** across 27 files.

## Result

**One stylesheet remains**: `src/styles/tailwind.css` (the Tailwind import,
`@theme` tokens, `@layer base` element defaults). It contains **no component
class selectors**. All component and page styling is utility classes.

| Stylesheet | Status |
|---|---|
| `src/styles/home.css` | **Deleted** (226 rules) |
| `src/styles/product.css` | **Deleted** (99 rules) |
| `src/styles.css` | **Deleted** (307 rules) |
| `src/styles/tailwind.css` | Import, `@theme`, `@layer base` only |

## Setup

| File | Purpose |
|---|---|
| `postcss.config.mjs` | Registers `@tailwindcss/postcss` |
| `src/styles/tailwind.css` | `@import "tailwindcss"`, `@theme`, `@layer base` |

Tokens carried over verbatim: `--color-ink`, `--color-ink-soft`,
`--color-body`, `--color-panel`, `--color-rule`, `--color-line`, the offer
gradient pair, `--container-shell` (1320px) and `--spacing-nav` (navbar
height, which the hero's negative offset also reads).

## Reusable primitives

| Component | Replaces |
|---|---|
| `ui/Container.jsx` | the `.container` width rule |
| `ui/Button.jsx` | `.button`, `.button.dark`, `.button.outline`, `.button.full`, `.icon-button` |
| `ui/SectionHeading.jsx` | `.section-title`, `.section-title.split` |
| `ui/Surface.jsx` | `.panel`, `.badge`, `.notice`, `.text-button`, `.table-wrap`, `.account-tabs`, `.section-heading` |
| `ui/Badge.js` | `badgeClasses(status)` for dynamic order statuses |

`buttonClasses(variant, extra)` exports the same classes as a string, for the
few elements that cannot use the component: `mailto:` links and `<a>` download
targets, since `Button` routes `href` through `next/link`.

## Migrated files

**Phase 1 — chrome and homepage (11 components)**
`Navbar`, `Footer`, `HeroBanner`, `PromoCard`, `OfferCard`, `CategoryCard`,
`CollectionSection`, `RecommendedCollections`, `BottomPromoBanner`,
`ProductCard`, `ProductGrid`, plus `app/shell.jsx` and `Logo`.

**Phase 2 — shared primitives**
`components.jsx`: toast, `Loading`, `ErrorState`, `Empty`, `PageTitle`,
`Field`, `AddressFields`, `Summary`.

**Phase 3 — product detail (12 components)**
`ProductDetail`, `ProductGallery`, `ProductColorSelector`,
`ProductSizeSelector`, `QuantitySelector`, `DeliveryChecker`,
`ProductSpecifications`, `ProductPolicies`, `ProductReviews`, `SizeGuide`,
`RelatedProducts`, `useProductSelection` (no styling).

The page was later rebuilt against the Nike reference screenshots, which added
`ProductHeader`, `ProductSummary`, `ProductDetailsPanel` and `ProductReturns`
and removed `QuantitySelector`. All of them are Tailwind-only; see
`docs/product-detail-page.md`.

**Phase 4 — storefront pages**
`storefront.jsx`: Shop, Cart, Checkout, Wishlist, Brands, Info.

**Phase 5 — account and authentication**
`account.jsx`: sign-in/register/reset, Account, OrderHistory, Addresses,
Order, OrderView.

**Phase 6 — admin**
`admin.jsx`: Dashboard, Products, ProductEditor, Orders, OrderAdmin,
Categories, Customers, Coupons, Settings, Audit.

## Two necessary exceptions

**1. Inline styles for database-driven colours (2 remaining).**

- `ProductCard` — `style={{ background: colour }}` on each swatch dot
- `ProductColorSelector` — `style={{ '--swatch': colorway.hex }}`

Tailwind generates classes by scanning source at build time. A colour arriving
from the database at runtime cannot become a utility class, and safelisting is
impossible because the values are arbitrary per-product hexes. The alternative
is a fixed hardcoded palette, which would stop the swatches reflecting the
catalogue. These are the only `style=` attributes in the codebase.

**2. `@layer base` for element defaults.**

Resets and element-level defaults target bare tags: `html`, `body`, headings,
`p`, `small`, `hr`, `input`/`select`/`textarea`, `details`/`summary`,
`button:disabled`, `:focus-visible`, `::selection`, and the
`prefers-reduced-motion` reset. Making these utilities would mean adding
classes to every tag in the app. Tailwind's own guidance is `@layer base`.

## Behaviour changes

Two, both deliberate:

1. The navbar's inline links now collapse into the mobile menu below Tailwind's
   `lg` breakpoint (1024px) rather than the previous custom 899px, so the
   responsive prefixes stay consistent. Between 900px and 1023px the hamburger
   now shows where inline links used to.
2. Tailwind's `sm`/`md`/`lg`/`xl` breakpoints (640/768/1024/1280) replace the
   old custom 600/768/850/1100 ones. The nearest prefix was used in each case,
   so a few transitions move by up to 50px.

## Verification

- `npm run build` — clean, zero warnings
- `npm test` — 22/22 passing
- **41 automated checks** passing: all three legacy stylesheets deleted, only
  `tailwind.css` left in `src/styles`, no component selectors in it, exactly
  two inline styles, 16 routes render with the sticky navbar, one stylesheet
  served, preflight and theme tokens emitted, twelve named legacy selectors
  (`.page`, `.panel`, `.summary`, `.cart-item`, `.auth-panel`,
  `.account-tabs`, `.stats-grid`, `.table-wrap`, `.toast`, `.gallery-main`,
  `.product-panel`, `.size-option`) confirmed absent from the shipped CSS, and
  the config/products/variant APIs still serving with colourways intact.

**Not verified: the rendered appearance.** No browser automation is available
in this environment, so the migrated screens have not been compared visually
against the previous build. Checkout, authentication and admin are the screens
worth checking first.
