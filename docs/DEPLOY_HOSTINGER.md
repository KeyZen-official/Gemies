# Deploying to Hostinger

This app deploys as **one Node process on one port**. `npm start` runs
`server/index.mjs`, which connects to MongoDB, attaches the Next.js request
handler to the Express app, and listens on `PORT`. The storefront and the API
share an origin, so there is no proxy to configure and no second service to
keep alive.

That shape is what Hostinger's managed Node.js hosting provides: one
long-running process per site on one assigned port, with no way for the app to
open a port of its own.

## Plan requirements

Node.js apps run on **Business/Unlimited web hosting** and any **Cloud** plan.
Single and Premium shared plans cannot run this app at all; they serve static
files and PHP only. VPS also works and is covered at the end.

Node 22.x or 24.x. `package.json` requires `>=22.13`.

## Deploy from GitHub (recommended)

In **Websites → Create site → Web App**, pick the domain, then choose **Import
your Git repository** and select the repo. Every push to the deploy branch then
redeploys automatically.

Uploading a `.zip` is also accepted, but prefer the Git import:

- A zip has to be re-uploaded by hand for every change.
- Dependency vulnerability auto-fix only works for Git-deployed apps.
- GitHub's "Download ZIP" nests everything inside a `Gemies-main/` folder, so
  you would have to set **Root directory** to that folder or the build fails.

Either way `.env` is gitignored and is not in the archive. Secrets go in
**Environment Variables** in the panel, listed below.

## Build and output settings

Set the **Framework preset** to **Other**, not Next.js.

| Field            | Value             |
| ---------------- | ----------------- |
| Package manager  | `npm`             |
| Node version     | `22.x` or `24.x`  |
| Build command    | `npm run build`   |
| Output directory | `.next`           |
| Entry file       | `server/index.mjs`|

The Next.js preset would start the app with `next start`, which runs the
framework's own server and never loads `server/index.mjs`. The storefront would
render and then every `/api` call would 404, because nothing would be serving
the Express routes. The **Other** preset is what lets the entry file own the
process.

Confirm the preset took effect by reading the build log's own summary. It
prints `Entry file:` and `Application type:`, and `Entry file: none` with
`Application type: Next.js` means the preset is still Next.js no matter what
the build and output dialog showed.

## Why `npm run build` goes through a script

`npm run build` runs `scripts/build.mjs`, which pins `NODE_ENV=production` and
passes `--webpack`. Both exist because of this host specifically.

### NODE_ENV

`next build` reads `NODE_ENV` from the environment and builds against whatever
it finds. With `development` you get the production build pipeline wired to
React's development build, and the build dies prerendering Next's own built-in
global error page:

```
Error occurred prerendering page "/_global-error"
TypeError: Cannot read properties of null (reading 'useContext')
```

Nothing in that message names `NODE_ENV` or any file in this repository. The
tell is the run of `Each child in a list should have a unique "key" prop`
warnings immediately above it, pointing at `<html>`, `<head>` and `<meta>`:
those warnings only exist in React's development build, so seeing them during
a production build is the evidence.

The build script pins the value because the environment comes from the control
panel and is therefore not under this repository's control at deploy time. The
runtime still reads `NODE_ENV` normally, so `NODE_ENV=production` in the panel
is still required -- `server/config.mjs` refuses to boot an `https://`
`APP_URL` without it.

### --webpack

```
Attempted to load @next/swc-linux-x64-gnu, but an error occurred:
/lib64/libm.so.6: version `GLIBC_2.29' not found
```

Next.js then falls back to its WebAssembly bindings, which webpack can use but
Turbopack cannot, and the build dies with "Turbopack is not supported on this
platform". The `--webpack` flag is the fix Next.js itself recommends in that
error. It produces an identical route table -- same pages prerendered as
static, same routes server-rendered on demand -- and the build is slower
locally, which is a fair trade for building at all on the target.

The `GLIBC_2.29 not found` lines stay in the build log afterwards, repeated
once per worker. They are noise: the WebAssembly fallback works, and the build
reports `Compiled successfully`. Do not go looking for them as the cause of a
later failure.

## Environment variables

Set these in the panel. Do **not** set `PORT` or `HOST`: Hostinger assigns the
port, and the app binds `0.0.0.0` on its own in production. Leave `API_ORIGIN`
unset, which is what keeps the app in single-process mode.

Required:

| Variable            | Value                                              |
| ------------------- | -------------------------------------------------- |
| `NODE_ENV`          | `production`                                       |
| `APP_URL`           | `https://yourdomain.com`, no trailing slash        |
| `MONGODB_URI`       | the Atlas connection string                        |
| `MONGODB_DB_NAME`   | the production database name                       |
| `STORE_CURRENCY`    | `INR`                                              |
| `TRUST_PROXY_HOPS`  | `1`                                                |
| `RUN_WORKER`        | `false`                                            |

`APP_URL` must be the real https address. The API compares it against the
`Origin` header on every write, so a stale value rejects every form on the site.
Startup also refuses a non-https `APP_URL` in production.

`TRUST_PROXY_HOPS=1` matters more than it looks. Hostinger's proxy sits in
front of the process, so without it every request appears to come from the
proxy's address and the per-IP rate limit in `server/security.mjs` throttles all
customers as though they were a single visitor.

Then the integration credentials, per their own docs in this folder:

- Cloudinary: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
  `CLOUDINARY_API_SECRET`, `CLOUDINARY_FOLDER`. **Required here**, not
  optional: each deployment replaces the files under `hbuilds/`, so admin
  uploads written to local disk would disappear on the next deploy. See
  `cloudinary.md`.
- Razorpay: `RAZORPAY_MODE`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`. See `RAZORPAY_DASHBOARD_SETUP.md`.
- Resend: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`,
  `ADMIN_NOTIFICATION_EMAIL`. Production will not start without the key and a
  from-address. See `RESEND_EMAIL_INTEGRATION.md`.
- Shiprocket: `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`,
  `SHIPROCKET_PICKUP_LOCATION`, `SHIPROCKET_PICKUP_PINCODE`, and the
  `PACKAGE_*` dimensions.
- Invoicing: `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `BUSINESS_EMAIL`,
  `BUSINESS_TAX_ID`, `BUSINESS_REGISTRATION`.

Every one of these is validated at startup. A wrong value fails the boot with a
sentence saying what is wrong, so check the deployment log rather than the site
if a deploy goes live and the app does not come up.

## The job queue

Set `RUN_WORKER=false` and add a **cron job** running every 5 minutes:

```
npm run worker:once
```

The queue sends verification emails, invoices, refund notices and shipping
reconciliation. By default the app process drains it on an internal timer, but
managed hosting does not keep background timers alive across idling and
redeployment, so a queue left to the timer stalls. `worker:once` does one pass
and exits, which is what a scheduler can drive. Jobs are claimed with an atomic
lease, so overlapping runs never take the same job twice.

## After the first deploy

1. **MongoDB Atlas**: add the hosting IP to Network Access, or the app cannot
   connect. The panel shows the site's IP.
2. **Razorpay webhook**: point it at
   `https://yourdomain.com/api/webhooks/razorpay` and use the same secret you
   put in `RAZORPAY_WEBHOOK_SECRET`. Without this, a payment captured by a
   customer whose browser never returned is never reconciled.
3. **Resend domain**: the sending domain's DNS records must be verified, or
   every email fails with a 403.
4. **Promote an admin**: register through the site, then run `npm run admin`
   against the production database.
5. Check `/`, `/shop`, a product page, and `/api/products` all respond.

## Known limits of managed Node.js hosting

- A request is cut off at 120 seconds. Nothing here runs that long, but a
  long-running admin export would need the cron job instead.
- No inbound WebSockets. This app does not use them.
- No second service, no custom ports, no Redis or Docker.

## VPS instead

A VPS runs the same single process with no changes: `npm ci`, `npm run build`,
`npm start` under pm2, with nginx terminating TLS and proxying to `PORT`. Set
`RUN_WORKER=true` there and skip the cron job, since the process is yours to
keep alive.

The split topology is also available if you want the API and the web server as
separate units: run the API with `npm run server` (which passes `--api-only`),
run the web server with `next start`, and set `API_ORIGIN` on the web server to
where the API listens. Setting `API_ORIGIN` is what re-enables the `/api` and
`/uploads` rewrites in `next.config.mjs`.

---

Sources for the platform details above: Hostinger's
[Node.js web app guide](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)
and [Node.js plan limits](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/).
Content was rephrased for compliance with licensing restrictions.
