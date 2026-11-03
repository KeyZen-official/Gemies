'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components.jsx';

/*
 * Magnifier sizing.
 *
 * The panel is 74% of the main image's width. A full-width panel would be the
 * obvious choice, but at `left: 100% + 20px` it runs 114-170px past the
 * container at every desktop width, and an absolutely positioned box still
 * counts towards scrollable overflow, so it would put a horizontal scrollbar
 * on the page. 74% is the widest that fits from 1024px up, with ~20px spare.
 *
 * Because the panel is narrower than the image, on-screen magnification is
 * ZOOM x 0.74, so ZOOM is 3 to land at roughly 2.2x.
 *
 * Tailwind needs literal class names, so three values below are derived from
 * ZOOM by hand and must be changed with it: the panel's `scale(3)`, the lens's
 * `h-[33.333%] w-[33.333%]` (1/3 of the frame), and LENS_TRAVEL. The panel
 * also has to keep the frame's aspect ratio, or the lens would stop matching
 * the region the panel shows.
 */
const ZOOM = 3;
const LENS_TRAVEL = 1 - 1 / ZOOM;

/**
 * Product image gallery: a vertical thumbnail rail, a large main image,
 * previous/next controls, and a Nike-style hover magnifier.
 *
 * Three things are worth knowing about the implementation:
 *
 * 1. The magnifier is a second copy of the same `<img>`, laid out identically
 *    to the main one and scaled about the cursor with `transform-origin`.
 *    Driving it with `background-position` instead would have meant
 *    reproducing `object-contain`'s letterboxing by hand to keep the lens and
 *    the panel showing the same region; sharing one layout removes that class
 *    of bug. Both copies use the same `src`, so the browser serves the second
 *    from cache and no extra request is made.
 *
 * 2. Cursor tracking writes CSS custom properties straight to the DOM nodes
 *    rather than going through state, so moving the mouse re-renders nothing.
 *    Only entering and leaving the image flips React state.
 *
 * 3. The magnifier is enabled only where it makes sense: a device that
 *    actually has a hovering pointer, on a viewport wide enough for the panel.
 *    Touch devices get the thumbnails, the arrows and tap-to-enlarge instead.
 */
export function ProductGallery({ images, alt }) {
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(images[0] ?? null);
  const [settling, setSettling] = useState(false);
  const [failed, setFailed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [magnifiable, setMagnifiable] = useState(false);
  const [magnifying, setMagnifying] = useState(false);

  const frameRef = useRef(null);
  const zoomRef = useRef(null);
  const lensRef = useRef(null);
  const closeRef = useRef(null);

  // A new colourway means a new list; start from its first frame.
  useEffect(() => {
    setIndex(0);
  }, [images]);

  const target = images[index] ?? null;

  // Swap only once the incoming frame has decoded, so changing image
  // cross-fades instead of flashing an empty panel.
  useEffect(() => {
    if (!target || target === shown) return;
    let cancelled = false;
    setSettling(true);
    const loader = new window.Image();
    const finish = (didFail) => {
      if (cancelled) return;
      setFailed(didFail);
      setShown(target);
      setSettling(false);
    };
    loader.onload = () => finish(false);
    loader.onerror = () => finish(true);
    loader.src = target;
    return () => { cancelled = true; };
  }, [target, shown]);

  // Only offer the magnifier to a real pointer on a wide enough viewport.
  // Re-evaluated on change, so rotating a tablet or docking a mouse is picked
  // up without a reload.
  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1024px)');
    const apply = () => setMagnifiable(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  const step = useCallback((delta) => {
    setIndex((current) => (current + delta + images.length) % images.length);
  }, [images.length]);

  /**
   * Places the magnified copy and the lens for a cursor position.
   *
   * With `transform-origin` at the cursor and `scale(ZOOM)`, the slice of the
   * frame left visible starts at `x * width * (1 - 1/ZOOM)` and is
   * `width / ZOOM` across, which is what the lens is positioned and sized to.
   */
  const track = useCallback((event) => {
    const frame = frameRef.current;
    if (!frame) return;
    const box = frame.getBoundingClientRect();
    const x = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1);

    zoomRef.current?.style.setProperty('--zoom-origin', `${x * 100}% ${y * 100}%`);
    lensRef.current?.style.setProperty('--lens-x', `${x * box.width * LENS_TRAVEL}px`);
    lensRef.current?.style.setProperty('--lens-y', `${y * box.height * LENS_TRAVEL}px`);
  }, []);

  // Escape closes the enlarged view; arrows page through it.
  useEffect(() => {
    if (!enlarged) return;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') setEnlarged(false);
      if (event.key === 'ArrowRight') step(1);
      if (event.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enlarged, step]);

  if (!images.length) {
    return (
      <div className="min-w-0">
        <div className="grid aspect-square place-items-center rounded-[10px] bg-panel p-[10%] text-center text-[13px] leading-relaxed text-ink-soft md:aspect-[1/0.92]">
          No photography has been uploaded for this product yet.
        </div>
      </div>
    );
  }

  const source = shown ?? target;
  const many = images.length > 1;
  const showMagnifier = magnifiable && !failed;

  // The column gets z-10 at desktop so the magnifier panel paints above the
  // information column, whose own positioned bits (the PIN code field) would
  // otherwise win on DOM order. It stays below the navbar's z-50.
  return (
    <div className="min-w-0 lg:sticky lg:top-[calc(var(--spacing-nav)+16px)] lg:z-10">
      {/* Thumbnails come first in the DOM so they read before the main image,
          and `flex-col-reverse` drops them below it on a narrow screen. */}
      <div className="flex flex-col-reverse gap-3 md:flex-row md:items-start md:gap-4">
        {many && (
          <ul
            className="m-0 flex list-none gap-2.5 overflow-x-auto p-0 md:w-[68px] md:shrink-0 md:flex-col md:overflow-x-visible lg:w-[76px]"
            aria-label="Product images"
          >
            {images.map((src, position) => (
              <li key={src} className="shrink-0 md:w-full">
                <button
                  type="button"
                  className={`aspect-square w-[58px] overflow-hidden rounded-md border bg-panel p-1.5 transition-colors md:w-full ${
                    position === index ? 'border-ink' : 'border-rule hover:border-[#b4b4ae]'
                  }`}
                  aria-current={position === index}
                  aria-label={`Show image ${position + 1} of ${images.length}`}
                  onClick={() => setIndex(position)}
                >
                  <img src={src} alt="" loading="lazy" width="120" height="120" className="size-full object-contain" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Anchor for the magnifier panel. It must not clip, so the rounded
            corners and the image overflow live on the frame inside it. */}
        <div className="relative min-w-0 flex-1">
          <div
            ref={frameRef}
            className="group relative aspect-square overflow-hidden rounded-[10px] bg-panel md:aspect-[1/0.92]"
            onMouseEnter={showMagnifier ? track : undefined}
            onMouseMove={showMagnifier ? track : undefined}
            onPointerEnter={showMagnifier ? () => setMagnifying(true) : undefined}
            onPointerLeave={showMagnifier ? () => setMagnifying(false) : undefined}
          >
            {failed ? (
              <div className="grid size-full place-items-center p-[10%] text-center text-[13px] leading-relaxed text-ink-soft" role="img" aria-label={`${alt} image unavailable`}>
                This image could not be loaded.
              </div>
            ) : (
              <button
                type="button"
                className={`block size-full p-0 ${showMagnifier ? 'cursor-crosshair' : 'cursor-zoom-in'}`}
                onClick={() => setEnlarged(true)}
                aria-label={`Enlarge ${alt}`}
              >
                <img
                  src={source}
                  alt={alt}
                  width="900"
                  height="900"
                  className={`size-full object-contain p-[5%] transition-opacity duration-200 ${settling ? 'opacity-35' : 'opacity-100'}`}
                />
              </button>
            )}

            {/* Lens: the slice of the frame the panel is showing. */}
            {showMagnifier && (
              <span
                ref={lensRef}
                aria-hidden="true"
                className={`pointer-events-none absolute top-0 left-0 h-[33.333%] w-[33.333%] bg-white/25 ring-1 ring-black/15 [transform:translate(var(--lens-x,0px),var(--lens-y,0px))] [will-change:transform] ${
                  magnifying ? 'opacity-100' : 'opacity-0'
                }`}
              />
            )}

            {/* Previous / next, bottom-right as in the reference. */}
            {many && (
              <div className="absolute right-3 bottom-3 flex items-center gap-2.5">
                <button
                  type="button"
                  className="grid size-9 place-items-center rounded-full border border-rule bg-white shadow-[0_2px_10px_rgba(0,0,0,0.12)] transition-colors hover:bg-[#f4f4f1] disabled:opacity-40 [&>svg]:rotate-180"
                  onClick={() => step(-1)}
                  aria-label="Previous image"
                >
                  <Icon name="arrow" size={16} />
                </button>
                <button
                  type="button"
                  className="grid size-9 place-items-center rounded-full border border-rule bg-white shadow-[0_2px_10px_rgba(0,0,0,0.12)] transition-colors hover:bg-[#f4f4f1] disabled:opacity-40"
                  onClick={() => step(1)}
                  aria-label="Next image"
                >
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            )}
          </div>

          {/* Magnifier panel. Absolutely positioned and always mounted, so it
              adds no layout and never re-requests the image; only its opacity
              and transform-origin change. */}
          {showMagnifier && (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 left-[calc(100%+20px)] z-30 hidden aspect-[1/0.92] w-[74%] overflow-hidden rounded-[10px] border border-rule bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.18)] transition-opacity duration-150 lg:block ${
                magnifying ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <img
                ref={zoomRef}
                src={source}
                alt=""
                className="size-full object-contain p-[5%] [transform-origin:var(--zoom-origin,50%_50%)] [transform:scale(3)] [will-change:transform-origin]"
              />
            </div>
          )}
        </div>
      </div>

      {enlarged && (
        <div className="fixed inset-0 z-200 grid place-items-center p-[4vmin]" role="dialog" aria-modal="true" aria-label={`${alt}, enlarged`}>
          <button type="button" className="absolute inset-0 cursor-zoom-out bg-[rgba(12,12,10,0.86)]" onClick={() => setEnlarged(false)} tabIndex={-1} aria-hidden="true" />
          <figure className="relative m-0 max-h-[90vh] max-w-[min(1100px,92vw)]">
            <img src={source} alt={alt} className="max-h-[90vh] max-w-full object-contain" />
          </figure>
          {many && (
            <div className="absolute bottom-[4vmin] flex items-center gap-4">
              <button type="button" className="grid size-10 place-items-center rounded-full bg-white [&>svg]:rotate-180" onClick={() => step(-1)} aria-label="Previous image">
                <Icon name="arrow" size={18} />
              </button>
              <button type="button" className="grid size-10 place-items-center rounded-full bg-white" onClick={() => step(1)} aria-label="Next image">
                <Icon name="arrow" size={18} />
              </button>
            </div>
          )}
          <button ref={closeRef} type="button" className="absolute top-[3vmin] right-[3vmin] inline-flex size-9 items-center justify-center text-white" onClick={() => setEnlarged(false)} aria-label="Close enlarged image">
            <Icon name="close" size={22} />
          </button>
        </div>
      )}
    </div>
  );
}
