// Server-side reads used to build route metadata.
// The browser reaches the Express API through the Next.js rewrite in
// next.config.mjs; server components have no such proxy and must call the
// API origin directly.
import { apiOrigin } from './api-origin.js';

/**
 * Fetches a public API resource, returning null instead of throwing so a
 * cold or unreachable API degrades to fallback metadata rather than a 500.
 */
export async function fetchFromApi(path, { revalidate = 60 } = {}) {
  try {
    const response = await fetch(`${apiOrigin}/api${path}`, { next: { revalidate } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
