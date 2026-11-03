'use client';
import { pageList } from '../../lib/page-list.js';

/**
 * The one pagination control, used by the shop listing, the admin lists, the
 * wishlist and the order history.
 *
 * Previously every paginated view had its own prev/next pair and a "Page 2 of
 * 7" label, which tells you where you are but gives you no way to get to page
 * 5 without clicking Next three times. This renders real page numbers with an
 * ellipsis, so any page is one click away however long the list is.
 *
 * Callback-based rather than link-based because the two callers write their
 * page in different places: the shop puts it in the query string so a listing
 * is shareable, while the admin keeps it in component state. A single `onPage`
 * serves both.
 */

const STEP = 'inline-flex min-h-10 min-w-10 items-center justify-center rounded-md px-3 text-[14px] transition-colors';

export function Pagination({
  page,
  pages,
  total,
  onPage,
  unit = 'results',
  /** Shown to the left of the control. Set false where the count is already on screen. */
  summary = true,
  className = '',
}) {
  if (!pages || pages < 1) return null;

  const go = (next) => {
    if (next < 1 || next > pages || next === page) return;
    onPage(next);
  };

  // A single page needs no controls, but the count is still worth saying.
  if (pages === 1) {
    return summary && total > 0 ? (
      <p className={`mt-5 mb-0 text-[14px] text-ink-soft ${className}`}>{total} {unit}</p>
    ) : null;
  }

  return (
    <div className={`mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between ${className}`}>
      {summary && (
        <p className="m-0 text-[14px] text-ink-soft">
          {total > 0 && <>{total} {unit} · </>}page {page} of {pages}
        </p>
      )}

      <nav aria-label="Pagination" className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => go(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className={`${STEP} border border-line hover:bg-panel disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          ←
        </button>

        {/* Narrow screens get one neighbour either side, wider screens two.
            Both lists are rendered and one is hidden, because the number of
            items changes between them and swapping on a media query in CSS is
            the only way to do that without measuring. */}
        <PageNumbers page={page} pages={pages} span={1} onGo={go} className="sm:hidden" />
        <PageNumbers page={page} pages={pages} span={2} onGo={go} className="hidden sm:flex" />

        <button
          type="button"
          onClick={() => go(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
          className={`${STEP} border border-line hover:bg-panel disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          →
        </button>
      </nav>
    </div>
  );
}

function PageNumbers({ page, pages, span, onGo, className = '' }) {
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      {pageList(page, pages, span).map((entry, index) => (
        entry === 'gap' ? (
          <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-[14px] text-ink-soft">…</span>
        ) : (
          <button
            key={entry}
            type="button"
            onClick={() => onGo(entry)}
            aria-label={`Page ${entry}`}
            aria-current={entry === page ? 'page' : undefined}
            className={`${STEP} ${entry === page
              ? 'bg-ink font-semibold text-white'
              : 'border border-line hover:bg-panel'}`}
          >
            {entry}
          </button>
        )
      ))}
    </span>
  );
}
