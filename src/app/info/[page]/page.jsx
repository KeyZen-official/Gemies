import { Info } from '@/storefront.jsx';
import { infoTitles } from '@/info-content.js';

// Prerenders the known policy and help routes; unlisted slugs still render on
// demand and fall through to the component's "Page not found" copy.
export function generateStaticParams() {
  return Object.keys(infoTitles).map((page) => ({ page }));
}

export async function generateMetadata({ params }) {
  const { page } = await params;
  const title = infoTitles[page];
  if (!title) return { title: 'Page not found', robots: { index: false, follow: false } };
  return { title, alternates: { canonical: `/info/${page}` } };
}

export default function InfoPage() {
  return <Info />;
}
