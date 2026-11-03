/**
 * The SKU to show for a product in the admin catalogue.
 *
 * SKUs belong to variants, not products, so a shirt stocked in five sizes has
 * five of them and there is no single "product SKU" to print. The shared
 * prefix is what identifies the garment: for
 * CASUAL-CAMP-COLLAR-SHIRT-01-{S,M,L,XL,XXL} that is
 * CASUAL-CAMP-COLLAR-SHIRT-01.
 *
 * That choice is deliberate rather than cosmetic. GET /admin/products matches
 * the search term against variant SKUs with a LIKE, so the string this returns
 * is also a string that finds the row again -- what is displayed is what is
 * searchable.
 *
 * Trailing separators are trimmed so a prefix never ends mid-token, and a
 * prefix too short to identify anything falls back to the first full SKU
 * rather than printing two characters and calling it a code.
 *
 * Plain JavaScript rather than part of Products.jsx so a test runner can
 * import it -- Node cannot load a .jsx file.
 *
 * @param {Array<{sku?: string}>} variants
 * @returns {string|null} the family, or null when there is no SKU at all
 */
export function skuFamily(variants) {
  const skus = (variants ?? []).map((v) => v?.sku).filter(Boolean);
  if (!skus.length) return null;
  if (skus.length === 1) return skus[0];

  let prefix = skus[0];
  for (const sku of skus.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < sku.length && prefix[i] === sku[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[-_/\s]+$/, '');
  return prefix.length >= 3 ? prefix : skus[0];
}
