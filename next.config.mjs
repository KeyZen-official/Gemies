import { apiOrigin } from './src/api-origin.js';

const development = process.env.NODE_ENV !== 'production';

// Mirrors the helmet policy that used to protect the Vite-built HTML document.
// Next.js inlines its own bootstrap scripts, so 'unsafe-inline' is required
// here; moving to a nonce-based policy needs middleware and is the next step up.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://checkout.razorpay.com${development ? " 'unsafe-eval' blob:" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // res.cloudinary.com is added only when Cloudinary is configured, so the
  // policy stays as tight as the deployment actually needs.
  `img-src 'self' data: blob: https://*.razorpay.com${process.env.CLOUDINARY_CLOUD_NAME ? ' https://res.cloudinary.com' : ''}`,
  "font-src 'self' data:",
  `connect-src 'self' https://*.razorpay.com${development ? ' ws://localhost:* http://localhost:*' : ''}`,
  "frame-src 'self' https://*.razorpay.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(development ? [] : ['upgrade-insecure-requests']),
].join('; ');

/** @type {import('next').NextConfig} */
export default {
  // The Express API owns /api and /uploads. Proxying both means the browser
  // sees a single origin, which keeps the session cookie and the Origin-based
  // CSRF check in server/security.mjs working without CORS.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/uploads/:path*', destination: `${apiOrigin}/uploads/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          ...(development
            ? []
            : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
        ],
      },
    ];
  },
};
