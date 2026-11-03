// The store's category structure.
//
// This is store structure, not demo content, so it is kept apart from
// scripts/seed.mjs (which fills the catalogue with reference products) and is
// safe to run against a real store. `npm run seed` calls it so a development
// database always has a working navigation.
//
// Idempotent: matched on slug, so re-running renames and reorders rather than
// duplicating. Categories already in the database that are not listed here are
// left alone but taken out of the navigation, because they may still own
// products and deleting them would orphan those rows.
import {connect, close, categories, ensureSchema} from '../server/mongo.mjs';
import {id} from '../server/security.mjs';

/**
 * [name, segment, children[]] where `segment` is the URL piece.
 *
 * `slug` is derived as the segment for a top-level category and
 * `<parent>-<segment>` for a child, which keeps it globally unique: both
 * T-Shirts and Shirts have a "Printed" child.
 */
export const taxonomy = [
  ['T-Shirts', 't-shirts', [
    ['Oversized T-Shirts', 'oversized'],
    ['Regular Fit T-Shirts', 'regular-fit'],
    ['Polo T-Shirts', 'polo'],
    ['Graphic T-Shirts', 'graphic'],
    ['Printed T-Shirts', 'printed'],
    ['Half Sleeve T-Shirts', 'half-sleeve'],
    ['Full Sleeve T-Shirts', 'full-sleeve'],
  ]],
  ['Shirts', 'shirts', [
    ['Casual Shirts', 'casual'],
    ['Formal Shirts', 'formal'],
    ['Linen Shirts', 'linen'],
    ['Denim Shirts', 'denim'],
    ['Printed Shirts', 'printed'],
  ]],
  ['Bottom Wear', 'bottom-wear', [
    ['Jeans', 'jeans'],
    ['Trousers', 'trousers'],
    ['Cargo Pants', 'cargo-pants'],
    ['Joggers', 'joggers'],
    ['Shorts', 'shorts'],
  ]],
];

/**
 * One category, matched on slug.
 *
 * `findOneAndUpdate` with an upsert is the SELECT-then-INSERT-or-UPDATE the
 * SQL version did, in one round trip. The id is generated before the call and
 * only applied on insert, so an existing category keeps the id that products
 * already reference.
 */
async function upsert({name, slug, segment, parentId, order, inNav}) {
  const created = id();
  const row = await categories().findOneAndUpdate(
    {slug},
    {
      $set: {name, segment, parent_id: parentId, display_order: order, in_nav: inNav},
      $setOnInsert: {_id: created, id: created},
    },
    {upsert: true, returnDocument: 'after'},
  );
  return row.id ?? row._id;
}

export async function applyTaxonomy() {
  const slugs = [];
  for (const [index, [name, segment, children]] of taxonomy.entries()) {
    const parentId = await upsert({name, slug: segment, segment, parentId: null, order: index, inNav: true});
    slugs.push(segment);
    for (const [childIndex, [childName, childSegment]] of (children ?? []).entries()) {
      const slug = `${segment}-${childSegment}`;
      await upsert({name: childName, slug, segment: childSegment, parentId, order: childIndex, inNav: true});
      slugs.push(slug);
    }
  }

  // Anything else drops out of the navigation but keeps its products. Read
  // first, because an update cannot return the documents it changed.
  const retiring = await categories()
    .find({in_nav: true, slug: {$nin: slugs}}, {projection: {name: 1}}).toArray();
  if (retiring.length) {
    await categories().updateMany({_id: {$in: retiring.map((r) => r._id)}}, {$set: {in_nav: false}});
  }
  return {applied: slugs.length, retired: retiring.map((r) => r.name)};
}

// Only run when invoked directly, so seed.mjs can import applyTaxonomy.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('taxonomy.mjs')) {
  await connect();
  await ensureSchema();
  const {applied, retired} = await applyTaxonomy();
  console.log(`${applied} categories applied.`);
  if (retired.length) console.log(`Taken out of the navigation (products kept): ${retired.join(', ')}`);
  await close();
}
