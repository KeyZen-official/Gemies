# Product image sources and licences

**Status: 14 of 60 verified. The target was not met, and I do not believe it can
be met from freely accessible, commercially licensed sources.** The reasoning is
in "Sources assessed" and "Why the remaining 46 could not be obtained" below.

Regenerate the verification and the contact sheets with:

```
node scripts/verify-product-images.mjs      # checks + docs/contact-sheets/
node scripts/fetch-product-images.mjs       # re-downloads the MWW set
```

---

## Verified images

### T-shirts — 9 of 20

| Filename | Sub | Source | Author / provider | Licence | Commercial evidence | Dimensions | Alpha |
|---|---|---|---|---|---|---|---|
| `plain-black-bella-canvas-3001-01.png` | plain | [MWW blank images](https://mwwondemand.com/blank-images/) | MWW On Demand (Bella+Canvas 3001 blank) | No formal licence name; written permission on the repository page | "You're free to use our library of blank images for your online store or marketing needs." | 1600x2400 | 61% transparent |
| `plain-white-bella-canvas-3001-01.png` | plain | same | same | same | same | 1600x2400 | 63% |
| `plain-grey-triblend-bella-canvas-3413-01.png` | plain | same | MWW (Bella+Canvas 3413) | same | same | 1600x2400 | 61% |
| `regular-mens-tee-flat-01.png` | regular | same | MWW On Demand | same | same | 3000x3000 | 62% |
| `regular-mens-long-sleeve-tee-01.png` | regular | same | MWW On Demand | same | same | 2662x2662 | 47% |
| `polo-flat-front-01.png` | polo | same | MWW On Demand | same | same | 3918x3918 | 64% |
| `plain-white-01.png` | plain | **UNKNOWN** — pre-existing, provenance not recorded | unknown | **unverified** | **none** | 1274x1280 | 56% |
| `regular-black-02.png` | regular | **UNKNOWN** — pre-existing | unknown | **unverified** | **none** | 1274x1280 | 58% |
| `regular-red-03.png` | regular | **UNKNOWN** — pre-existing | unknown | **unverified** | **none** | 1274x1280 | 59% |

### Shirts — 2 of 20

| Filename | Sub | Source | Author / provider | Licence | Commercial evidence | Dimensions | Alpha |
|---|---|---|---|---|---|---|---|
| `casual-camp-collar-shirt-01.png` | casual | [MWW blank images](https://mwwondemand.com/blank-images/) | MWW On Demand | Written permission on page | as above | 2972x2972 | 52% |
| `full-sleeve-hooded-raglan-shirt-01.png` | full-sleeve | same | MWW On Demand | same | same | 2992x2992 | 52% |

### Bottoms — 3 of 20

| Filename | Sub | Source | Author / provider | Licence | Commercial evidence | Dimensions | Alpha |
|---|---|---|---|---|---|---|---|
| `joggers-mens-lounge-pant-01.png` | joggers | [MWW blank images](https://mwwondemand.com/blank-images/) | MWW On Demand | Written permission on page | as above | 3029x4084 | 60% |
| `casual-shorts-training-01.png` | casual-shorts | same | MWW On Demand | same | same | 3600x3600 | 41% |
| `casual-shorts-woven-01.png` | casual-shorts | same | MWW On Demand | same | same | 2880x2880 | 61% |

Download URLs are public Google Drive links published on the MWW repository
page; the exact file IDs are resolved at run time by
`scripts/fetch-product-images.mjs` rather than pasted here, because MWW
re-points them when assets are updated.

---

## Rejected

Moved to `public/products/_rejected/` so they cannot be used by accident.

| Filename | Reason |
|---|---|
| `regular-white-01.png` | **Cropped.** Opaque content reaches the left and top edge. Pre-existing file; kept rather than deleted, per instruction. |
| `casual-denim-western-shirt-01.png` | **Cropped** at the bottom edge. It is also an on-model shot with an identifiable face, which needs a model release for commercial use that MWW's page does not mention. |
| `joggers-mens-on-model-01.png` | **Cropped** at the top edge — the model's torso is cut off. On-model, so the same model-release question applies. |

### Also considered and not downloaded

| Item | Reason |
|---|---|
| MWW swim trunks, board shorts, bikini | Swimwear, not in the requested subcategories |
| MWW fleece crew neck, pullover/zip hoodies | Sweatshirts, not T-shirts or shirts |
| MWW leggings, skirts, dresses, women's overalls, women's denim | Women's clothing — excluded |
| MWW socks, totes, bandanas, belts, face masks, bags | Accessories — excluded |
| MWW baseball/basketball/soccer jerseys | On-model only; sportswear rather than the requested categories |
| MWW denim jackets, vests, windbreaker, poncho, kimono | Outerwear, not in the requested subcategories |

---

## Sources assessed

### 1. MWW On Demand — **accepted**, and the only one

<https://mwwondemand.com/blank-images/>

The repository page carries an explicit written grant:

> You're free to use our library of blank images for your online store or
> marketing needs.

That is the clearest commercial permission found anywhere in this search. No
login, paywall or rate limit was encountered or bypassed; the assets are public
Google Drive links published on that page for this purpose.

**Its ceiling is about 13 men's items across the three categories, not 60.** It
is a print-blanks library: it stocks what decorators print on. It has no jeans,
no cargo pants, no formal trousers, no denim shorts, no linen shirts, no formal
shirts, and by definition no graphic or printed garments.

Two further caveats, visible on the contact sheets:

- **Almost everything is white or natural.** Blanks are photographed undyed so
  a decorator can mock up artwork. There is no colour range.
- **The garments are Bella+Canvas and MWW blanks**, not Gemies garments. See
  "The question that decides whether any of this is usable".

### 2. AS Colour — **rejected**, licence does not cover this use

<https://www.ascolour.com.au/downloads>

The downloads page states that product imagery use is governed by their Brand
Guidelines, which it describes as:

> created for users of the AS Colour brand … rules to follow when using AS
> Colour logos and other graphic assets … for any instance where the AS Colour
> brand is used.

That is a brand-asset licence for people marketing AS Colour products. Using the
imagery to depict a different label's garments falls outside it. I did not
download anything, and I did not attempt to get behind the asset portal.

### 3. PurePNG — **rejected**, licence cannot be relied on

<https://purepng.com/category/clothing>

Two problems:

- The site returned **HTTP 403** to programmatic requests, so its licence terms
  could not be read directly and per-asset licences could not be checked.
- Its clothing category consists largely of background-removed cut-outs of
  copyrighted brand product photography. A blanket site-wide CC0 declaration
  does not transfer rights the site never held.

The brief says to mark unclear licences as rejected. This is that case. Nothing
was downloaded.

### 4. Commercial stock libraries — **not used**, paywalled

Adobe Stock, Shutterstock, Freepik Premium and PNGTree Premium do carry properly
licensed transparent-background apparel PNGs, including the jeans, cargo pants,
trousers and formal shirts that are missing. All require a paid subscription.
Per the brief I did not bypass the paywall and am reporting the restriction
instead.

**This is the realistic route to the missing 46 images.** A single month of one
of these subscriptions would very likely cover the whole set with a clean,
auditable licence.

### 5. CC0 / public-domain libraries — **not viable at product quality**

Openverse, Wikimedia Commons, Openclipart and similar do hold CC0 clothing
images, but they are overwhelmingly either photographs on real backgrounds
(no alpha channel) or vector illustrations rather than product photography.
Neither satisfies "genuine product photography with a transparent background".

---

## The three pre-existing images have no provenance

`plain-white-01.png`, `regular-black-02.png` and `regular-red-03.png` pass every
technical check and are genuine transparent PNGs of complete garments. Their
visual style matches a blank-apparel catalogue.

**But no source, author or licence was recorded for them**, and I could not
identify their origin. They are listed above with their licence marked
unverified. The brief says not to invent licence information, so I have not.

Before these are used commercially, either establish where they came from or
replace them. They are the one part of this set I would not ship as-is.

---

## Why the remaining 46 could not be obtained

| Subcategory | Required | Verified | Why not |
|---|---:|---:|---|
| tshirts/oversized | — | 0 | Not stocked by any accessible free source |
| tshirts/graphic | — | 0 | Blanks libraries carry undecorated garments by definition |
| tshirts/heavyweight | — | 0 | Not distinguished in accessible libraries |
| shirts/formal | — | 0 | Tailoring is not a print blank; absent from blanks libraries |
| shirts/linen | — | 0 | Same |
| shirts/printed | — | 0 | Same as graphic tees |
| shirts/oversized | — | 0 | Same |
| bottoms/jeans | — | 0 | Denim is not a print blank; absent |
| bottoms/cargo | — | 0 | Absent |
| bottoms/trousers | — | 0 | Absent (MWW has lounge/pyjama pants only) |
| bottoms/denim-shorts | — | 0 | Absent |

The pattern is consistent: free transparent-background apparel PNGs exist almost
exclusively as **print blanks**, because that is the one commercial reason
anyone cuts out apparel on alpha and gives it away. Everything the brief asks
for beyond blanks — denim, tailoring, graphics, oversized cuts — sits behind a
paid stock licence or belongs to a brand.

---

## The question that decides whether any of this is usable

Every verified image depicts a **Bella+Canvas or MWW blank**, not a Gemies
garment. Whether that is acceptable turns on something I do not know:

- **If Gemies sources these blanks** and prints or sells them, this imagery is
  exactly what it is published for, and the listings are accurate. Many small
  clothing brands work precisely this way.
- **If Gemies sells its own different garments**, then these photographs show
  the wrong product. That is a problem no licence fixes: the store is wired for
  live Razorpay payments, so a customer would be paying for a garment depicted
  by somebody else's garment.

I cannot resolve that from the codebase. It needs your answer before any of
these 14 files goes on a live product page.

For a real storefront, the durable answer is photography of your own stock on a
white sweep with the background removed — which also gives you the colour range
and the garment types this search could not find.

---

## How these are used

The source PNGs in `public/products/` are the library and are not served. They
are 0.3–24 MB each, which is fine for a source file and unusable on a product
page.

`scripts/build-product-assets.mjs` turns them into web assets:

- Trims each garment to its own edges, then re-pads it into a square frame with
  the same 12% margin, so one tee does not fill its card while the next sits
  tiny in the middle of one.
- Writes WebP with alpha preserved, max 1400px, to `public/assets/products/`.
  **All 14 together are 1.3 MB**, down from 70 MB of source PNG.
- Samples each garment's own mean colour for its swatch, so the colour shown on
  the card is measured from the photograph rather than typed in.
- Composes the three homepage category tiles from a representative garment.

`scripts/seed.mjs` then creates 14 products from that manifest, filed against
the taxonomy, brand `Gemies`, audience `Men`, with size runs (S–XXL for tops,
W30–W36 for the jogger) and deterministic stock that leaves some sizes empty so
the sold-out states stay exercised.

**Every product is flagged `is_demo`.** That excludes it from production queries
and makes `createOrder` refuse it in production. It stays that way until you
confirm the two open questions above: whether you source these blanks, and where
the three unprovenanced images came from.

The previous footwear catalogue, its five categories and its sixteen images were
deleted in the same pass. `scripts/extract-assets.mjs` no longer generates them,
so they cannot come back.

## Verification method

`scripts/verify-product-images.mjs` checks every file for:

1. PNG magic bytes — catches a JPEG renamed to `.png`
2. A declared alpha channel
3. **Actual transparent alpha pixel values**, at least 5% of the image. An
   opaque RGBA file is rejected; colour mode alone is never treated as proof
4. Longest side at least 1000px
5. Not cropped — the opaque bounding box must not reach any frame edge within a
   1% tolerance
6. Not a duplicate — matched on alpha silhouette **and** mean garment colour, so
   the same cut in a different colour is correctly kept as a separate product
7. Decodes without error

It also reports the mean colour behind the alpha channel, which exposes a
background that was masked rather than removed, and flags a painted
transparency checkerboard.

Contact sheets are written to `docs/contact-sheets/` over mid-grey, so white and
black garments are both visible and any residual opaque background shows up.
**Automated checks cannot confirm a picture shows the right garment** — the
contact sheets are there for that, and reviewing them is how the two on-model
shots and the all-white palette were caught.
