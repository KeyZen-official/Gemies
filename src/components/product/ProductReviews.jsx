'use client';

/**
 * Customer reviews.
 *
 * There is no review backend: no reviews table, no API route, no rating column
 * on products. The section is built so it can be wired up, but it shows an
 * empty state instead of invented reviews or a made-up star average.
 *
 * To make this live, the following is needed:
 *   - migration: reviews(id, product_id, user_id, rating 1-5, title, body,
 *     verified_purchase bool, created_at) with UNIQUE(product_id, user_id)
 *   - GET  /api/products/:slug/reviews        public, paginated
 *   - POST /api/products/:slug/reviews        auth, and only for a product the
 *     user has actually received, so ratings stay verified purchases
 *   - an aggregate (count + average) on the product payload for the card and
 *     the detail header
 *   - admin moderation, since reviews are user-generated content
 */
export function ProductReviews() {
  return (
    <div className="max-w-[640px] rounded-[10px] bg-[#f7f7f5] p-[34px]">
      <h3 className="mb-2.5 text-base">No reviews yet</h3>
      <p className="m-0 text-[13px] leading-relaxed">
        This store has not collected customer reviews yet. Ratings will appear here once reviewing
        is enabled, and will be limited to customers who have received the product.
      </p>
    </div>
  );
}
