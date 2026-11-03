import { ProductDetail } from '@/components/product/ProductDetail.jsx';
import { fetchFromApi } from '@/api-server.js';

// Real per-product titles, descriptions, and share images — the single-page
// index.html could never produce these because it shipped one static <head>.
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const product = await fetchFromApi(`/products/${slug}`);
  if (!product) return { title: 'Product' };

  const description = product.description
    ? product.description.slice(0, 200)
    : `${product.brand} ${product.name} at Gemies.`;

  return {
    title: product.name,
    description,
    alternates: { canonical: `/product/${slug}` },
    openGraph: {
      type: 'website',
      title: product.name,
      description,
      url: `/product/${slug}`,
      ...(product.images?.[0] ? { images: [{ url: product.images[0] }] } : {}),
    },
  };
}

export default function ProductPage() {
  return <ProductDetail />;
}
