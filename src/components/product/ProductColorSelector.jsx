'use client';

/**
 * Colourway swatches. Options come from the product's own colourways, so only
 * colours the catalogue actually lists appear here. A colourway with no stock
 * in any size is disabled rather than hidden, which tells the customer it
 * exists and is unavailable.
 */
export function ProductColorSelector({ colorways, selected, onSelect, inStock, showPhotographyNote }) {
  if (colorways.length <= 1 && !colorways[0]?.hex) return null;

  return (
    <div className="mt-6">
      <div className="mb-2.5 flex items-baseline justify-between gap-3.5">
        <strong className="text-[15px]">Colour</strong>
        <span className="text-[15px] text-ink-soft">{selected}</span>
      </div>

      <ul className="m-0 flex list-none flex-wrap gap-2.5 p-0" role="radiogroup" aria-label="Colour">
        {colorways.map((colorway) => {
          const available = inStock(colorway.name);
          const isSelected = colorway.name === selected;
          return (
            <li key={colorway.name}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={available ? colorway.name : `${colorway.name}, out of stock`}
                title={colorway.name}
                disabled={!available}
                className={`inline-flex items-center gap-2 rounded-full border bg-white p-1 transition-[border-color,transform] ${isSelected ? 'scale-105 border-ink' : 'border-rule hover:border-[#b4b4ae]'} ${available ? '' : 'cursor-not-allowed opacity-40'}`}
                style={colorway.hex ? { '--swatch': colorway.hex } : undefined}
                onClick={() => onSelect(colorway.name)}
              >
                <span className="size-[30px] rounded-full bg-[var(--swatch,var(--color-panel))] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.16)]" aria-hidden="true" />
                {!colorway.hex && <span className="pr-3 text-xs">{colorway.name}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {showPhotographyNote && (
        <p className="mt-3 mb-0 text-[11px] leading-relaxed">
          Photography for the individual colourways has not been supplied, so the images show the
          product as photographed. Colour names come from the catalogue swatches.
        </p>
      )}
    </div>
  );
}
