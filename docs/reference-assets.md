# Reference inspection and extracted assets

The supplied `LayoutPhoto/` folder contains six JPEG screenshots. There are no original photo files, logos, font files, product data, mobile designs, or source code. All supplied images were inspected before extraction; the six originals remain unchanged.

Five detail screenshots are stored sideways. `scripts/extract-assets.mjs` rotates these 90 degrees clockwise, crops the relevant regions, joins adjacent strips where a photo spans two screenshots, and then **removes the design's own text from the photography**. The reproducible command is `node scripts/extract-assets.mjs` (requires `sharp`).

## Visual language

- Brand shown: Gemies, with a small white interlocking symbol.
- Neutral white/off-white page, near-black type and footer, pale gray product-image panels.
- Rounded white and black pill buttons; thin black outline for secondary collection buttons.
- Sans-serif type resembling Arial/Helvetica. The original family cannot be determined from raster screenshots.
- Full-width photographic hero, centered two-line headline, white supporting copy, white Shop Now CTA.
- Content inset roughly 5% from the page sides; three evenly spaced product columns.
- Three promotional tiles, centered Just Dropped Collections heading, two rows of sneakers, asymmetric collection grid, two rows of accessories, photographic banner, dark footer.
- Approximate desktop scale in detail screenshots: 42px section headings, 18px body/product names, 16px secondary text. Final responsive type sizes account for the viewport scale of the screenshots.
- Approximate palette: page `#fafafa`, cards `#f1f1f1`, text/footer `#111111`, secondary copy `#777777`. The promotional offer gradient is sampled from the artwork and recorded in `manifest.json` as `offerGradient` (`#cf9486` to `#cea4bc`).

## Removing the baked text

Because the source is page screenshots, every photograph arrives with headings, captions and buttons painted into the pixels. Those must never reach the site as UI — the components render their own real headings, links and buttons. Two techniques are applied:

- **Crop** where the text sits in a band outside the subject: the Puma promo copy block, and the top band of every product tile, which carries a brand logo and colour dots. The dots are sampled for real swatch data before the band is cropped away; the logo is not, because proper logo files were supplied (see below).
- **Soften** where the text overlaps the photograph: a full-width horizontal band is blended with a heavily blurred copy through a feathered mask. A full-width band reads as natural depth of field; patching tight rectangles around each line of text left obvious grey boxes floating in the frame.

Each component then places a gradient scrim and its own text over the softened band, so the softening is not visible as an artefact.

### Known limitation: hero and closing banner

In those two images the baked headline runs across the middle of the frame and covers roughly two thirds of its height, leaving no sharp region worth protecting. Both are softened whole and used as backdrops under a scrim and a real headline. Blur strong enough to destroy a 60px headline also costs the sneaker detail, and a lower setting leaves the old headline legible.

**These two will look soft until the original photograph files are supplied.** Dropping a sharp photo in at `public/assets/hero.webp` and `public/assets/footer-banner.webp` needs no code change; `HeroBanner` and `BottomPromoBanner` already treat them purely as background photography.

## Assets

All outputs are WebP under `public/assets/`. `manifest.json` records dimensions, treatment notes and sampled swatches; `product-colors.json` records the colour dots per product slug.

| Asset | Purpose | Text treatment |
|---|---|---|
| `hero.webp` | Hero photograph | Baked navigation and carousel cropped out; whole frame softened |
| `footer-banner.webp` | Closing banner | Whole frame softened |
| `product-colors.json` | Swatch colours sampled from the reference dots | — |

### No longer produced

The store sold footwear when these screenshots were the reference. It sells its
own men's clothing now, so this script no longer produces the sneaker and
accessory photography, the footwear category mosaic, the per-brand logos, or
the two photographic promo tiles (`promo-puma.webp`, `promo-nike.webp` — the
second was a lifestyle shot of a man wearing a shirt). Their generation is
deleted rather than commented out, so a re-run cannot bring them back.

What replaced them: the garment photography in `public/products/` is verified by
`scripts/verify-product-images.mjs` and turned into web assets by
`scripts/build-product-assets.mjs`, which also composes the three category
tiles (`collection-t-shirts.webp`, `collection-shirts.webp`,
`collection-bottom-wear.webp`). The promo cards now show one isolated garment
each on a flat tint, so there is no baked text to remove in the first place.

The third promotional tile needs no photograph: its background is pure CSS
gradient, with an isolated garment drawn over it by `OfferCard`.

## The store mark

Gemies sells its own label, so there is one mark everywhere rather than a logo per product brand. The source is `brand-logos/gemies.png`; `scripts/extract-assets.mjs` trims it to its ink, scales it to 120px tall and writes two WebP files to `public/assets/brands/`. The 274 KB PNG becomes 3.1 KB and 5.1 KB.

**Two tones, from one source.** The supplied artwork is cream ink (`#fdfaf5`) on transparency, made for a dark background. It is all but invisible on the white navbar and on the card's `#f1f1f1` panel, so the pipeline also emits a variant recoloured to `#111111`. The mark is monochrome, so swapping the ink while keeping the alpha channel is a faithful tone variant rather than a redesign — `sharp`'s `blend: 'in'` does exactly that.

| file | ink | used on |
|---|---|---|
| `gemies.webp` | `#111111` | product card, navbar on white |
| `gemies-light.webp` | as supplied | footer (`bg-ink`), navbar over the hero |

`src/data/store-mark.js` holds both paths and the intrinsic size; `Logo` takes a `tone` prop and `ProductCard` always uses the dark one. Trimming before scaling matters: without it the artwork's transparent padding, not the mark, would decide the on-screen size.

The earlier per-brand marks (Nike, Adidas, Puma, New Balance) are no longer generated or shipped, and `src/data/brand-marks.js` is gone. Those four source PNGs are still in `brand-logos/` but nothing reads them, so they can be deleted.

Note that the twelve reference products still carry `brand` values of Nike, Adidas, Puma and New Balance in the database. The card no longer displays those, which is correct for a single-label store but means the mark and the `brand` column disagree until the catalogue holds real Gemies products.

## How the sections are built

Every section is a component under `src/components/`, with its copy in `src/data/home-content.js`:

`Navbar`, `HeroBanner`, `PromoCard`, `OfferCard`, `ProductCard`, `ProductGrid`, `CategoryCard`, `RecommendedCollections`, `CollectionSection`, `BottomPromoBanner`, `Footer`.

Product name, price, category, brand and colour swatches are real elements fed from the database. Swatches live in `products.swatches`, populated by `npm run seed` from `product-colors.json`.

## Important limits

The `FOOTENSTOCK` promotion and the dollar prices are reference content, not an authorized commercial offer. `OfferCard` therefore shows a note in development making clear that no discount is configured; wiring a real promotion means creating a coupon and removing that note. Production catalogue prices, stock, currency, discounts, business identity and product usage rights all require business confirmation. Reference-derived seed products are flagged `is_demo` and are excluded from production queries.

Product crops are roughly 375x320 after the top band is removed; some stitching boundaries show slight resampling seams. Source photos and original font files should replace these derivatives before a high-resolution launch.

Footer social links come from store settings (`social_x`, `social_facebook`, `social_instagram`, `social_linkedin`) and render only when set to an `https` URL, so the footer never links to an invented account.

## Sampling the colour dots

`sampleSwatches` in `scripts/extract-assets.mjs` reads the dot row from each tile's top-right band. The dots are equal circles that overlap their neighbours, which defeated two simpler approaches: clustering colours along a single row merged neighbours of a similar colour and under-counted, and measuring the dot diameter down a single column broke whenever that column fell between two dots, or the product photograph intruded into the band and offered a longer row of non-background pixels than the dots themselves.

The current method masks everything that differs from the band's dominant colour, groups the mask into blobs, and discards every blob that reaches a band edge — the photograph always enters from the left or the bottom, while the dots never touch a side. That one rule removes the gym bag's strap and the backpack's handle. Blob height gives the dot diameter; because the dots overlap, the count comes from `(span - diameter) / pitch + 1` with the pitch measured at 0.69 of the diameter, not from dividing the span by the diameter.

Counts were checked against the reference tiles read by eye: four dots each on the six sneakers, three on the backpack, both pairs of socks and the gym bag, and none on the cap or the sunglasses, which carry no dots at all. `cap` and `sunglasses` therefore show no swatch row, which is correct rather than a detection failure.

## Verification performed

Regenerated all 20 derivative WebP files plus the four brand logos from the supplied originals without modifying them. Visually inspected the hero, the Puma and Nike promos, the bags and sneakers category tiles, the cap product crop and the closing banner to confirm no baked heading, caption or button survives, and the four generated logos to confirm each is the correct mark on a clean alpha background. Confirmed the rendered homepage contains every heading, caption and button as real markup, that the product API supplies brand, category, price and swatches, and that no `hero-content`, `hero-mobile` or `promo-offer` asset is referenced any more.

`ProductCard` itself was verified by rendering all twelve products plus four synthetic edge cases (unknown brand, six colours, empty colour list, `null` colour data) through Next's server renderer and asserting 62 checks against the resulting markup: logo file per brand, text fallback, the swatch row being inert, the `+N` remainder, the shared image box, the hover zoom and its reduced-motion opt-out, and the name/price/category rows. **No browser was available, so nothing was confirmed by looking at the running site.** The card layout was instead reconstructed from its own CSS values to confirm the logo and the dot row cannot collide at either breakpoint.
