# Product detail page

Rebuilt against the supplied Nike product page screenshots. Everything lives under
`src/components/product/`; the route is `src/app/product/[slug]/page.jsx`, which still only
supplies metadata and renders `ProductDetail`.

## Layout

```
grid-cols-1                                    mobile: stacked
md:grid-cols-[minmax(0,1.1fr)_minmax(300px,1fr)]   tablet: balanced two columns
lg:grid-cols-[minmax(0,1.3fr)_minmax(380px,0.95fr)] desktop: 58% / 42%
```

The gallery is `lg:sticky` so it pins while the taller information column scrolls past it. The
brief allowed either column to be sticky; the gallery is the shorter of the two, so pinning it is
what keeps something useful on screen. It also carries `lg:z-10`, because the information column
contains positioned elements (the PIN code field) that would otherwise paint over the magnifier on
DOM order. It stays below the navbar's `z-50`.

## Components

| Component | Section | Notes |
|---|---|---|
| `ProductGallery` | left column | thumbnail rail, main image, arrows, hover magnifier |
| `ProductHeader` | A, B, C | status label, name, brand/category, price, tax line |
| `ProductColorSelector` | — | existing component, restyled to the new rhythm |
| `ProductSizeSelector` | D | two-column grid, size guide link |
| `ProductSummary` | G | description, colour shown, style code |
| `ProductDetailsPanel` | H | `<details>` wrapping `ProductSpecifications` |
| `DeliveryChecker` | I | PIN code, courier rate and estimate |
| `ProductReturns` | J | policy line and Know more link |

`QuantitySelector` was removed. The reference has no stepper, and the bag already edits quantity
per line through the same `PUT /cart/items` endpoint, so nothing was lost.

## The hover magnifier

A second copy of the same `<img>`, laid out identically to the main one and scaled about the cursor
with `transform-origin`. Three decisions are worth recording.

**Why not `background-position`.** The main image is `object-contain`, so it letterboxes inside its
frame. Driving the panel with a background image would have meant reproducing that letterboxing by
hand to keep the lens and the panel showing the same region. Sharing one layout removes that class
of bug: both copies have the same box aspect ratio and the same `p-[5%]`, so a fractional point maps
to the same place in each. The panel must keep the frame's aspect ratio for this to hold.

**Why the panel is 74% of the image width.** A full-width panel at `left: 100% + 20px` runs
114–170px past the container at every desktop width from 1024px up, and an absolutely positioned box
still counts towards scrollable overflow, so it would put a horizontal scrollbar on the page. 74% is
the widest that fits, with about 20px spare. Because the panel is narrower than the image,
on-screen magnification is `3 x 0.74 = 2.2x`.

**Why it writes to the DOM.** Cursor tracking sets CSS custom properties (`--zoom-origin`,
`--lens-x`, `--lens-y`) directly on the nodes rather than going through state, so moving the mouse
re-renders nothing. Only entering and leaving the image flips React state. The panel is always
mounted and toggled with opacity, so the image is never re-requested.

The lens is sized `1/ZOOM` of the frame and travels `x * width * (1 - 1/ZOOM)`, which is exactly the
slice `scale(ZOOM)` about the cursor leaves visible. `ZOOM` is a constant, but Tailwind needs
literal class names, so `scale(3)` and `h-[33.333%] w-[33.333%]` are derived by hand and have to be
changed with it.

The magnifier is gated on `(hover: hover) and (pointer: fine) and (min-width: 1024px)`, re-evaluated
on change. Touch devices get the thumbnails, the arrows and tap-to-enlarge instead.

### Known deviation from the brief

The brief asked that the zoom preview not cover the information column, but also that it sit to the
right of the main image, and the supplied screenshot shows Nike's own panel covering the
information column. Both cannot hold: at 1440px the gallery is 735px and the information column
537px, so there is no 500px-wide gap inside the gallery to put a panel in. Shrinking the main image
to make one would cost every visitor a smaller photograph to avoid a preview that is only on screen
while the pointer is over the image.

So the panel overlays the information column, matching the screenshot and the acceptance criteria.
It is `pointer-events-none`, so it never intercepts a click, and the pointer is on the image
whenever it is visible. To reverse this, drop `left-[calc(100%+20px)]` and `w-[74%]` from the panel
in `ProductGallery` and give it `inset-0` instead; it then magnifies in place inside the image frame.

## Data limits

These are catalogue gaps, not layout decisions, and each one resolves itself when the data arrives.

- **One photograph per product.** Every one of the twelve products has a single image and no
  colourway photography, so the thumbnail rail and the previous/next arrows never appear with real
  data. Both are built and render as soon as a product has more than one image; this was confirmed
  against a product pointed at four real asset files.
- **No material or construction fields.** `products` has no columns for material, closure, sole or
  country of origin, so `ProductSpecifications` lists what exists and says the rest is not recorded
  rather than inventing it.
- **Tax.** Checkout adds tax on top of the listed price at `store_settings.tax_bps`. The header
  prints "Inclusive of all taxes" only while that rate is zero, which it currently is; with a rate
  set it says tax is added at checkout instead.
- **Delivery.** `store_settings` has no shipping account configured, so the delivery section says
  so. With one connected, each courier's own quoted rate and estimate are printed as returned, and
  "No delivery estimate provided by this courier" where one gives none.
- **Returns.** `store_settings.returns_policy` is empty, so the returns line says no policy is
  published. The reference reads "14-day return and size exchange"; that is the retailer's own
  policy and is not claimed here.
- **Status label.** Derived from `featured` and `created_at`: "Just In" for a featured product added
  in the last 30 days, "Featured" otherwise, nothing for an unfeatured one. There is deliberately no
  "Bestseller", because nothing exposes units sold.
- **Buy now** renders only when payments are configured, so it is absent in development rather than
  present and permanently dead.

## Verification

No browser was available, so nothing was confirmed by looking at the running page.

- 93 assertions against server-rendered markup, driven through a temporary route that fed
  `ProductView` real API data, covering five cases: a multi-size sneaker, a single-size accessory, a
  discounted product, a sold-out colourway, and a product with four images. These checked the column
  ratios, the gallery, the A–J section order and its contents, the size grid's disabled and selected
  states, the purchase buttons, the accordion, and that the only inline style on the page is the
  colour swatch custom property.
- 19 checks on the magnifier: that its utilities reach the production stylesheet, that its logic is
  in the client bundle, that the tracking routine sets no React state, that the lens equals the
  region the panel shows at every cursor position, and that the panel fits the container from 1024px
  to 2560px.
- The layout was reconstructed from its own CSS values at 1440px and rendered, including cropping
  and scaling the lens region, to check the composition and the overlap.
- 22/22 existing tests pass; production build is clean; all twelve product routes return 200 with
  per-product metadata intact.

**Not verified:** that the magnifier feels smooth, that the sticky column behaves correctly through
a real scroll, and that nothing clips or reflows at an intermediate viewport width. Those need a
browser.
