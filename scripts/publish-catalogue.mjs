/*
  Clears the `is_demo` flag on every product, making the catalogue real.

      npm run publish:catalogue           report what would change
      npm run publish:catalogue -- --yes  make the change

  Why the flag exists: scripts/seed.mjs marks every product it creates
  `is_demo: true`, and in production server/catalog.mjs adds `is_demo: false`
  to each public query while commerce.mjs refuses to put a demo product on an
  order. So a seeded catalogue is invisible and unsellable on a live site --
  deliberately, so reference products cannot be sold by accident before
  someone has confirmed the store actually stocks them.

  This is the switch that confirms it. It is separate from the seed, and it
  requires --yes, because it is the step that makes products purchasable by
  real customers and no script should do that as a side effect.

  Re-runnable: the seed sets the flag again on anything it recreates, so this
  can be applied as often as needed. It only clears the flag and touches
  nothing else -- not `published`, not prices, not images. A product left
  unpublished in the admin panel stays unpublished.
*/
import {connect, close, products} from '../server/mongo.mjs';

const confirmed = process.argv.includes('--yes');

await connect();
try {
  const demo = await products()
    .find({is_demo: {$ne: false}}, {projection: {name: 1, slug: 1, published: 1}})
    .sort({display_order: 1, name: 1})
    .toArray();

  if (!demo.length) {
    const total = await products().countDocuments({});
    console.log(`Nothing to do: all ${total} product(s) are already real.`);
  } else {
    console.log(`${demo.length} product(s) are flagged as demo data:`);
    for (const row of demo) {
      console.log(`  ${row.published ? '        ' : 'draft   '}${row.slug}  ${row.name}`);
    }
    console.log('');

    if (!confirmed) {
      // A dry run by default. The alternative -- act now, report afterwards --
      // would mean the only way to find out what this touches is to let it
      // touch it.
      console.log('This was a dry run; nothing was changed.');
      console.log('Re-run with --yes to clear the flag and put these on sale:');
      console.log('  npm run publish:catalogue -- --yes');
    } else {
      const result = await products().updateMany({is_demo: {$ne: false}}, {$set: {is_demo: false}});
      console.log(`Cleared the demo flag on ${result.modifiedCount} product(s). They are now live.`);
      const draft = demo.filter((row) => !row.published).length;
      // Clearing is_demo is necessary but not sufficient: every public query
      // also filters on `published`, so saying "now live" without this caveat
      // would be wrong for any product still in draft.
      if (draft) console.log(`${draft} of them are still unpublished, so tick Published in the admin panel before they appear.`);
    }
  }
} finally {
  await close();
}
