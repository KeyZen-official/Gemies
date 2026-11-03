'use client';
import { useEffect, useLayoutEffect } from 'react';

/**
 * A small localStorage cache for the few payloads the app needs *before* it can
 * render anything useful.
 *
 * The problem it solves: on every refresh the store bootstrapped from nothing.
 * `ready` started false, `user` started null, and the app fired
 * /auth/session and /config before it knew who you were -- so every gated page
 * showed "Loading your next favourites…" for the length of a round trip, and
 * the navbar rendered with an empty mega menu until /categories/tree landed.
 * That is the flash: a few hundred milliseconds of placeholder on every
 * reload, every time.
 *
 * Reading a cached copy first lets the real content paint immediately, then the
 * live request revalidates it. Stale-while-revalidate, by hand.
 *
 * What is deliberately NOT cached:
 *
 *   - The CSRF token. It is a security token tied to the session, so it is
 *     stripped before the user is written here and only ever comes from a live
 *     /auth/session response.
 *   - Anything from /admin. Those payloads are both sensitive and
 *     time-critical -- a stale order total or stock count is worse than a
 *     spinner.
 *
 * What is cached is the session's identity fields and the public store config.
 * None of it is a credential: the session itself is an httpOnly cookie that no
 * script can read, so a cached `role: 'admin'` lets the admin frame paint early
 * but cannot authorise anything. Every admin request is still checked on the
 * server against the database role.
 *
 * VERSION is in the key, so changing a payload's shape orphans the old entries
 * instead of feeding a stale shape to new code.
 */

const VERSION = 'v1';
const PREFIX = `gemies:${VERSION}:`;
/** Long enough to cover a working day of refreshes, short enough to not rot. */
const TTL_MS = 12 * 60 * 60 * 1000;

const storage = () => {
  try {
    // Private browsing and some embedded webviews throw on access rather than
    // returning null, so this has to be inside the try.
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readCache(key) {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    if (!raw) return null;
    const { at, value } = JSON.parse(raw);
    if (!at || Date.now() - at > TTL_MS) {
      store.removeItem(PREFIX + key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeCache(key, value) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Quota exceeded, or storage disabled. The cache is an optimisation; losing
    // it costs a spinner, not correctness.
  }
}

export function clearCache(key) {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PREFIX + key);
  } catch { /* see writeCache */ }
}

/**
 * Drops everything this app has cached, across every version prefix. Called on
 * sign-out, so the next visitor to the browser does not inherit the last one's
 * cached identity.
 *
 * Enumerated with `length` and `key(i)` rather than Object.keys, which is the
 * documented Storage interface and the only portable way to list it. Iterated
 * backwards because removing an entry reindexes the ones after it.
 */
export function clearAllCache() {
  const store = storage();
  if (!store) return;
  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (key && key.startsWith('gemies:')) store.removeItem(key);
    }
  } catch { /* see writeCache */ }
}

/**
 * useLayoutEffect in the browser, useEffect on the server.
 *
 * The cache has to be applied before the browser paints, or the flash it exists
 * to remove happens anyway. useLayoutEffect does that, but React warns when it
 * runs during server rendering, and these components do render on the server.
 */
export const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
