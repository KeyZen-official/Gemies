'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Folder, FolderOpen, FolderTree, Network, Layers, Eye, EyeOff, Plus, Pencil,
  ChevronRight, ChevronDown, SlidersHorizontal, X, AlertTriangle, Trash2,
  ExternalLink, Copy, CornerDownRight, ChevronsDownUp, ChevronsUpDown,
} from 'lucide-react';
import { api } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import { slugify, suggestSegment, suggestSlug, categoryHref } from '../../lib/category-path.js';
import {
  Card, PageHeading, Btn, Badge, AdminField, SearchField, Modal, EmptyState,
  Skeleton, Toggle, RowMenu, TablePagination, SELECT, usePagedResource,
} from './kit.jsx';

/**
 * Category management, including the taxonomy the storefront routes on.
 *
 * Every row, count and path comes from GET /admin/categories, which returns
 * the tree already grouped with product counts attached. Nothing here is
 * derived from a partial page.
 *
 * Two things about this screen are load-bearing rather than cosmetic:
 *
 *  - `segment` is what resolveCategory() matches on, so every write sends the
 *    category's real segment back. PUT /admin/categories/:id stores
 *    `v.segment || v.slug`, which means posting a blank segment would silently
 *    move /shop/shirts/casual to /shop/shirts/shirts-casual. A visibility
 *    toggle must not change a live URL.
 *
 *  - `in_nav` is what categoryTree() filters on, so the toggle below is the
 *    difference between a category being in the mega menu or not. It waits for
 *    the server rather than moving optimistically.
 */

const BLANK = { name: '', slug: '', segment: '', parent_id: '', in_nav: true, display_order: 0 };

const SCOPES = [['', 'All levels'], ['top', 'Top-level only'], ['child', 'Subcategories only']];
const NAV_FILTERS = [['', 'Any visibility'], ['visible', 'Visible in navigation'], ['hidden', 'Hidden from navigation']];

/**
 * The full PUT body for a category, with only the named fields changed.
 *
 * categoryBody is `.strict()` and every field is required, so a partial update
 * is not possible through this API -- a toggle has to resend the whole row.
 * `segment` is passed through explicitly for the reason in the note above.
 */
const bodyFor = (category, changes) => ({
  name: category.name,
  slug: category.slug,
  segment: category.segment ?? '',
  parent_id: category.parent_id ?? null,
  in_nav: category.in_nav,
  display_order: category.display_order,
  ...changes,
});

export function CategoryManager({ search = '', onSearch = () => {} }) {
  const [scope, setScope] = useState('');
  const [nav, setNav] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busyId, setBusyId] = useState('');

  const list = usePagedResource('/admin/categories', {
    limit: 10,
    params: { q: search, scope, nav },
  });
  // The whole flat taxonomy, for the parent selector and the uniqueness checks
  // in the form. The paged list above only holds one page of groups, so it
  // cannot answer "is this slug already taken".
  const everything = useResource('/categories');
  const { notify } = useStore();

  const summary = list.meta?.summary;
  const activeFilters = [scope, nav].filter(Boolean).length;

  // A collapsed parent would hide a child the search just found, so a new
  // search term opens everything back up.
  useEffect(() => { setCollapsed(new Set()); }, [search, scope, nav, list.page]);

  const toggleGroup = (id) => setCollapsed((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allCollapsed = list.rows.length > 0 && list.rows.every((g) => collapsed.has(g.id) || !g.children.length);

  function clearFilters() {
    setScope(''); setNav(''); onSearch('');
  }

  /** in_nav, through the existing PUT. Waits for the server before redrawing. */
  async function setNavFlag(category, next) {
    setBusyId(category.id);
    try {
      await api(`/admin/categories/${category.id}`, { method: 'PUT', body: bodyFor(category, { in_nav: next }) });
      notify(`${category.name} ${next ? 'now appears in' : 'is hidden from'} the navigation.`);
      await list.reload();
      everything.reload();
    } catch (error) {
      // No optimistic state was set, so the switch is already showing the
      // truth; all that is needed is to say why it did not move.
      notify(error.message);
    } finally {
      setBusyId('');
    }
  }

  async function setOrder(category, next) {
    setBusyId(category.id);
    try {
      await api(`/admin/categories/${category.id}`, { method: 'PUT', body: bodyFor(category, { display_order: next }) });
      notify(`${category.name} moved to position ${next}.`);
      await list.reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusyId('');
    }
  }

  async function remove(category) {
    setBusyId(category.id);
    try {
      await api(`/admin/categories/${category.id}`, { method: 'DELETE' });
      notify(`${category.name} deleted.`);
      setConfirming(null);
      await list.reload();
      everything.reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusyId('');
    }
  }

  async function copyPath(category) {
    try {
      await navigator.clipboard.writeText(category.href);
      notify(`Copied ${category.href}.`);
    } catch {
      notify('Could not reach the clipboard.');
    }
  }

  const menuFor = (category) => [
    { key: 'edit', label: 'Edit category', icon: Pencil, onSelect: () => setEditing(category) },
    ...(category.in_nav && category.href
      ? [{ key: 'view', label: 'Open on storefront', icon: ExternalLink, href: category.href, external: true }]
      : []),
    { key: 'copy', label: 'Copy URL path', icon: Copy, onSelect: () => copyPath(category) },
    {
      key: 'nav',
      label: category.in_nav ? 'Hide from navigation' : 'Show in navigation',
      icon: category.in_nav ? EyeOff : Eye,
      onSelect: () => setNavFlag(category, !category.in_nav),
    },
    ...(!category.parent_id
      ? [{ key: 'child', label: 'Add subcategory', icon: CornerDownRight, onSelect: () => setEditing({ ...BLANK, parent_id: category.id }) }]
      : []),
    { key: 'sep', separator: true },
    { key: 'delete', label: 'Delete category', icon: Trash2, tone: 'danger', onSelect: () => setConfirming(category) },
  ];

  const rowProps = { busyId, onNav: setNavFlag, onOrder: setOrder, onEdit: setEditing, onDelete: setConfirming, menuFor };

  return (
    <>
      <PageHeading
        title="Categories"
        subtitle="Manage your store categories and their visibility."
        action={
          <>
            <SearchField
              value={search}
              onSubmit={onSearch}
              placeholder="Search categories…"
              label="Search categories by name, slug or URL segment"
              className="w-full sm:w-[280px]"
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
            <Btn variant="primary" icon={Plus} onClick={() => setEditing({ ...BLANK })}>Add category</Btn>
          </>
        }
      />

      {summary?.missing_segment > 0 && (
        <Card className="mb-4 flex items-start gap-3 border-[#fecaca] bg-[#fef2f2] p-4">
          <AlertTriangle size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-admin-danger" />
          <p className="m-0 text-[14px] leading-relaxed text-[#991b1b]">
            {summary.missing_segment} {summary.missing_segment === 1 ? 'category has' : 'categories have'} no URL
            segment, so {summary.missing_segment === 1 ? 'its' : 'their'} <code>/shop</code> page returns 404.
            Edit {summary.missing_segment === 1 ? 'it' : 'them'} and set a segment.
          </p>
        </Card>
      )}

      <SummaryCards summary={summary} loading={list.loading} active={{ scope, nav }} onPick={(next) => {
        setScope(next.scope ?? '');
        setNav(next.nav ?? '');
      }} />

      {showFilters && (
        <Card className="mb-4 p-4">
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <AdminField label="Level" className="mb-0">
              <select value={scope} onChange={(event) => setScope(event.target.value)} className={SELECT}>
                {SCOPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </AdminField>
            <AdminField label="Navigation visibility" className="mb-0">
              <select value={nav} onChange={(event) => setNav(event.target.value)} className={SELECT}>
                {NAV_FILTERS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </AdminField>
          </div>
          {(activeFilters > 0 || search) && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-admin-border pt-4">
              <span className="text-[13px] text-admin-text-2">
                {list.meta?.matchedRows ?? 0} {list.meta?.matchedRows === 1 ? 'category matches' : 'categories match'}
                {' '}across {list.total} {list.total === 1 ? 'group' : 'groups'}
              </span>
              <Btn size="sm" variant="ghost" icon={X} onClick={clearFilters}>Clear filters</Btn>
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        {list.error ? (
          <div className="p-5">
            <p className="m-0 mb-3 text-[14px] text-admin-danger">{list.error}</p>
            <Btn onClick={list.reload}>Try again</Btn>
          </div>
        ) : list.loading ? (
          <CategoriesSkeleton />
        ) : !list.rows.length ? (
          <EmptyState
            icon={FolderTree}
            title={search || activeFilters ? 'No categories match' : 'No categories yet'}
            text={search || activeFilters
              ? 'Try a different term, or clear the filters to see the whole taxonomy.'
              : 'Every product must be filed under a category. Create the first one to begin.'}
            action={search || activeFilters
              ? <Btn icon={X} onClick={clearFilters}>Clear filters</Btn>
              : <Btn variant="primary" icon={Plus} onClick={() => setEditing({ ...BLANK })}>Add category</Btn>}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-admin-border px-4 py-2.5">
              <p className="m-0 text-[12px] text-admin-text-2">
                Navigation is two levels deep — <code className="rounded-[5px] bg-admin-bg px-1.5 py-0.5">/shop/&lt;parent&gt;/&lt;child&gt;</code>
              </p>
              <Btn
                size="sm"
                variant="ghost"
                icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
                onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(list.rows.map((g) => g.id)))}
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </Btn>
            </div>

            {/* Desktop table. The sideways scroll is on this box, not the page. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[940px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-admin-border">
                    {[
                      ['Category', ''], ['URL segment', ''], ['Products', ''],
                      ['In navigation', ''], ['Display order', ''], ['Actions', 'text-right'],
                    ].map(([label, align]) => (
                      <th key={label} className={`px-4 py-3 text-[12px] font-semibold tracking-[0.06em] whitespace-nowrap text-admin-muted uppercase ${align}`}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((group) => {
                    const open = !collapsed.has(group.id);
                    return (
                      <TopRow
                        key={group.id}
                        group={group}
                        open={open}
                        onToggleOpen={() => toggleGroup(group.id)}
                        {...rowProps}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: the same tree as cards. */}
            <ul className="m-0 grid list-none gap-0 p-0 md:hidden">
              {list.rows.map((group) => {
                const open = !collapsed.has(group.id);
                return (
                  <li key={group.id} className="border-b border-admin-border last:border-b-0">
                    <MobileCard category={group} depth={0} open={open} onToggleOpen={() => toggleGroup(group.id)} {...rowProps} />
                    {open && group.children.map((child) => (
                      <MobileCard key={child.id} category={child} depth={1} {...rowProps} />
                    ))}
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
            options={[5, 10, 20, 50]}
            unit={list.total === 1 ? 'top-level category' : 'top-level categories'}
          />
        )}
      </Card>

      {!list.loading && list.rows.length > 0 && (
        <p className="m-0 mt-3 text-[12px] text-admin-text-2">
          {/* Paging counts groups, so this is worth stating outright rather than
              leaving the footer's numbers looking wrong. */}
          {list.meta?.rowsOnPage ?? 0} {list.meta?.rowsOnPage === 1 ? 'category' : 'categories'} shown.
          Pages hold whole families, so a parent is never separated from its subcategories.
        </p>
      )}

      {editing && (
        <CategoryEditor
          category={editing}
          all={everything.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); everything.reload(); }}
        />
      )}

      {confirming && (
        <DeleteDialog
          category={confirming}
          busy={busyId === confirming.id}
          onClose={() => setConfirming(null)}
          onConfirm={() => remove(confirming)}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- table rows */

function TopRow({ group, open, onToggleOpen, busyId, onNav, onOrder, onEdit, onDelete, menuFor }) {
  const hasChildren = group.children.length > 0;
  return (
    <>
      <tr className="border-b border-admin-border hover:bg-admin-bg">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {hasChildren ? (
              <button
                type="button"
                onClick={onToggleOpen}
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name}`}
                className="grid size-6 shrink-0 place-items-center rounded-[6px] text-admin-text-2 transition-colors hover:bg-admin-border/60 hover:text-admin-text"
              >
                {open ? <ChevronDown size={15} strokeWidth={2.2} /> : <ChevronRight size={15} strokeWidth={2.2} />}
              </button>
            ) : (
              <span className="size-6 shrink-0" />
            )}
            <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[#dcfce7] text-admin-accent">
              {open && hasChildren ? <FolderOpen size={15} strokeWidth={2} /> : <Folder size={15} strokeWidth={2} />}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold text-admin-text">{group.name}</span>
                <code className="rounded-[5px] bg-admin-bg px-1.5 py-0.5 text-[12px] text-admin-text-2">/{group.segment}</code>
                <Badge tone={group.child_count ? 'info' : 'neutral'}>
                  {group.child_count} {group.child_count === 1 ? 'subcategory' : 'subcategories'}
                </Badge>
                {group.orphan && <Badge tone="danger" dot>Orphaned</Badge>}
                {group.context && <Badge tone="neutral">parent of a match</Badge>}
              </span>
              <span className="mt-0.5 block text-[12px] text-admin-muted">{group.slug}</span>
            </span>
          </div>
        </td>
        <td className="px-4 py-3 text-[14px] font-medium whitespace-nowrap text-admin-text">{group.segment}</td>
        <td className="px-4 py-3 whitespace-nowrap">
          <ProductCount category={group} />
        </td>
        <td className="px-4 py-3">
          <Toggle
            checked={group.in_nav}
            busy={busyId === group.id}
            onChange={(next) => onNav(group, next)}
            label={`Show ${group.name} in the navigation`}
          />
        </td>
        <td className="px-4 py-3">
          <OrderCell category={group} busy={busyId === group.id} onSave={(n) => onOrder(group, n)} />
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            <Btn size="sm" icon={Pencil} onClick={() => onEdit(group)}>Edit</Btn>
            <RowMenu items={menuFor(group)} label={`More actions for ${group.name}`} />
          </div>
        </td>
      </tr>

      {open && group.children.map((child, index) => (
        <ChildRow
          key={child.id}
          child={child}
          last={index === group.children.length - 1}
          busyId={busyId}
          onNav={onNav}
          onOrder={onOrder}
          onEdit={onEdit}
          onDelete={onDelete}
          menuFor={menuFor}
        />
      ))}
    </>
  );
}

function ChildRow({ child, last, busyId, onNav, onOrder, onEdit, menuFor }) {
  return (
    <tr className="border-b border-admin-border hover:bg-admin-bg">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          {/* The hierarchy line: a vertical rule under the parent's disclosure
              arrow with a short elbow into the row, stopping at the last child
              so the line does not run past the family. */}
          <span className="relative ml-3 h-9 w-6 shrink-0" aria-hidden="true">
            <span className={`absolute top-0 left-0 w-px bg-admin-border ${last ? 'h-[18px]' : 'h-9'}`} />
            <span className="absolute top-[18px] left-0 h-px w-3.5 bg-admin-border" />
          </span>
          <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-admin-bg text-admin-text-2">
            <Folder size={14} strokeWidth={2} />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium text-admin-text">{child.name}</span>
              <code className="rounded-[5px] bg-admin-bg px-1.5 py-0.5 text-[12px] text-admin-text-2">{child.href}</code>
              {child.context && <Badge tone="neutral">not a match</Badge>}
            </span>
            <span className="mt-0.5 block text-[12px] text-admin-muted">{child.slug}</span>
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5 text-[14px] whitespace-nowrap text-admin-text-2">{child.segment}</td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <ProductCount category={child} />
      </td>
      <td className="px-4 py-2.5">
        <Toggle
          checked={child.in_nav}
          busy={busyId === child.id}
          onChange={(next) => onNav(child, next)}
          label={`Show ${child.name} in the navigation`}
        />
      </td>
      <td className="px-4 py-2.5">
        <OrderCell category={child} busy={busyId === child.id} onSave={(n) => onOrder(child, n)} />
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-end gap-2">
          <Btn size="sm" icon={Pencil} onClick={() => onEdit(child)}>Edit</Btn>
          <RowMenu items={menuFor(child)} label={`More actions for ${child.name}`} />
        </div>
      </td>
    </tr>
  );
}

/**
 * Products in a category.
 *
 * A parent usually holds none directly -- all nine T-Shirts sit in its seven
 * children -- so showing the direct count alone would read as an empty
 * category. The subtree total is the headline and the direct figure is spelled
 * out underneath, because the direct one is what DELETE checks.
 */
function ProductCount({ category }) {
  const indirect = (category.subtree_count ?? category.product_count) - category.product_count;
  return (
    <span className="block">
      <span className="text-[14px] font-medium text-admin-text">{category.subtree_count ?? category.product_count}</span>
      {indirect > 0 && (
        <span className="mt-0.5 block text-[12px] text-admin-muted">
          {category.product_count} direct
        </span>
      )}
    </span>
  );
}

/** Display order, editable in place. Commits on blur or Enter, never per keystroke. */
function OrderCell({ category, busy, onSave }) {
  const [draft, setDraft] = useState(String(category.display_order));
  useEffect(() => { setDraft(String(category.display_order)); }, [category.display_order]);

  function commit() {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 0 || next > 10000) {
      setDraft(String(category.display_order));
      return;
    }
    if (next !== category.display_order) onSave(next);
  }

  return (
    <input
      type="number"
      min="0"
      max="10000"
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') setDraft(String(category.display_order));
      }}
      aria-label={`Display order for ${category.name}`}
      className="h-8 w-16 rounded-[8px] border border-admin-border bg-admin-surface px-2 text-[14px] font-medium text-admin-text focus:border-admin-text focus-visible:outline-none disabled:opacity-50"
    />
  );
}

function MobileCard({ category, depth, open, onToggleOpen, busyId, onNav, onOrder, onEdit, menuFor }) {
  const hasChildren = (category.children?.length ?? 0) > 0;
  return (
    <div className={`flex items-start gap-2.5 px-4 py-3 ${depth ? 'border-t border-admin-border bg-admin-bg/40 pl-10' : ''}`}>
      {depth === 0 && (hasChildren ? (
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${category.name}`}
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-[6px] text-admin-text-2"
        >
          {open ? <ChevronDown size={15} strokeWidth={2.2} /> : <ChevronRight size={15} strokeWidth={2.2} />}
        </button>
      ) : <span className="size-6 shrink-0" />)}

      <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-[7px] ${depth ? 'bg-admin-bg text-admin-text-2' : 'bg-[#dcfce7] text-admin-accent'}`}>
        <Folder size={14} strokeWidth={2} />
      </span>

      <div className="min-w-0 flex-1">
        <p className={`m-0 text-[14px] text-admin-text ${depth ? 'font-medium' : 'font-semibold'}`}>{category.name}</p>
        <p className="m-0 mt-0.5 truncate text-[12px] text-admin-text-2">{category.href}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-admin-text-2">
          <span><strong className="font-semibold text-admin-text">{category.subtree_count ?? category.product_count}</strong> products</span>
          {depth === 0 && <span>{category.child_count} sub</span>}
          <span className="flex items-center gap-1.5">
            order
            <OrderCell category={category} busy={busyId === category.id} onSave={(n) => onOrder(category, n)} />
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-3">
          <Toggle
            checked={category.in_nav}
            busy={busyId === category.id}
            onChange={(next) => onNav(category, next)}
            label={`Show ${category.name} in the navigation`}
          />
          <span className="text-[12px] text-admin-text-2">{category.in_nav ? 'In navigation' : 'Hidden'}</span>
          <Btn size="sm" icon={Pencil} className="ml-auto" onClick={() => onEdit(category)}>Edit</Btn>
        </div>
      </div>

      <RowMenu items={menuFor(category)} label={`More actions for ${category.name}`} />
    </div>
  );
}

/* ------------------------------------------------------------ summary cards */

const CARDS = [
  { key: 'all', label: 'Total categories', field: 'total', icon: FolderTree, tint: 'bg-[#dcfce7] text-admin-accent', note: 'Across the taxonomy', filter: {} },
  { key: 'top', label: 'Top-level categories', field: 'top_level', icon: Network, tint: 'bg-[#dbeafe] text-admin-blue', note: 'Parent categories', filter: { scope: 'top' } },
  { key: 'child', label: 'Subcategories', field: 'subcategories', icon: Layers, tint: 'bg-[#ede9fe] text-admin-purple', note: 'Across all categories', filter: { scope: 'child' } },
  { key: 'nav', label: 'Visible in navigation', field: 'in_nav', icon: Eye, tint: 'bg-[#ffedd5] text-[#ea580c]', note: 'Shown in the main menu', filter: { nav: 'visible' } },
];

function SummaryCards({ summary, loading, active, onPick }) {
  return (
    <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CARDS.map((card) => {
        const value = summary?.[card.field];
        const isActive = card.key === 'all'
          ? !active.scope && !active.nav
          : (card.filter.scope && active.scope === card.filter.scope)
            || (card.filter.nav && active.nav === card.filter.nav);
        const Icon = card.icon;
        return (
          <button
            key={card.key}
            type="button"
            aria-pressed={Boolean(isActive)}
            onClick={() => onPick(isActive && card.key !== 'all' ? {} : card.filter)}
            className={`flex items-center gap-3.5 rounded-[14px] border bg-admin-surface p-[18px] text-left transition-colors ${
              isActive ? 'border-admin-text shadow-[0_0_0_1px_#111827]' : 'border-admin-border hover:border-admin-muted/60'
            }`}
          >
            <span className={`grid size-11 shrink-0 place-items-center rounded-[11px] ${card.tint}`}>
              <Icon size={19} strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-admin-text-2">{card.label}</span>
              {loading || value == null
                ? <Skeleton className="mt-1.5 h-7 w-12" />
                : <span className="mt-0.5 block text-[28px] leading-none font-bold tracking-[-0.02em] text-admin-text">{value}</span>}
              <span className="mt-1 block truncate text-[12px] text-admin-muted">{card.note}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CategoriesSkeleton() {
  return (
    <div className="px-4">
      {Array.from({ length: 8 }).map((_, row) => (
        <div key={row} className={`flex items-center gap-3 border-b border-admin-border py-3.5 last:border-b-0 ${row % 4 ? 'pl-10' : ''}`}>
          <Skeleton className="size-7 shrink-0 rounded-[7px]" />
          <Skeleton className="h-3.5 w-[30%]" />
          <Skeleton className="ml-auto hidden h-3.5 w-20 sm:block" />
          <Skeleton className="h-[22px] w-10 rounded-full" />
          <Skeleton className="h-8 w-16 rounded-[8px]" />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- the form */

/**
 * Create or edit a category.
 *
 * Validation mirrors the server's rather than replacing it: categoryBody and
 * checkParent still decide, and a 409 from the unique index is still shown.
 * Checking here as well means the common mistakes are caught beside the field
 * that caused them instead of as one line of toast.
 */
function CategoryEditor({ category, all, onClose, onSaved }) {
  const { notify } = useStore();
  const editing = Boolean(category.id);
  const [form, setForm] = useState({
    name: category.name ?? '',
    slug: category.slug ?? '',
    segment: category.segment ?? '',
    parent_id: category.parent_id ?? '',
    in_nav: category.in_nav ?? true,
    display_order: category.display_order ?? 0,
  });
  // Only auto-fill while the operator has not typed their own value, so
  // editing an existing row never rewrites a live URL behind their back.
  const [autoSlug, setAutoSlug] = useState(!editing);
  const [autoSegment, setAutoSegment] = useState(!editing);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');

  const tops = all.filter((c) => !c.parent_id && c.id !== category.id);
  const parent = all.find((c) => c.id === form.parent_id) ?? null;
  const ownChildren = editing ? all.filter((c) => c.parent_id === category.id) : [];

  const change = (key, value) => setForm((old) => ({ ...old, [key]: value }));

  function changeName(value) {
    setForm((old) => ({
      ...old,
      name: value,
      ...(autoSegment ? { segment: suggestSegment(value, parent?.name) } : {}),
      ...(autoSlug ? { slug: suggestSlug(value, parent?.slug, parent?.name) } : {}),
    }));
  }

  function changeParent(value) {
    const nextParent = all.find((c) => c.id === value) ?? null;
    setForm((old) => ({
      ...old,
      parent_id: value,
      ...(autoSegment ? { segment: suggestSegment(old.name, nextParent?.name) } : {}),
      ...(autoSlug ? { slug: suggestSlug(old.name, nextParent?.slug, nextParent?.name) } : {}),
    }));
  }

  const effectiveSegment = form.segment || form.slug;
  const href = categoryHref({ segment: form.segment, slug: form.slug, parentSegment: parent?.segment });

  // Mirrors categoryBody, checkParent and the categories_segment unique index.
  const errors = useMemo(() => {
    const found = {};
    const name = form.name.trim();
    if (name.length < 2) found.name = 'Use at least 2 characters.';
    else if (name.length > 80) found.name = 'Use at most 80 characters.';
    else if (all.some((c) => c.id !== category.id && c.name.toLowerCase() === name.toLowerCase())) {
      found.name = 'Another category already has this name.';
    }

    if (!form.slug) found.slug = 'A slug is required.';
    else if (!/^[a-z0-9-]+$/.test(form.slug)) found.slug = 'Lowercase letters, digits and hyphens only.';
    else if (form.slug.length > 80) found.slug = 'Use at most 80 characters.';
    else if (all.some((c) => c.id !== category.id && c.slug === form.slug)) {
      found.slug = 'Another category already uses this slug.';
    }

    if (form.segment && !/^[a-z0-9-]+$/.test(form.segment)) {
      found.segment = 'Lowercase letters, digits and hyphens only.';
    } else if (effectiveSegment && all.some((c) => c.id !== category.id
      && (c.parent_id ?? '') === (form.parent_id ?? '')
      && (c.segment || c.slug) === effectiveSegment)) {
      found.segment = form.parent_id
        ? 'Another subcategory of this parent already uses this URL segment.'
        : 'Another top-level category already uses this URL segment.';
    }

    if (form.parent_id) {
      if (form.parent_id === category.id) found.parent_id = 'A category cannot be its own parent.';
      else if (parent?.parent_id) found.parent_id = 'Categories nest one level deep, so the parent must be top-level.';
      else if (ownChildren.length) {
        found.parent_id = `This category has ${ownChildren.length} subcategor${ownChildren.length === 1 ? 'y' : 'ies'}, so it cannot become one itself.`;
      }
    }

    const order = Number(form.display_order);
    if (!Number.isInteger(order) || order < 0 || order > 10000) {
      found.display_order = 'A whole number between 0 and 10000.';
    }
    return found;
  }, [form, all, category.id, parent, ownChildren.length, effectiveSegment]);

  const invalid = Object.keys(errors).length > 0;

  async function save(event) {
    event?.preventDefault();
    if (invalid) return;
    setBusy(true);
    setServerError('');
    try {
      await api(`/admin/categories${editing ? `/${category.id}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        body: {
          name: form.name.trim(),
          slug: form.slug,
          segment: form.segment,
          parent_id: form.parent_id || null,
          in_nav: form.in_nav,
          display_order: Number(form.display_order),
        },
      });
      notify(editing ? `${form.name} updated.` : `${form.name} created.`);
      onSaved();
    } catch (error) {
      setServerError(error.message);
    } finally {
      setBusy(false);
    }
  }

  const urlChanged = editing && (category.segment ?? '') !== (form.segment ?? '');

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${category.name}` : 'Add category'}
      subtitle={editing ? category.href : 'Name, URL and where it sits in the navigation'}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" busy={busy} disabled={busy || invalid} onClick={save}>Save category</Btn>
        </>
      }
    >
      <form onSubmit={save}>
        {serverError && (
          <p className="m-0 mb-4 rounded-[10px] border border-[#fecaca] bg-[#fef2f2] px-3.5 py-2.5 text-[13px] text-[#991b1b]">
            {serverError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <AdminField
            label="Category name"
            value={form.name}
            error={errors.name}
            onChange={(event) => changeName(event.target.value)}
            required
          />
          <AdminField label="Parent category" error={errors.parent_id}>
            <select value={form.parent_id} onChange={(event) => changeParent(event.target.value)} className={SELECT}>
              <option value="">None — this is a top-level category</option>
              {tops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </AdminField>
          <AdminField
            label="URL slug"
            hint={errors.slug ? undefined : 'Globally unique. The key the product API filters on.'}
            error={errors.slug}
            value={form.slug}
            onChange={(event) => { setAutoSlug(false); change('slug', slugify(event.target.value) || event.target.value); }}
            required
          />
          <AdminField
            label="URL segment"
            hint={errors.segment ? undefined : 'The piece that appears in the address. Leave blank to reuse the slug.'}
            error={errors.segment}
            value={form.segment}
            placeholder={form.slug || 'oversized'}
            onChange={(event) => { setAutoSegment(false); change('segment', slugify(event.target.value) || event.target.value); }}
          />
          <AdminField
            label="Display order"
            hint={errors.display_order ? undefined : 'Lower numbers sort first.'}
            error={errors.display_order}
            type="number" min="0" max="10000"
            value={form.display_order}
            onChange={(event) => change('display_order', event.target.value)}
            required
          />
        </div>

        {/* What the storefront will actually serve, built the same way
            hrefFor() builds it. */}
        <div className="mb-4 rounded-[10px] border border-admin-border bg-admin-bg px-3.5 py-3">
          <p className="m-0 text-[12px] font-medium text-admin-text-2">Storefront URL</p>
          <p className="m-0 mt-1 text-[14px] font-semibold [overflow-wrap:anywhere] text-admin-text">
            {href ?? <span className="font-normal text-admin-muted">Enter a name to see the URL</span>}
          </p>
          {parent && (
            <p className="m-0 mt-1 text-[12px] text-admin-muted">
              Nested under {parent.name} (/shop/{parent.segment})
            </p>
          )}
          {urlChanged && (
            <p className="m-0 mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-[#92400e]">
              <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              This changes a live URL. The old path{' '}
              <code className="rounded bg-admin-surface px-1">{category.href}</code> will stop resolving.
            </p>
          )}
        </div>

        <label className="flex items-center gap-3 text-[14px] text-admin-text">
          <Toggle
            checked={form.in_nav}
            onChange={(next) => change('in_nav', next)}
            label="Show in navigation"
          />
          Show in the storefront navigation
        </label>
        <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-admin-text-2">
          Hidden categories still resolve for the products filed under them; they just do not appear
          in the menu.
        </p>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- delete flow */

/**
 * Deletion, with the reasons it may be refused stated before it is attempted.
 *
 * The server is the guard -- it returns 409 when products or subcategories
 * still point at the row -- but the counts are already on screen, so there is
 * no reason to make someone discover the refusal by clicking. `product_count`
 * is used rather than `subtree_count` because the direct count is what the
 * server checks.
 */
function DeleteDialog({ category, busy, onClose, onConfirm }) {
  const products = category.product_count ?? 0;
  const children = category.child_count ?? 0;
  const blocked = products > 0 || children > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Delete category"
      subtitle={category.name}
      width="max-w-[520px]"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="danger" icon={Trash2} busy={busy} disabled={busy || blocked} onClick={onConfirm}>
            Delete category
          </Btn>
        </>
      }
    >
      {blocked ? (
        <>
          <p className="m-0 mb-3 flex items-start gap-2.5 text-[14px] leading-relaxed text-admin-text">
            <AlertTriangle size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-admin-warning" />
            <span><strong>{category.name}</strong> cannot be deleted yet.</span>
          </p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {products > 0 && (
              <li className="rounded-[10px] border border-admin-border bg-admin-bg px-3.5 py-2.5 text-[13px] leading-relaxed">
                <strong className="font-semibold">{products} product{products === 1 ? '' : 's'}</strong> are filed
                directly under it. Move them to another category first — deleting this would leave them
                unreachable, and the products are not deleted with it.
              </li>
            )}
            {children > 0 && (
              <li className="rounded-[10px] border border-admin-border bg-admin-bg px-3.5 py-2.5 text-[13px] leading-relaxed">
                <strong className="font-semibold">{children} subcategor{children === 1 ? 'y' : 'ies'}</strong> sit
                under it. Re-parent or delete those first; deleting this would cascade and take them with it.
              </li>
            )}
          </ul>
          <p className="m-0 mt-3 text-[13px] leading-relaxed text-admin-text-2">
            To retire it without deleting anything, turn off <strong className="font-semibold text-admin-text">In
            navigation</strong>. It keeps resolving for existing links but leaves the menu.
          </p>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] leading-relaxed text-admin-text">
            <strong>{category.name}</strong> will be removed permanently. Nothing is filed under it, so no
            products or subcategories are affected.
          </p>
          <p className="m-0 mt-3 text-[13px] leading-relaxed text-admin-text-2">
            <code className="rounded-[5px] bg-admin-bg px-1.5 py-0.5">{category.href}</code> will stop
            resolving on the storefront.
          </p>
        </>
      )}
    </Modal>
  );
}
