'use client';

/**
 * Size buttons for the selected colourway.
 *
 * The list is rebuilt whenever the colour changes, because stock is held per
 * size *and* colour. Sizes with no stock are rendered disabled so the range is
 * still visible, which is also why they are not simply filtered out.
 *
 * Laid out as a two-column grid to match the reference. `grid` rather than
 * `flex-wrap` so every cell is the same width regardless of label length,
 * which keeps "UK 6 (EU 40)" and "UK 7" on one tidy row.
 */
export function ProductSizeSelector({ sizes, selected, onSelect, onOpenGuide, error }) {
  if (sizes.length <= 1) return null;

  const describe = (entry) => {
    if (entry.available === 0) return `${entry.size}, out of stock`;
    if (entry.available <= 3) return `${entry.size}, only ${entry.available} left`;
    return entry.size;
  };

  return (
    <div className="mt-6">
      <div className="mb-2.5 flex items-baseline justify-between gap-3.5">
        <strong id="size-label" className="text-[15px]">Select size</strong>
        <button
          type="button"
          className="inline-flex items-center gap-2 text-[15px] text-ink-soft underline underline-offset-4 hover:text-ink"
          onClick={onOpenGuide}
        >
          Size guide
        </button>
      </div>

      <ul
        className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 md:grid-cols-2"
        role="radiogroup"
        aria-labelledby="size-label"
      >
        {sizes.map((entry) => (
          <li key={entry.size}>
            <button
              type="button"
              role="radio"
              aria-checked={entry.size === selected}
              aria-label={describe(entry)}
              disabled={entry.available === 0}
              className={`w-full rounded-[4px] border py-3.5 text-center text-[15px] transition-[border-color,box-shadow] ${
                entry.size === selected
                  ? 'border-ink shadow-[inset_0_0_0_1px_var(--color-ink)]'
                  : 'border-line hover:border-ink'
              } disabled:cursor-not-allowed disabled:border-rule disabled:text-[#c2c2bc] disabled:line-through disabled:hover:border-rule`}
              onClick={() => onSelect(entry.size)}
            >
              {entry.size}
            </button>
          </li>
        ))}
      </ul>

      {/* Announced live so the validation message reaches a screen reader when
          Add to Bag is pressed without a size. */}
      <p className="mt-2.5 mb-0 min-h-[18px] text-xs leading-relaxed" role="status">
        {error
          ? <span className="text-[#a83329]">{error}</span>
          : selected
            ? `${sizes.find((entry) => entry.size === selected)?.available ?? 0} in stock in ${selected}`
            : ''}
      </p>
    </div>
  );
}
