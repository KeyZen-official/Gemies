// Where the Express API lives, as seen by a server-side process:
// the metadata reads in api-server.js, and the /api and /uploads rewrites in
// next.config.mjs when those are in use.
//
// The default topology is ONE process. server/index.mjs mounts the Express API
// and the Next.js request handler on the same server, on whatever port the
// platform assigns through PORT, so a server-side read goes back to this same
// process over loopback. That is not circular: Express answers /api and
// /uploads before the Next.js handler ever sees the request.
//
// Set API_ORIGIN when the API is a separate service. The development stack is
// exactly that -- next dev and the API are two processes on two ports -- so
// scripts/stack.mjs sets this for its web child rather than relying on a
// hardcoded port here.
export const apiOrigin = process.env.API_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`;

// True when the API is a separate service that Next.js has to reach over the
// network, which is the only case where the rewrites in next.config.mjs are
// wanted. In the single-process default they would point this server at
// itself and shadow the routes Express already handles.
export const apiIsSeparate = !!process.env.API_ORIGIN;
