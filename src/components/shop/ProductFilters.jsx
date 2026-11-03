'use client';
import { useState } from 'react';
import { money } from '../../api.js';
import { useStore, Icon } from '../../components.jsx';
import { Button } from '../ui/Button.jsx';

/**
 * Catalogue filters, built from the facets the API returns for the current
 * category and search.
 *
 * Every option is a value the catalogue actually holds, so a dimension the
 * data does not carry is not rendered at all. That is why Fit and Fabric are
 * absent on a catalogue whose products record neither: offering those filters
 * with invented options would just produce empty result pages.
 *
 * Selections live in the URL, so a filtered view can be linked, reloaded and
 * navigated back to.
 */
export function ProductFilters({ facets, params, onChange, total }) {
  const { config } = useStore();
  const [openOnMobile, setOpenOnMobile] = useState(false);

  const selected = (key) => (params.get(key) ?? '').split(',').filter(Boolean);

  const toggle = (key, value) => {
    const current = selected(key);
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ [key]: next.join(',') || null, page: null });
  };

  const activeCount = ['size', 'color', 'fit', 'fabric']
    .reduce((count, key) => count + selected(key).length, 0)
    + (params.get('inStock') === 'true' ? 1 : 0)
    + (params.get('minPrice') || params.get('maxPrice') ? 1 : 0);

  const groups = [
    ['size', 'Size', facets.sizes],
    ['fit', 'Fit', facets.fits],
    ['fabric', 'Fabric', facets.fabrics],
  ].filter(([, , options]) => options?.length);

  const hasPrice = facets.price?.min !== null && facets.price?.max !== facets.price?.min;
  const nothingToFilter = !groups.length && !facets.colors?.length && !hasPrice;

  if (nothingToFilter) return null;

  return (
    <div className="lg:w-[228px] lg:shrink-0">
      {/* Mobile: one button opens the whole panel, so the controls never push
          the grid down the page on a small screen. */}
      <button
        type="button"
        onClick={() => setOpenOnMobile(!openOnMobile)}
        aria-expanded={openOnMobile}
        className="flex w-full items-center justify-between gap-3 border-y border-rule py-3.5 text-[13px] lg:hidden"
      >
        <span className="font-medium">
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </span>
        <Icon name="arrow" size={15} className={`rotate-90 transition-transform ${openOnMobile ? '-rotate-90' : ''}`} />
      </button>

      <div className={`${openOnMobile ? 'block' : 'hidden'} pt-4 lg:block lg:pt-0`}>
        <div className="mb-4 hidden items-baseline justify-between gap-3 lg:flex">
          <h2 className="m-0 text-sm">Filters</h2>
          {activeCount > 0 && (
            <button
              type="button"
              className="text-[11px] underline underline-offset-4 hover:text-ink"
              onClick={() => onChange({
                size: null, color: null, fit: null, fabric: null,
                minPrice: null, maxPrice: null, inStock: null, page: null,
              })}
            >
              Clear all
            </button>
          )}
        </div>

        {/* Availability is always offered: stock is recorded for every variant. */}
        <Section title="Availability">
          <label className="flex cursor-pointer items-center gap-2.5 py-1.5 text-[13px]">
            <input
              type="checkbox"
              className="size-auto min-h-0 w-auto accent-ink"
              checked={params.get('inStock') === 'true'}
              onChange={(event) => onChange({ inStock: event.target.checked ? 'true' : null, page: null })}
            />
            In stock only
            <span className="ml-auto text-[11px] text-ink-soft">{facets.availability?.inStock ?? 0}</span>
          </label>
        </Section>

        {facets.colors?.length > 0 && (
          <Section title="Colour">
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {facets.colors.map((option) => {
                const on = selected('color').includes(option.value);
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      aria-pressed={on}
                      title={`${option.value} (${option.count})`}
                      onClick={() => toggle('color', option.value)}
                      className={`flex items-center gap-2 rounded-full border py-1 pr-2.5 pl-1 text-[11px] transition-colors ${
                        on ? 'border-ink' : 'border-rule hover:border-[#b4b4ae]'
                      }`}
                    >
                      {/* A recorded hex renders as a swatch; without one the
                          name alone carries the meaning. */}
                      {option.hex && (
                        <span
                          aria-hidden="true"
                          style={{ '--swatch': option.hex }}
                          className="size-4 rounded-full bg-[var(--swatch)] ring-1 ring-black/15"
                        />
                      )}
                      {option.value}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {groups.map(([key, title, options]) => (
          <Section key={key} title={title}>
            <ul className="m-0 list-none p-0">
              {options.map((option) => (
                <li key={option.value}>
                  <label className="flex cursor-pointer items-center gap-2.5 py-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      className="size-auto min-h-0 w-auto accent-ink"
                      checked={selected(key).includes(option.value)}
                      onChange={() => toggle(key, option.value)}
                    />
                    {option.value}
                    <span className="ml-auto text-[11px] text-ink-soft">{option.count}</span>
                  </label>
                </li>
              ))}
            </ul>
          </Section>
        ))}

        {hasPrice && (
          <Section title="Price">
            <p className="m-0 mb-2.5 text-[11px] text-ink-soft">
              {money(facets.price.min, config.currency)} – {money(facets.price.max, config.currency)}
            </p>
            {/* Minor units in the URL, matching the API; the inputs work in
                whole currency units because that is what shoppers type. */}
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const toMinor = (value) => (value === '' ? null : String(Math.round(Number(value) * 100)));
                onChange({
                  minPrice: toMinor(data.get('min')),
                  maxPrice: toMinor(data.get('max')),
                  page: null,
                });
              }}
            >
              <input
                name="min" type="number" min="0" inputMode="numeric" aria-label="Minimum price"
                placeholder={String(Math.floor(facets.price.min / 100))}
                defaultValue={params.get('minPrice') ? Number(params.get('minPrice')) / 100 : ''}
                className="min-h-0 py-2 text-xs"
              />
              <span className="text-ink-soft">–</span>
              <input
                name="max" type="number" min="0" inputMode="numeric" aria-label="Maximum price"
                placeholder={String(Math.ceil(facets.price.max / 100))}
                defaultValue={params.get('maxPrice') ? Number(params.get('maxPrice')) / 100 : ''}
                className="min-h-0 py-2 text-xs"
              />
              <Button variant="outline" type="submit" className="min-h-0 shrink-0 px-3 py-2 text-[11px]">Go</Button>
            </form>
          </Section>
        )}

        <p className="mt-5 mb-0 text-[11px] text-ink-soft lg:hidden">{total} products</p>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="border-t border-rule py-4 first:border-t-0 first:pt-0 lg:py-[18px]">
      <h3 className="mb-2 text-[12px] font-semibold tracking-[0.04em] uppercase text-ink">{title}</h3>
      {children}
    </section>
  );
}
