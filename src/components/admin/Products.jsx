'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, Package, PackageX, SlidersHorizontal, X, AlertTriangle, Eye, EyeOff,
  Copy, Trash2, ExternalLink, Layers, FileText, CircleCheck, CircleSlash,
} from 'lucide-react';
import { api, money } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import { skuFamily } from '../../lib/sku.js';
import {
  Card, PageHeading, Btn, Badge, EmptyState, AdminField, SearchField, Modal,
  ConfirmDelete, Checkbox, RowMenu, TablePagination, INPUT, SELECT, Skeleton,
  usePagedResource,
} from './kit.jsx';

/**
 * The product catalogue.
 *
 * Everything on screen comes from GET /admin/products: the rows, the paging
 * totals and the four summary counts. Nothing is computed from a partial page,
 * which is the trap this screen invites -- with eight rows visible out of
 * fourteen, counting published products in the browser would report eight.
 *
 * The summary counts are catalogue-wide and deliberately ignore the active
 * filters, because the cards are also the filter shortcuts: a "Drafts 2" card
 * that became "Drafts 2 of 2" the moment you clicked it would be telling you
 * nothing. The row count under the table is the filtered one.
 */

/** The exact field list PUT /admin/products/:id accepts -- its schema is strict. */
const PUT_FIELDS = ['name', 'slug', 'description', 'brand', 'category_id', 'audience',
  'price', 'compare_price', 'images', 'published', 'featured',
  'rail_enabled', 'rail_front', 'rail_back', 'rail_tag'];

/** Stock the shop could actually sell: reserved units belong to a live checkout. */
const totals = (variants) => (variants ?? []).reduce(
  (sum, v) => ({ stock: sum.stock + v.stock, reserved: sum.reserved + v.reserved }),
  { stock: 0, reserved: 0 },
);

const STATUS_OPTIONS = [['', 'Any status'], ['published', 'Published only'], ['draft', 'Drafts only']];
const STOCK_OPTIONS = [['', 'Any stock level'], ['in', 'In stock'], ['out', 'Out of stock']];

export function Products({ search, onSearch }) {
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [stock, setStock] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState('');

  const list = usePagedResource('/admin/products', {
    limit: 8,
    params: { q: search, category, status, stock },
  });
  const categories = useResource('/categories');
  const { config, notify } = useStore();

  const summary = list.meta?.summary;
  const activeFilters = [category, status, stock].filter(Boolean).length;
  const rowKey = `${list.page}:${list.limit}:${search}:${category}:${status}:${stock}`;

  // Selection is the set of rows you can see. Carrying ids across a page or a
  // filter change would let a bulk action hit products that are no longer on
  // screen, which is the one thing a bulk action must never do.
  useEffect(() => { setSelected(new Set()); }, [rowKey]);

  const selectedRows = useMemo(
    () => list.rows.filter((product) => selected.has(product.id)),
    [list.rows, selected],
  );
  const allOnPage = list.rows.length > 0 && selectedRows.length === list.rows.length;

  const toggle = (id) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  function clearFilters() {
    setCategory(''); setStatus(''); setStock(''); onSearch('');
  }

  /** Flips `published` through the existing PUT, which takes the whole product. */
  async function setPublished(products, published) {
    setBusy('bulk');
    const failed = [];
    let changed = 0;
    for (const product of products) {
      if (product.published === published) continue;
      try {
        const body = Object.fromEntries(PUT_FIELDS.map((key) => [key, product[key]]));
        await api(`/admin/products/${product.id}`, { method: 'PUT', body: { ...body, published } });
        changed += 1;
      } catch (error) {
        failed.push(`${product.name}: ${error.message}`);
      }
    }
    setBusy('');
    const verb = published ? 'Published' : 'Moved to drafts';
    if (failed.length) notify(`${verb} ${changed}. ${failed.length} failed â€” ${failed[0]}`);
    else if (changed) notify(`${verb} ${changed} product${changed === 1 ? '' : 's'}.`);
    else notify(`Already ${published ? 'published' : 'drafts'}.`);
    setSelected(new Set());
    list.reload();
  }

  async function remove(product) {
    setBusy(product.id);
    try {
      await api(`/admin/products/${product.id}`, { method: 'DELETE' });
      notify(`${product.name} deleted.`);
      setConfirming(null);
      list.reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy('');
    }
  }

  async function copySku(product) {
    const family = skuFamily(product.variants);
    try {
      await navigator.clipboard.writeText(family);
      notify(`Copied ${family}.`);
    } catch {
      notify('Could not reach the clipboard.');
    }
  }

  const canCreate = !categories.loading && categories.data?.length > 0;

  const menuFor = (product) => [
    { key: 'edit', label: 'Edit details', icon: Pencil, onSelect: () => setEditing(product) },
    { key: 'stock', label: 'Edit stock & variants', icon: Layers, onSelect: () => setEditing(product) },
    ...(product.published
      // Only offered for a published product: the storefront does not serve a
      // draft, so the link would open a 404 and look like a broken page.
      ? [{ key: 'view', label: 'View on storefront', icon: ExternalLink, href: `/product/${product.slug}`, external: true }]
      : []),
    {
      key: 'publish',
      label: product.published ? 'Move to drafts' : 'Publish',
      icon: product.published ? EyeOff : Eye,
      onSelect: () => setPublished([product], !product.published),
    },
    ...(skuFamily(product.variants)
      ? [{ key: 'sku', label: 'Copy SKU', icon: Copy, onSelect: () => copySku(product) }]
      : []),
    { key: 'sep', separator: true },
    { key: 'delete', label: 'Delete product', icon: Trash2, tone: 'danger', onSelect: () => setConfirming(product) },
  ];

  return (
    <>
      <PageHeading
        title="Products"
        subtitle="Manage your product catalogue, stock and visibility."
        action={
          <>
            <SearchField
              value={search}
              onSubmit={onSearch}
              placeholder="Search by name, SKU or brandâ€¦"
              label="Search products by name, SKU or brand"
              className="w-full sm:w-[300px]"
            />
            <Btn
              icon={SlidersHorizontal}
              aria-expanded={showFilters}
              onClick={() => setShowFilters((open) => !open)}
              className={showFilters ? 'border-admin-text' : ''}
            >
              Filters
              {activeFilters > 0 && (
                <span className="grid min-w-[18px] place-items-center rounded-full bg-admin-text px-1 text-[11px] font-bold text-white">
                  {activeFilters}
                </span>
              )}
            </Btn>
            <Btn variant="primary" icon={Plus} disabled={!canCreate} onClick={() => setEditing({})}>
              {categories.loading ? 'Loadingâ€¦' : 'Add product'}
            </Btn>
          </>
        }
      />

      {!categories.loading && !categories.data?.length && (
        <Card className="mb-4 flex items-start gap-3 border-[#fed7aa] bg-[#fffbeb] p-4">
          <AlertTriangle size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-admin-warning" />
          <p className="m-0 text-[14px] leading-relaxed text-[#92400e]">
            No categories exist yet. Create one under Categories first â€” every product must be filed
            under a category.
          </p>
        </Card>
      )}

      <SummaryCards
        summary={summary}
        loading={list.loading}
        active={{ status, stock }}
        onPick={(next) => {
          setStatus(next.status ?? '');
          setStock(next.stock ?? '');
        }}
      />

      {showFilters && (
        <Card className="mb-4 p-4">
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
            <AdminField label="Category" className="mb-0">
              <select value={category} onChange={(event) => setCategory(event.target.value)} className={SELECT}>
                <option value="">All categories</option>
                {(categories.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </AdminField>
            <AdminField label="Status" className="mb-0">
              <select value={status} onChange={(event) => setStatus(event.target.value)} className={SELECT}>
                {STATUS_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </AdminField>
            <AdminField label="Stock availability" className="mb-0">
              <select value={stock} onChange={(event) => setStock(event.target.value)} className={SELECT}>
                {STOCK_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </AdminField>
          </div>
          {(activeFilters > 0 || search) && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-admin-border pt-4">
              <span className="text-[13px] text-admin-text-2">
                {list.total} {list.total === 1 ? 'product matches' : 'products match'}
              </span>
              <Btn size="sm" variant="ghost" icon={X} onClick={clearFilters}>Clear filters</Btn>
            </div>
          )}
        </Card>
      )}

      {selectedRows.length > 0 && (
        <Card className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-admin-text/15 bg-[#f6f8fc] p-3.5">
          <span className="text-[14px] font-semibold text-admin-text">
            {selectedRows.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Btn size="sm" icon={Eye} busy={busy === 'bulk'} disabled={busy === 'bulk'} onClick={() => setPublished(selectedRows, true)}>
              Publish
            </Btn>
            <Btn size="sm" icon={EyeOff} busy={busy === 'bulk'} disabled={busy === 'bulk'} onClick={() => setPublished(selectedRows, false)}>
              Move to drafts
            </Btn>
            <Btn size="sm" variant="ghost" icon={X} onClick={() => setSelected(new Set())}>Clear selection</Btn>
          </div>
          {/* No bulk delete: the server checks each product for order history
              and refuses the ones that have any, so a bulk run would half
              succeed with no sensible way to report which half. */}
          <span className="ml-auto text-[12px] text-admin-text-2">
            Delete is one at a time â€” each product is checked for order history first.
          </span>
        </Card>
      )}

      <Card className="overflow-hidden">
        {list.error ? (
          <div className="p-5">
            <p className="m-0 mb-3 text-[14px] text-admin-danger">{list.error}</p>
            <Btn onClick={list.reload}>Try again</Btn>
          </div>
        ) : list.loading ? (
          <ProductsSkeleton rows={Math.min(list.limit, 8)} />
        ) : !list.rows.length ? (
          <EmptyState
            icon={Package}
            title={search || activeFilters ? 'No products match' : 'No products yet'}
            text={search || activeFilters
              ? 'Try a different search term, or clear the filters to see the whole catalogue.'
              : 'Add your first product to start selling.'}
            action={search || activeFilters
              ? <Btn icon={X} onClick={clearFilters}>Clear filters</Btn>
              : <Btn variant="primary" icon={Plus} disabled={!canCreate} onClick={() => setEditing({})}>Add product</Btn>}
          />
        ) : (
          <>
            {/* Desktop: the table from the reference. The horizontal scroll is
                on this box, not the page, so a narrow window never scrolls the
                whole admin sideways. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[920px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-admin-border">
                    <th className="w-10 py-3 pr-0 pl-4">
                      <Checkbox
                        checked={allOnPage}
                        indeterminate={selectedRows.length > 0}
                        onChange={() => setSelected(allOnPage ? new Set() : new Set(list.rows.map((p) => p.id)))}
                        label="Select all products on this page"
                      />
                    </th>
                    {['Product', 'Category', 'Price', 'Stock / reserved', 'Status', 'Actions'].map((label) => (
                      <th
                        key={label}
                        className={`px-4 py-3 text-[12px] font-semibold tracking-[0.06em] whitespace-nowrap text-admin-muted uppercase ${label === 'Actions' ? 'text-right' : ''}`}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((product) => {
                    const { stock: units, reserved } = totals(product.variants);
                    const family = skuFamily(product.variants);
                    const picked = selected.has(product.id);
                    return (
                      <tr
                        key={product.id}
                        className={`border-b border-admin-border transition-colors last:border-b-0 ${picked ? 'bg-[#f6f8fc]' : 'hover:bg-admin-bg'}`}
                      >
                        <td className="py-3.5 pr-0 pl-4">
                          <Checkbox checked={picked} onChange={() => toggle(product.id)} label={`Select ${product.name}`} />
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <Thumbnail src={product.images?.[0]} alt={product.name} />
                            <span className="min-w-0">
                              <span className="block truncate text-[14px] font-semibold text-admin-text">{product.name}</span>
                              <span className="mt-0.5 block truncate text-[12px] text-admin-text-2" title={family ? (product.variants ?? []).map((v) => v.sku).join(', ') : undefined}>
                                {family ? `SKU: ${family}` : 'No SKU yet'}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-[14px] font-medium text-admin-text">
                          {product.category || <span className="text-admin-muted">Uncategorised</span>}
                        </td>
                        <td className="px-4 py-3.5 text-[14px] font-medium whitespace-nowrap text-admin-text">
                          {money(product.price, config.currency)}
                          {product.compare_price > product.price && (
                            <span className="mt-0.5 block text-[12px] font-normal text-admin-muted line-through">
                              {money(product.compare_price, config.currency)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <StockCell units={units} reserved={reserved} variants={product.variants} />
                        </td>
                        <td className="px-4 py-3.5">
                          <Badge tone={product.published ? 'success' : 'neutral'}>
                            {product.published ? 'Published' : 'Draft'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center justify-end gap-2">
                            <Btn size="sm" icon={Pencil} onClick={() => setEditing(product)}>Edit</Btn>
                            <button
                              type="button"
                              onClick={() => setConfirming(product)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-semibold text-admin-danger transition-colors hover:bg-[#fef2f2]"
                            >
                              <Trash2 size={14} strokeWidth={2} />
                              Delete
                            </button>
                            <RowMenu items={menuFor(product)} label={`More actions for ${product.name}`} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: the same rows as cards. A 920px table on a phone is
                either unreadable or scrolls the page sideways. */}
            <ul className="m-0 grid list-none gap-0 p-0 md:hidden">
              {list.rows.map((product) => {
                const { stock: units, reserved } = totals(product.variants);
                const family = skuFamily(product.variants);
                return (
                  <li key={product.id} className="border-b border-admin-border p-4 last:border-b-0">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.has(product.id)}
                        onChange={() => toggle(product.id)}
                        label={`Select ${product.name}`}
                        className="mt-1"
                      />
                      <Thumbnail src={product.images?.[0]} alt={product.name} />
                      <div className="min-w-0 flex-1">
                        <p className="m-0 text-[14px] font-semibold text-admin-text">{product.name}</p>
                        <p className="m-0 mt-0.5 truncate text-[12px] text-admin-text-2">
                          {family ? `SKU: ${family}` : 'No SKU yet'}
                        </p>
                        <p className="m-0 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                          <span className="font-semibold text-admin-text">{money(product.price, config.currency)}</span>
                          <span className="text-admin-text-2">{product.category || 'Uncategorised'}</span>
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge tone={product.published ? 'success' : 'neutral'}>
                            {product.published ? 'Published' : 'Draft'}
                          </Badge>
                          <StockCell units={units} reserved={reserved} variants={product.variants} inline />
                        </div>
                      </div>
                      <RowMenu items={menuFor(product)} label={`More actions for ${product.name}`} />
                    </div>
                    <div className="mt-3 flex items-center gap-2 pl-7">
                      <Btn size="sm" icon={Pencil} onClick={() => setEditing(product)}>Edit</Btn>
                      <button
                        type="button"
                        onClick={() => setConfirming(product)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-semibold text-admin-danger hover:bg-[#fef2f2]"
                      >
                        <Trash2 size={14} strokeWidth={2} />
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {!list.loading && !list.error && (
          <TablePagination
            page={list.page}
            pages={list.pages}
            total={list.total}
            limit={list.limit}
            onPage={list.setPage}
            onLimit={list.setLimit}
            unit={list.total === 1 ? 'product' : 'products'}
          />
        )}
      </Card>

      {editing && (
        <ProductEditor
          product={editing}
          categories={categories.data || []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); }}
        />
      )}

      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title="Delete product"
          subtitle={confirming.name}
          width="max-w-[480px]"
          footer={
            <>
              <Btn onClick={() => setConfirming(null)}>Cancel</Btn>
              <Btn variant="danger" icon={Trash2} busy={busy === confirming.id} disabled={busy === confirming.id} onClick={() => remove(confirming)}>
                Delete product
              </Btn>
            </>
          }
        >
          <p className="m-0 text-[14px] leading-relaxed text-admin-text">
            <strong>{confirming.name}</strong> and its {(confirming.variants ?? []).length} variant
            {(confirming.variants ?? []).length === 1 ? '' : 's'} will be removed permanently.
          </p>
          <p className="m-0 mt-3 text-[13px] leading-relaxed text-admin-text-2">
            The server refuses this if the product appears on any order, so order history and
            invoices stay truthful. To retire a product that has sold, move it to drafts instead.
          </p>
        </Modal>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- fragments */

/**
 * A product thumbnail, or a placeholder when there is no image.
 *
 * The editor only requires an image at save time, so a row inserted directly
 * or by a seed can carry an empty array -- rendering `src={undefined}` would
 * ask the browser for the current page as an image and draw a broken icon.
 */
function Thumbnail({ src, alt }) {
  if (!src) {
    return (
      <span className="grid size-12 shrink-0 place-items-center rounded-[8px] border border-admin-border bg-[#f3f4f6] text-admin-muted" title="No image uploaded">
        <FileText size={17} strokeWidth={1.8} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="size-12 shrink-0 rounded-[8px] border border-admin-border bg-[#f3f4f6] object-contain"
    />
  );
}

/** Available / reserved, plus why a row cannot be bought when that is the case. */
function StockCell({ units, reserved, variants, inline = false }) {
  const sizes = (variants ?? []).length;
  const sellable = units - reserved;
  if (!sizes) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium text-admin-warning ${inline ? '' : ''}`}>
        <AlertTriangle size={14} strokeWidth={2} />
        No variants
      </span>
    );
  }
  return (
    <span className={inline ? 'inline-flex items-center gap-2 text-[13px]' : 'block'}>
      <span className={`text-[14px] font-medium ${sellable <= 0 ? 'text-admin-danger' : 'text-admin-text'}`}>
        {units} / {reserved}
      </span>
      <span className={`text-[12px] text-admin-text-2 ${inline ? '' : 'mt-0.5 block'}`}>
        {sellable <= 0 ? 'Out of stock' : `${sizes} size${sizes === 1 ? '' : 's'}`}
      </span>
    </span>
  );
}

/**
 * The four catalogue counts, which double as filter shortcuts.
 *
 * Values come from the server's summary, never from the visible page. Clicking
 * a card applies the filter it describes; clicking it again clears it.
 */
const CARDS = [
  { key: 'total', label: 'Total products', field: 'total', icon: Package, tint: 'bg-[#dbeafe] text-admin-blue', dot: 'bg-admin-blue', filter: {} },
  { key: 'published', label: 'Published', field: 'published', icon: CircleCheck, tint: 'bg-[#dcfce7] text-admin-accent', dot: 'bg-admin-success', filter: { status: 'published' } },
  { key: 'drafts', label: 'Drafts', field: 'drafts', icon: CircleSlash, tint: 'bg-[#f1f5f9] text-admin-text-2', dot: 'bg-admin-muted', filter: { status: 'draft' } },
  { key: 'out', label: 'Out of stock', field: 'out_of_stock', icon: PackageX, tint: 'bg-[#fee2e2] text-admin-danger', dot: 'bg-admin-danger', filter: { stock: 'out' } },
];

function SummaryCards({ summary, loading, active, onPick }) {
  return (
    <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CARDS.map((card) => {
        const value = summary?.[card.field];
        const isActive = card.key === 'total'
          ? !active.status && !active.stock
          : (card.filter.status && active.status === card.filter.status)
            || (card.filter.stock && active.stock === card.filter.stock);
        const Icon = card.icon;
        return (
          <button
            key={card.key}
            type="button"
            aria-pressed={Boolean(isActive)}
            onClick={() => onPick(isActive && card.key !== 'total' ? {} : card.filter)}
            className={`flex items-center gap-3.5 rounded-[14px] border bg-admin-surface p-[18px] text-left transition-colors ${
              isActive ? 'border-admin-text shadow-[0_0_0_1px_#111827]' : 'border-admin-border hover:border-admin-muted/60'
            }`}
          >
            <span className={`grid size-11 shrink-0 place-items-center rounded-full ${card.tint}`}>
              <Icon size={19} strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className={`size-1.5 shrink-0 rounded-full ${card.dot}`} />
                <span className="truncate text-[12px] font-medium text-admin-text-2">{card.label}</span>
              </span>
              {loading || value == null
                ? <Skeleton className="mt-1.5 h-7 w-14" />
                : (
                  <span className={`mt-0.5 block text-[28px] leading-none font-bold tracking-[-0.02em] ${
                    card.key === 'out' && value > 0 ? 'text-admin-danger' : 'text-admin-text'
                  }`}>
                    {value}
                  </span>
                )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ProductsSkeleton({ rows = 8 }) {
  return (
    <div className="px-4">
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex items-center gap-4 border-b border-admin-border py-3.5 last:border-b-0">
          <Skeleton className="size-4 rounded-[4px]" />
          <Skeleton className="size-12 shrink-0 rounded-[8px]" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-[45%]" />
            <Skeleton className="mt-2 h-3 w-[28%]" />
          </div>
          <Skeleton className="hidden h-3.5 w-28 sm:block" />
          <Skeleton className="hidden h-3.5 w-20 sm:block" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

/**
 * Create and edit a product, its images and its variants.
 *
 * Carried over unchanged from the previous screen apart from where it is
 * imported from: this is the working create/edit/upload/variant/stock path
 * against the existing API contracts, and the redesign had no business
 * rewriting it. `price` and `compare_price` stay in minor units because that
 * is what POST and PUT /admin/products accept.
 */
export function ProductEditor({ product, categories, onClose, onSaved }) {
  const { notify } = useStore();
  const [p, setP] = useState({
    name: '', slug: '', description: '', brand: '', category_id: categories[0]?.id || '',
    audience: 'Unisex', price: 0, compare_price: null, images: [], published: false, featured: false,
    rail_enabled: false, rail_front: null, rail_back: null, rail_tag: '',
    ...product,
  });
  const [busy, setBusy] = useState(false);
  const [variant, setVariant] = useState({ sku: '', size: '', color: '', stock: 0 });
  const [variantBusy, setVariantBusy] = useState('');

  const change = (key, value) => setP({ ...p, [key]: value });
  const resetVariant = () => setVariant({ sku: '', size: '', color: '', stock: 0 });

  /** Re-reads just this product, rather than the whole (paginated) catalogue. */
  async function refreshVariants() {
    const fresh = await api(`/admin/products/${product.id}`);
    setP((old) => ({ ...old, variants: fresh.variants }));
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries(PUT_FIELDS.map((k) => [k, p[k]]));
      await api(`/admin/products${product.id ? `/${product.id}` : ''}`, { method: product.id ? 'PUT' : 'POST', body });
      notify(product.id ? 'Product updated.' : 'Product created. Add variants and inventory using Edit.');
      onSaved();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeVariant(v) {
    setVariantBusy(v.id);
    try {
      await api(`/admin/products/${product.id}/variants/${v.id}`, { method: 'DELETE' });
      notify(`${v.size} / ${v.color} removed.`);
      if (variant.id === v.id) resetVariant();
      await refreshVariants();
    } catch (error) {
      notify(error.message);
    } finally {
      setVariantBusy('');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={product.id ? 'Edit product' : 'New product'}
      subtitle={product.id ? p.slug : 'Create a product, then add variants and stock'}
      width="max-w-[760px]"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" busy={busy} disabled={busy || !p.images.length} onClick={save}>Save product</Btn>
        </>
      }
    >
      <form id="product-form" onSubmit={save}>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <AdminField label="Product name" value={p.name} onChange={(e) => change('name', e.target.value)} required />
          <AdminField label="URL slug" value={p.slug} onChange={(e) => change('slug', e.target.value)} pattern="[a-z0-9-]+" required />
          <AdminField label="Brand" value={p.brand} onChange={(e) => change('brand', e.target.value)} required />
          <AdminField label="Category">
            <select value={p.category_id} onChange={(e) => change('category_id', e.target.value)} className={SELECT} required>
              {categories.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}
            </select>
          </AdminField>
          <AdminField label="Audience">
            <select value={p.audience} onChange={(e) => change('audience', e.target.value)} className={SELECT}>
              {['Women', 'Men', 'Kids', 'Unisex'].map((v) => <option key={v}>{v}</option>)}
            </select>
          </AdminField>
          <AdminField label="Price" hint="Minor units â€” 100 = 1.00" type="number" min="1" value={p.price} onChange={(e) => change('price', Number(e.target.value))} required />
          <AdminField label="Original price" hint="Optional. Shows as a strike-through." type="number" min={p.price} value={p.compare_price ?? ''} onChange={(e) => change('compare_price', e.target.value ? Number(e.target.value) : null)} />
        </div>

        <AdminField label="Description">
          <textarea value={p.description} onChange={(e) => change('description', e.target.value)} minLength="10" className={`${INPUT} h-auto min-h-[110px] py-2.5`} required />
        </AdminField>

        {p.images.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-3">
            {p.images.map((src, i) => (
              <div key={src} className="text-center">
                <img src={src} alt={`Product image ${i + 1}`} className="size-20 rounded-[9px] border border-admin-border bg-admin-bg object-contain" />
                <button type="button" className="mt-1 text-[12px] font-semibold text-admin-danger hover:underline" onClick={() => change('images', p.images.filter((x) => x !== src))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <AdminField label="Upload image" hint="JPEG, PNG or WebP up to 5 MB. Converted to WebP on upload.">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={`${INPUT} py-2`}
            onChange={async (event) => {
              const file = event.target.files[0];
              if (!file) return;
              const form = new FormData();
              form.append('image', file);
              setBusy(true);
              try {
                const r = await api('/admin/images', { method: 'POST', body: form });
                change('images', [...p.images, r.url]);
              } catch (error) {
                notify(error.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </AdminField>

        <div className="mb-2 flex flex-wrap gap-5">
          {[['published', 'Published'], ['featured', 'Featured']].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={p[key]} onChange={(e) => change(key, e.target.checked)} className="size-4 accent-admin-text" />
              {label}
            </label>
          ))}
        </div>
        {!p.images.length && <p className="m-0 text-[13px] text-admin-warning">Upload at least one image to save.</p>}

        {/* ------------------------------------------------- homepage rail */}
        <div className="mt-6 border-t border-admin-border pt-5">
          <h3 className="m-0 mb-1 text-[15px] font-semibold">Homepage rail</h3>
          <p className="m-0 mb-4 text-[13px] leading-relaxed text-admin-text-2">
            The hanging garments on the homepage. These images are separate from the catalogue
            photos above because the rail needs a cut-out on a transparent background â€” every
            piece hangs from the same shoulder line, so a normal product photo sits at the wrong
            height and scale. Front is required; back is optional and the rail reuses the front
            when it is missing.
          </p>

          <label className="mb-4 flex items-center gap-2 text-[14px]">
            <input
              type="checkbox"
              checked={Boolean(p.rail_enabled)}
              onChange={(e) => change('rail_enabled', e.target.checked)}
              className="size-4 accent-admin-text"
            />
            Show this product on the homepage rail
          </label>

          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[['rail_front', 'Front', true], ['rail_back', 'Back', false]].map(([key, label, required]) => (
              <div key={key}>
                <span className="mb-1.5 block text-[13px] font-medium text-admin-text">
                  {label} {required ? '' : <span className="font-normal text-admin-text-2">(optional)</span>}
                </span>
                {p[key] ? (
                  <div className="flex items-start gap-3">
                    <img
                      src={p[key]}
                      alt={`${label} rail image`}
                      className="size-24 rounded-[9px] border border-admin-border bg-[#f2eee6] object-contain"
                    />
                    <button
                      type="button"
                      className="text-[12px] font-semibold text-admin-danger hover:underline"
                      onClick={() => change(key, null)}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className={`${INPUT} py-2`}
                    onChange={async (event) => {
                      const file = event.target.files[0];
                      if (!file) return;
                      const form = new FormData();
                      form.append('image', file);
                      setBusy(true);
                      try {
                        const r = await api('/admin/images', { method: 'POST', body: form });
                        change(key, r.url);
                      } catch (error) {
                        notify(error.message);
                      } finally {
                        setBusy(false);
                        event.target.value = '';
                      }
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          <AdminField
            label="Hang tag"
            hint={`Optional. Blank shows the real price â€” ${money(p.price || 0)} â€” so a tag can never disagree with what checkout charges.`}
            value={p.rail_tag ?? ''}
            maxLength={24}
            placeholder={money(p.price || 0)}
            onChange={(e) => change('rail_tag', e.target.value)}
          />

          {p.rail_enabled && !p.rail_front && (
            <p className="m-0 text-[13px] text-admin-warning">
              Add a front rail image, or the rail will hang an invisible garment.
            </p>
          )}
        </div>
      </form>

      {product.id && (
        <div className="mt-6 border-t border-admin-border pt-5">
          <h3 className="m-0 mb-3 text-[15px] font-semibold">Variants &amp; inventory</h3>
          <div className="grid gap-2">
            {p.variants?.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-admin-border px-3.5 py-2.5 text-[14px]">
                <span>
                  <strong>{v.size} / {v.color}</strong>
                  <span className="ml-2 text-admin-text-2">{v.stock} units Â· {v.reserved} reserved Â· {v.sku}</span>
                </span>
                <span className="flex items-center gap-3">
                  <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => setVariant({ id: v.id, sku: v.sku, size: v.size, color: v.color, stock: v.stock })}>Edit</button>
                  <ConfirmDelete onConfirm={() => removeVariant(v)} busy={variantBusy === v.id} />
                </span>
              </div>
            ))}
            {!p.variants?.length && <p className="m-0 text-[13px] text-admin-text-2">No variants yet. A product needs at least one to be bought.</p>}
          </div>

          <form
            className="mt-5"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await api(`/admin/products/${product.id}/variants`, { method: 'PUT', body: variant });
                notify('Variant and inventory saved.');
                resetVariant();
                await refreshVariants();
              } catch (error) {
                notify(error.message);
              }
            }}
          >
            <h4 className="m-0 mb-2.5 text-[13px] font-semibold text-admin-text-2">{variant.id ? 'Edit variant' : 'Add variant'}</h4>
            <div className="grid grid-cols-2 gap-x-4 lg:grid-cols-4">
              {[['sku', 'SKU'], ['size', 'Size'], ['color', 'Colour'], ['stock', 'Stock']].map(([k, label]) => (
                <AdminField
                  key={k} label={label} type={k === 'stock' ? 'number' : 'text'} min={k === 'stock' ? 0 : undefined}
                  value={variant[k]}
                  onChange={(e) => setVariant({ ...variant, [k]: k === 'stock' ? Number(e.target.value) : e.target.value })}
                  required
                />
              ))}
            </div>
            {/* The server refuses stock below reserved (409), so this is a hint
                rather than the guard -- the guard is in the transaction. */}
            {variant.id && (
              <p className="m-0 mb-4 text-[12px] text-admin-text-2">
                Stock cannot be set below the units already reserved by a checkout in progress.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Btn type="submit">Save variant</Btn>
              {variant.id && <Btn variant="ghost" type="button" onClick={resetVariant}>Add another instead</Btn>}
            </div>
          </form>
        </div>
      )}
    </Modal>
  );
}
