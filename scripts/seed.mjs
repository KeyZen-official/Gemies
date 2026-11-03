// Development catalogue: men's clothing.
//
// Products are built from the verified transparent-background garment images
// in public/products/, via the web assets scripts/build-product-assets.mjs
// produces. Provenance and licence for every image are recorded in
// docs/PRODUCT_IMAGE_SOURCES.md.
//
// Everything is flagged is_demo=true and so is excluded from production
// queries and refused by checkout in production. That is deliberate: the
// garments photographed are blanks from a supplier library, not confirmed
// Gemies stock, and prices, sizes and stock levels are development values.
// Clear those two things with the store before removing the flag.
//
// The previous footwear catalogue is removed here, along with its categories.
//
// The SQL version wrapped the whole swap in one transaction. This one does
// not, and deliberately: every write below is an idempotent upsert keyed on a
// slug or a (product, size, colour), so a re-run converges whether or not the
// previous run finished. Holding thirty products and seventy variants in a
// single MongoDB transaction would buy atomicity nothing here needs and risk
// aborting on a duplicate key during a re-seed.
import {readFile} from 'node:fs/promises';
import {
  connect, close, ensureSchema,
  products, variants, categories, orderItems, cartItems, wishlist,
} from '../server/mongo.mjs';
import {id} from '../server/security.mjs';
import {applyTaxonomy} from './taxonomy.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Development seed is prohibited in production.');
await connect();
await ensureSchema();

const manifest = JSON.parse(
  await readFile(new URL('../public/assets/products/manifest.json', import.meta.url), 'utf8'),
);

// Tops run a garment size range; bottoms run a waist range.
const SIZES = {
  tops: ['S', 'M', 'L', 'XL', 'XXL'],
  waist: ['W30', 'W32', 'W34', 'W36'],
};

// Deterministic, so re-seeding gives the same catalogue. Leaves some sizes at
// zero, which is what exercises the product page's disabled-size state and the
// card's sold-out badge.
function stockFor(sizeIndex) {
  if ((sizeIndex * 3) % 7 === 2) return 0;
  return 5 + ((sizeIndex * 4) % 11);
}

const describe = (name, colour) =>
  `${name} in ${colour.toLowerCase()}. A men's everyday essential, cut for regular wear and easy layering. `
  + 'This development catalogue entry uses a supplier blank photograph; fabric composition, fit, '
  + 'sizing, pricing and stock must be confirmed by the store before sale.';

const removed = {products: 0, categories: 0};

// The category structure first: the products below are filed against it, so on
// a fresh database it has to exist before they are inserted.
const {applied, retired} = await applyTaxonomy();

/** Whether any of a product's variants is in an order or someone's bag. */
async function isReferenced(productId) {
  const variantIds = await variants().distinct('_id', {product_id: productId});
  if (!variantIds.length) return false;
  const [ordered, inCart] = await Promise.all([
    orderItems().countDocuments({variant_id: {$in: variantIds}}, {limit: 1}),
    cartItems().countDocuments({variant_id: {$in: variantIds}}, {limit: 1}),
  ]);
  return ordered > 0 || inCart > 0;
}

// ---- Remove the previous footwear catalogue.
//
// Variants referenced by a bag or an order are left alone: in SQL those rows
// were pointed at by foreign keys and deleting them would corrupt order
// history. MongoDB would not stop us, which makes the check more important
// rather than less. Any such product is unpublished instead, so it leaves the
// storefront without destroying the record.
const legacySlugs = ['air-force', 'gv-special', '1906', 'samba', '1000', 'air-force-tan',
  'backpack', 'cap', 'nb-socks', 'adidas-socks', 'gym-bag', 'sunglasses'];

for (const slug of legacySlugs) {
  const product = await products().findOne({slug}, {projection: {_id: 1}});
  if (!product) continue;
  if (await isReferenced(product._id)) {
    await products().updateOne({_id: product._id}, {$set: {published: false, featured: false}});
  } else {
    await wishlist().deleteMany({product_id: product._id});
    await variants().deleteMany({product_id: product._id});
    await products().deleteOne({_id: product._id});
    removed.products += 1;
  }
}

// Their categories go too, once nothing references them.
for (const slug of ['sneakers', 'bags', 'headwear', 'socks', 'sunglasses']) {
  const category = await categories().findOne({slug}, {projection: {_id: 1}});
  if (!category) continue;
  if (await products().countDocuments({category_id: category._id}, {limit: 1})) continue;
  await categories().deleteOne({_id: category._id});
  removed.categories += 1;
}

// ---- Seed the clothing catalogue.
for (const [index, entry] of manifest.entries()) {
  const category = await categories().findOne({slug: entry.category}, {projection: {_id: 1}});
  if (!category) throw new Error(`category ${entry.category} is missing; run npm run taxonomy first`);

  // One colourway per garment: each source photograph is a single colour, and
  // inventing others would promise stock that does not exist.
  const colorways = [{name: entry.colour, hex: entry.hex, images: [entry.image]}];

  // Upsert on slug, so re-seeding refreshes rather than leaving an older shape.
  // `created_at` and the id are only written on insert, so a re-seed does not
  // reshuffle the catalogue's ordering or break references to a product.
  const newId = id();
  const product = await products().findOneAndUpdate(
    {slug: entry.slug},
    {
      $set: {
        name: entry.name,
        description: describe(entry.name, entry.colour),
        brand: 'Gemies',
        category_id: category._id,
        audience: 'Men',
        price: entry.price,
        compare_price: null,
        images: [entry.image],
        published: true,
        featured: index < 6,
        is_demo: true,
        display_order: index,
        swatches: [entry.hex],
        colorways,
        fit: null,
        fabric: null,
      },
      $setOnInsert: {_id: newId, id: newId, created_at: new Date()},
    },
    {upsert: true, returnDocument: 'after'},
  );

  // Drop any variant this product no longer offers, unless it is spoken for.
  const existing = await variants().find({product_id: product._id}, {projection: {_id: 1}}).toArray();
  for (const variant of existing) {
    const [ordered, inCart] = await Promise.all([
      orderItems().countDocuments({variant_id: variant._id}, {limit: 1}),
      cartItems().countDocuments({variant_id: variant._id}, {limit: 1}),
    ]);
    if (!ordered && !inCart) await variants().deleteOne({_id: variant._id});
  }

  const sizes = SIZES[entry.sizing];
  for (const [sizeIndex, size] of sizes.entries()) {
    const variantId = id();
    await variants().updateOne(
      {product_id: product._id, size, color: entry.colour},
      {
        $set: {stock: stockFor(sizeIndex)},
        $setOnInsert: {
          _id: variantId,
          id: variantId,
          sku: `${entry.slug}-${size}`.replaceAll(' ', '-').toUpperCase(),
          reserved: 0,
        },
      },
      {upsert: true},
    );
  }
}

const [published, variantCount, soldOut] = await Promise.all([
  products().countDocuments({published: true}),
  variants().countDocuments({}),
  variants().countDocuments({stock: 0}),
]);

console.log(`Removed ${removed.products} footwear products and ${removed.categories} of their categories.`);
console.log(`${published} men's clothing products seeded with ${variantCount} size variants (${soldOut} deliberately out of stock).`);
console.log(`${applied} store categories applied for the navigation.`);
if (retired.length) console.log(`Taken out of the navigation: ${retired.join(', ')}.`);
console.log('\nEvery product is flagged is_demo: excluded from production queries and refused by');
console.log('checkout in production. Images are supplier blanks — see docs/PRODUCT_IMAGE_SOURCES.md.');
await close();
