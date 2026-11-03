'use client';
import { useState } from 'react';
import Link from 'next/link';
import {
  useStore, useResource, useQueryParams, Loading, ErrorState, Empty, Icon,
} from '../../components.jsx';
import { Button } from '../ui/Button.jsx';
import { Pagination } from '../ui/Pagination.jsx';
import { ProductGrid } from '../ProductGrid.jsx';
import { ProductFilters } from './ProductFilters.jsx';

/**
 * The product listing behind /shop and every category page.
 *
 * One component for both, because a category page is the same listing with a
 * category applied. `path` is the /shop URL segments, so /shop/t-shirts/printed
 * arrives as ['t-shirts','printed']; /shop itself passes none.
 *
 * The category is resolved by the API rather than mapped in the client, so the
 * page heading, the subcategory links and the filter scope all come from the
 * same rows the navigation is built from.
 */
export function CategoryBrowser({ path = [] }) {
  const [params, setParams] = useQueryParams();
  const [search, setSearch] = useState(params.get('q') ?? '');

  const categoryPath = path.join('/');
  const category = useResource(categoryPath ? `/categories/resolve?path=${encodeURIComponent(categoryPath)}` : '');

  // The listing query. A category page filters by its own slug; /shop honours
  // ?category= so existing links keep working.
  const query = new URLSearchParams();
  for (const key of ['q', 'size', 'color', 'fit', 'fabric', 'minPrice', 'maxPrice', 'inStock', 'sort', 'page']) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const slug = category.data?.slug ?? params.get('category') ?? '';
  if (slug) query.set('category', slug);
  query.set('limit', '24');

  // Wait for the category before listing, or the first request would fetch the
  // whole catalogue and then immediately refetch the narrowed one.
  const waiting = Boolean(categoryPath) && category.loading;
  const listing = useResource(waiting ? '' : `/products?${query}`);

  const update = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  };

  if (categoryPath && category.error) {
    return (
      <Empty
        title="That category does not exist"
        text="It may have been renamed or removed. Browse the full collection instead."
      />
    );
  }

  const current = category.data;
  const products = listing.data?.products ?? [];
  const facets = listing.data?.facets;
  const total = listing.data?.total ?? 0;

  return (
    <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-5 pb-11 md:w-[calc(100%-32px)] md:pt-6 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-8 lg:pb-20">
      <nav className="mb-5 flex flex-wrap items-center gap-2 text-[10px] text-ink-soft md:gap-3 md:text-[11px] [&_a:hover]:text-ink" aria-label="Breadcrumb">
        <Link href="/">Home</Link>
        <span aria-hidden="true">/</span>
        {current ? <Link href="/shop">Shop</Link> : <span aria-current="page">Shop</span>}
        {current?.parent && (
          <>
            <span aria-hidden="true">/</span>
            <Link href={`/shop/${current.parent.segment}`}>{current.parent.name}</Link>
          </>
        )}
        {current && (
          <>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{current.name}</span>
          </>
        )}
      </nav>

      <div className="mb-6 md:mb-8">
        <h1 className="my-2.5 text-[31px] md:mb-3.5 md:text-[35px] lg:text-[42px]">
          {current?.name ?? (params.get('q') ? `Results for “${params.get('q')}”` : 'All clothing')}
        </h1>
        <p className="m-0 text-xs md:text-sm">
          {current
            ? `Browse every ${current.name.toLowerCase()} in the collection.`
            : 'T-shirts, shirts and bottom wear, built for everyday wear.'}
        </p>
      </div>

      {/* Subcategory shortcuts, from the same rows as the mega menu. */}
      {current?.children?.length > 0 && (
        <ul className="m-0 mb-6 flex list-none flex-wrap gap-2 p-0 md:mb-8 md:gap-2.5">
          {current.children.map((child) => (
            <li key={child.slug}>
              <Link
                href={`/shop/${current.segment}/${child.segment}`}
                className="inline-block rounded-[25px] border border-line px-[13px] py-[9px] text-[10px] transition-colors hover:border-ink md:px-[19px] md:py-[11px] md:text-xs"
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col items-stretch gap-3 border-y border-rule py-3 md:flex-row md:items-center md:justify-between md:gap-6 md:py-4">
        <form
          className="flex max-w-none flex-1 items-center gap-2.5 md:max-w-[430px] md:gap-3"
          onSubmit={(event) => { event.preventDefault(); update({ q: search, page: null }); }}
        >
          <Icon name="search" />
          <input
            aria-label="Search the collection"
            placeholder="Search T-shirts, shirts, bottom wear…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-h-0 py-2.5"
          />
          <Button variant="outline" type="submit" className="min-h-0 shrink-0 px-4 py-2.5 text-[11px]">Search</Button>
        </form>

        <label className="flex items-center gap-2 text-[11px] whitespace-nowrap md:text-xs">
          Sort by
          <select
            value={params.get('sort') ?? 'newest'}
            onChange={(event) => update({ sort: event.target.value === 'newest' ? null : event.target.value, page: null })}
            className="min-h-0 w-auto py-2 text-[11px] md:text-xs"
          >
            <option value="newest">Featured</option>
            <option value="price-low">Price: low to high</option>
            <option value="price-high">Price: high to low</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <div className="mt-5 flex flex-col gap-6 lg:flex-row lg:gap-10">
        {facets && (
          <ProductFilters facets={facets} params={params} onChange={update} total={total} />
        )}

        <div className="min-w-0 flex-1">
          <p className="mt-0 mb-4 hidden text-[11px] text-ink-soft lg:block">{total} products</p>

          {listing.loading || waiting ? (
            <Loading />
          ) : listing.error ? (
            <ErrorState message={listing.error} onRetry={listing.reload} />
          ) : products.length ? (
            <>
              {/* Dimmed while the next page or a changed filter is in flight.
                  The rows stay put rather than being replaced by a spinner, so
                  changing page does not collapse the layout and bounce the
                  scroll position. */}
              <div className={listing.refreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                <ProductGrid products={products} priorityCount={4} />
              </div>
              <Pagination
                page={listing.data.page}
                pages={listing.data.pages}
                total={total}
                unit="products"
                onPage={(next) => {
                  update({ page: next === 1 ? null : String(next) });
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            </>
          ) : (
            <EmptyCategory current={current} filtered={hasActiveFilters(params)} onClear={() => update({
              size: null, color: null, fit: null, fabric: null,
              minPrice: null, maxPrice: null, inStock: null, q: null, page: null,
            })} />
          )}
        </div>
      </div>
    </main>
  );
}

function hasActiveFilters(params) {
  return ['size', 'color', 'fit', 'fabric', 'minPrice', 'maxPrice', 'inStock', 'q']
    .some((key) => params.get(key));
}

/**
 * Distinguishes "your filters match nothing" from "this category has no
 * products yet", because the second is not something the shopper can fix.
 */
function EmptyCategory({ current, filtered, onClear }) {
  if (filtered) {
    return (
      <div className="px-[22px] py-16 text-center md:py-[85px]">
        <h2 className="text-[22px] md:text-2xl">Nothing matches those filters</h2>
        <p className="mb-7 text-xs md:text-sm">Try removing one to widen the results.</p>
        <Button variant="outline" onClick={onClear}>Clear filters</Button>
      </div>
    );
  }
  return (
    <Empty
      title={current ? `No ${current.name.toLowerCase()} yet` : 'Nothing here yet'}
      text={
        current
          ? 'This category has been set up but has no products in it so far. Check back soon.'
          : 'Products will appear here once the catalogue is stocked.'
      }
      link="/"
      label="Back to home"
    />
  );
}
