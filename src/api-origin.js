// Where the Express API lives, as seen by a server-side process:
// the /api and /uploads rewrites in next.config.mjs and the metadata reads in
// api-server.js.
//
// This deliberately does NOT fall back to process.env.PORT. Next.js sets PORT
// to its own listening port, which would point the rewrite at Next itself and
// hang every API request. Set API_ORIGIN when the API is not on 127.0.0.1:3001
// (for example when you change the API's PORT, or run it in a container).
export const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:3001';
