// Puts the eight garments that were hardcoded on the homepage rail onto it
// properly, as product fields an operator can now change.
//
//   node --env-file-if-exists=.env scripts/rail-backfill.mjs
//
// Until this runs, GET /api/rail returns nothing and HomeRail falls back to the
// generated src/data/rail-items.js. After it runs, the rail is live data: edit
// a rail image or a hang tag in the admin panel and the homepage follows.
//
// Idempotent, and it will not overwrite a rail image an operator has already
// set -- only products with no rail_front are touched. Safe to re-run.
//
// `rail_back` is deliberately left null. The store has one photograph per
// garment, so there is no honest back view yet; the rail component reuses the
// front face until a real back cut-out is uploaded.
import {connect, close, products} from '../server/mongo.mjs';
import {railItems} from '../src/data/rail-items.js';

await connect();

let updated = 0;
let alreadySet = 0;
const missing = [];

for (const item of railItems) {
  // `id` on a rail item is the product slug.
  const product = await products().findOne({slug: item.id}, {projection: {rail_front: 1, name: 1}});
  if (!product) { missing.push(item.id); continue; }
  if (product.rail_front) { alreadySet += 1; continue; }

  await products().updateOne({_id: product._id}, {$set: {
    rail_enabled: true,
    rail_front: item.image,
    rail_back: null,
    // Blank, so the tag shows the product's live price rather than freezing
    // the price this item was generated with.
    rail_tag: '',
  }});
  updated += 1;
}

const onRail = await products().countDocuments({rail_enabled: true});
console.log(`${updated} product(s) put on the homepage rail.`);
if (alreadySet) console.log(`${alreadySet} already had a rail image and were left alone.`);
if (missing.length) {
  console.log(`${missing.length} rail item(s) have no matching product and were skipped:`);
  for (const slug of missing) console.log(`  ${slug}`);
}
console.log(`${onRail} product(s) are now on the rail.`);
console.log('\nHang tags show each product\'s live price. Set a Hang tag in the admin product');
console.log('editor to override one, and upload a back cut-out there to make the reverse real.');

await close();
