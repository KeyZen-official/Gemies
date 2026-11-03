'use client';

/**
 * Specification table.
 *
 * Only attributes the catalogue actually holds are listed. Material, closure
 * type, sole and country of origin are not columns on the product table, so
 * they are absent rather than filled with plausible-looking values; the note
 * records what the store still has to supply.
 */
export function ProductSpecifications({ product, color, sizes }) {
  const rows = [
    ['Brand', product.brand],
    ['Product', product.name],
    ['Type', product.category],
    ['Collection', product.audience && `${product.audience}${product.audience === 'Unisex' ? '' : '’s'}`],
    ['Colourway', color],
    ['Sizes offered', sizes.length ? sizes.map((entry) => entry.size).join(', ') : null],
    ['Reference', product.slug?.toUpperCase()],
  ].filter(([, value]) => value);

  return (
    <div className="max-w-[760px]">
      <table className="w-full border-collapse text-[13px]">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="block border-b border-rule py-[11px] md:table-row md:border-0 md:py-0">
              <th scope="row" className="block w-auto py-1.5 text-left align-top text-[11px] font-medium text-ink-soft md:table-cell md:w-[220px] md:border-b md:border-rule md:py-[13px] md:text-[13px]">{label}</th>
              <td className="block py-1.5 text-left align-top md:table-cell md:border-b md:border-rule md:py-[13px]">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3.5 text-[11px] leading-relaxed">
        Material, closure, sole and country of origin are not recorded against products in the
        catalogue yet, so they are not listed. Add those fields to show them here.
      </p>
    </div>
  );
}
