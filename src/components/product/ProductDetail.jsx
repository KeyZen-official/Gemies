'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../api.js';
import { useStore, useResource, Loading, ErrorState, Icon } from '../../components.jsx';
import { Button } from '../ui/Button.jsx';
import { Notice } from '../ui/Surface.jsx';
import { useProductSelection } from './useProductSelection.js';
import { ProductGallery } from './ProductGallery.jsx';
import { ProductHeader } from './ProductHeader.jsx';
import { ProductColorSelector } from './ProductColorSelector.jsx';
import { ProductSizeSelector } from './ProductSizeSelector.jsx';
import { ProductSummary } from './ProductSummary.jsx';
import { ProductDetailsPanel } from './ProductDetailsPanel.jsx';
import { DeliveryChecker } from './DeliveryChecker.jsx';
import { ProductReturns } from './ProductReturns.jsx';
import { ProductPolicies } from './ProductPolicies.jsx';
import { ProductReviews } from './ProductReviews.jsx';
import { RelatedProducts } from './RelatedProducts.jsx';
import { SizeGuide } from './SizeGuide.jsx';

export function ProductDetail() {
  const { slug } = useParams();
  const { data: product, loading, error, reload } = useResource(`/products/${slug}`);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!product) return null;

  // Keyed on the slug so navigating between products starts from a clean
  // selection, while changing colour or size inside one product does not
  // remount anything.
  return <ProductView key={product.id} product={product} />;
}

/**
 * Two-column product detail page.
 *
 * Left: the gallery, which pins while the longer information column scrolls
 * past it. Right: the buy box, in the order status, name, price, colour, size,
 * purchase, summary, details, delivery, returns.
 *
 * Quantity is not chosen here. The reference has no stepper, and the bag
 * already edits quantity per line through the same PUT /cart/items endpoint,
 * so nothing is lost by adding one and adjusting there.
 */
function ProductView({ product }) {
  const { user, cart, config, refreshCart, notify, wishlist, toggleWishlist } = useStore();
  const router = useRouter();
  const selection = useProductSelection(product);
  const {
    colorways, color, selectColor, colorInStock,
    sizes, size, setSize, sizeRequired, variant, soldOut,
    images, galleryIsColorway,
  } = selection;

  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);

  const href = `/product/${product.slug}`;
  const saved = wishlist.has(product.id);
  const colourStock = sizes.reduce((total, entry) => total + entry.available, 0);

  /**
   * Validates locally for fast feedback, then lets the server be the authority:
   * /cart/items re-reads the variant's price and stock and rejects the request
   * if the selection no longer holds.
   */
  async function addToBag({ thenCheckout = false } = {}) {
    if (!user) return router.push(`/login?next=${encodeURIComponent(href)}`);
    if (sizeRequired && !size) {
      setProblem('Please select a size.');
      return;
    }
    if (!variant) {
      setProblem('That colour and size combination is not available.');
      return;
    }
    if (variant.available < 1) {
      setProblem('That size is out of stock in this colour. Try another size or colour.');
      return;
    }
    if (pending) return; // guards a double click while the request is open

    setProblem('');
    setPending(true);
    try {
      // The cart stores an absolute quantity per line, so adding to a line
      // that already exists means sending the new total.
      const inBag = cart.items.find((item) => item.variant_id === variant.variantId)?.quantity ?? 0;
      const total = Math.min(inBag + 1, Math.min(20, variant.available));
      await api('/cart/items', { method: 'PUT', body: { variantId: variant.variantId, quantity: total } });
      await refreshCart();

      if (thenCheckout) router.push('/checkout');
      else notify(`Added to your bag — ${color}${size ? `, ${size}` : ''}.`, { label: 'View bag', href: '/cart' });
    } catch (requestError) {
      setProblem(requestError.message);
      notify(requestError.message);
    } finally {
      setPending(false);
    }
  }

  function onToggleSave() {
    if (!user) return router.push(`/login?next=${encodeURIComponent(href)}`);
    return toggleWishlist(product.id);
  }

  return (
    <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-5 pb-5 md:w-[calc(100%-32px)] md:pt-6 lg:w-[calc(100%-64px)] lg:pt-8">
      <nav className="mb-5 flex flex-wrap items-center gap-2 text-[10px] text-ink-soft md:mb-6 md:gap-3 md:text-[11px] [&_a:hover]:text-ink" aria-label="Breadcrumb">
        <Link href="/">Home</Link><span aria-hidden="true">/</span>
        <Link href={`/shop?category=${product.category_slug}`}>{product.category}</Link><span aria-hidden="true">/</span>
        <span aria-current="page">{product.name}</span>
      </nav>

      {/* Roughly 58/42, so the gallery takes the 55-60% the reference gives it.
          `items-start` is what lets the gallery pin inside its own track. */}
      <div className="grid grid-cols-1 items-start gap-7 md:grid-cols-[minmax(0,1.1fr)_minmax(300px,1fr)] md:gap-7 lg:grid-cols-[minmax(0,1.3fr)_minmax(380px,0.95fr)] lg:gap-12 xl:gap-16">
        <ProductGallery images={images} alt={`${product.brand} ${product.name}`} />

        <div className="min-w-0">
          <ProductHeader product={product} />

          <ProductColorSelector
            colorways={colorways}
            selected={color}
            onSelect={(next) => { selectColor(next); setProblem(''); }}
            inStock={colorInStock}
            showPhotographyNote={!galleryIsColorway && colorways.length > 1}
          />

          <ProductSizeSelector
            sizes={sizes}
            selected={size}
            onSelect={(next) => { setSize(next); setProblem(''); }}
            onOpenGuide={() => setGuideOpen(true)}
            error={problem}
          />

          <p className="mt-1 mb-0 text-xs text-ink-soft" role="status">
            {soldOut
              ? <span className="text-[#a83329]">Sold out in {color}</span>
              : sizes.length <= 1
                ? `${colourStock} in stock`
                : ''}
          </p>

          {/* Add to Bag and Favourite, full width and pill-shaped as in the
              reference. Buy now only appears once payments are configured;
              rendering a permanently dead third button would just be noise. */}
          <div className="mt-6 grid gap-3">
            <Button
              variant="dark"
              full
              className="py-4 text-[15px] font-normal"
              disabled={pending || soldOut}
              onClick={() => addToBag()}
            >
              {pending ? 'Adding…' : 'Add to Bag'}
            </Button>

            <Button
              variant="outline"
              full
              className={`py-4 text-[15px] font-normal ${saved ? '[&>svg]:fill-current' : ''}`}
              aria-pressed={saved}
              onClick={onToggleSave}
            >
              {saved ? 'Favourited' : 'Favourite'}
              <Icon name="heart" size={17} />
            </Button>

            {config.payments && (
              <Button
                variant="outline"
                full
                className="py-4 text-[15px] font-normal"
                disabled={pending || soldOut}
                onClick={() => addToBag({ thenCheckout: true })}
              >
                Buy now<Icon name="arrow" size={17} />
              </Button>
            )}
          </div>

          {sizes.length <= 1 && problem && (
            <p className="mt-3 mb-0 text-xs text-[#a83329]" role="status">{problem}</p>
          )}

          {!config.payments && (
            <Notice className="mt-4">
              Payments are not configured yet, so checkout is unavailable. You can still add items
              to your bag.
            </Notice>
          )}

          <div className="mt-7">
            <ProductSummary product={product} color={color} variant={variant} sizes={sizes} />
            <ProductDetailsPanel product={product} color={color} sizes={sizes} />
          </div>

          <DeliveryChecker />
          <ProductReturns />
        </div>
      </div>

      <section className="mt-10 grid md:mt-12 lg:mt-[72px]">
        <div className="border-t border-rule py-[26px] md:py-8 lg:py-10">
          <h2>Shipping &amp; returns</h2>
          <ProductPolicies />
        </div>

        <div className="border-t border-rule py-[26px] md:py-8 lg:py-10">
          <h2>Reviews</h2>
          <ProductReviews />
        </div>
      </section>

      <RelatedProducts product={product} />

      {guideOpen && <SizeGuide sizes={sizes} onClose={() => setGuideOpen(false)} />}
    </main>
  );
}
