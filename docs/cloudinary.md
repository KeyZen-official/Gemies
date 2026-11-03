# Cloudinary image hosting

Admin image uploads go to Cloudinary when it is configured, and to local disk
when it is not.

## Configuration

Four variables in `.env`. The workspace is not a git repository yet, but `.env`
is already listed in `.gitignore`, so the secret stays out of source control
once one is initialised. `.env.example` documents the variables with no values.

```
CLOUDINARY_CLOUD_NAME=uboorsue
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_FOLDER=gemies
```

All of `CLOUD_NAME`, `API_KEY` and `API_SECRET` must be present for
`config.mediaEnabled` to be true. A partial configuration falls back to local
disk rather than failing every upload, which is the same pattern payments,
shipping and email already follow here. `CLOUDINARY_FOLDER` is optional; without
it assets land at the root of the media library.

## How it works

`POST /api/admin/images` is unchanged from the outside. It still accepts one
PNG, JPEG or WebP up to 5 MB, still re-encodes it with sharp (rotate, fit inside
1800x1800, WebP quality 88), and still returns `{ url }`. Only the destination
moved:

| | Cloudinary configured | not configured |
|---|---|---|
| destination | `gemies/` in the media library | `UPLOAD_DIR`, default `uploads/` |
| returned url | `https://res.cloudinary.com/<cloud>/image/upload/...` | `/uploads/<uuid>.webp` |
| audit entry | `cloudinary:gemies/<public_id>` | `disk:<filename>` |

`server/media.mjs` makes that choice; `cloudinaryUpload` in
`server/providers.mjs` makes the call.

### Authentication

HTTP Basic with the API key and secret, which Cloudinary documents as the
recommended method for server-side uploads and which needs no signature or
timestamp ([Upload API reference](https://cloudinary.com/documentation/image_upload_api_reference)).
It is also the scheme `razorpay` in the same file already uses, so there is one
pattern for provider auth.

Signature-based auth was tried first and is strictly worse here: it adds a
canonical-string construction and a SHA hash whose algorithm has to match what
the account is set to, and when it fails it fails as `Invalid Signature`, which
is indistinguishable from a wrong secret. Basic auth returns a plain 401.

The secret is read from the environment inside the API process. Nothing about
the upload happens in the browser.

### No transformation on upload

The image arriving at `cloudinaryUpload` has already been re-encoded by the
admin route, so no Cloudinary transformation is requested. What is stored is
what we produced, which keeps one normalisation step rather than two.

## Security

Three deliberate constraints:

- **Only our own cloud is accepted in the catalogue.** `productSchema.images`
  accepts `/assets/...`, `/uploads/...`, or an HTTPS delivery URL whose cloud
  name matches `CLOUDINARY_CLOUD_NAME`. Without that pin, an admin could point
  a product at any external host. The cloud name is sanitised in
  `config.mediaCloud` before being interpolated into the pattern.
- **The response URL is pinned too.** `cloudinaryUpload` asserts the returned
  `secure_url` starts with `https://res.cloudinary.com/<our cloud>/`, so an
  unexpected response cannot put a foreign URL into the database.
- **`res.cloudinary.com` is added to `img-src` only when Cloudinary is
  configured**, in both Content-Security-Policy headers: the Next.js one in
  `next.config.mjs` and the helmet one in `server/app.mjs`. Both had to change
  or the browser would have blocked every uploaded image. This was the one
  non-obvious part of the wiring.

## Verification performed

A real upload was made to the live account, not mocked.

- `POST /api/admin/images` through the real route with an admin session:
  returns 201, the URL is on cloud `uboorsue`, under `gemies/`, as WebP, and the
  audit log records `cloudinary:gemies/<public_id>`.
- The delivery URL returns 200 `image/webp`, and the bytes downloaded back
  decode to the same 375x323 WebP that was sent.
- A product created with that URL is accepted; one pointed at a different
  Cloudinary cloud or at an arbitrary host is rejected with 400.
- The public `GET /api/products/:slug` returns the Cloudinary URL.
- Both CSP headers were read off the running servers and contain
  `res.cloudinary.com`.
- The local-disk fallback still writes byte-for-byte when the variables are
  removed.
- 22/22 existing tests pass. They run without `--env-file`, so the suite stays
  offline and exercises the disk fallback.

Three assets from these checks are in the `gemies` folder and can be deleted.

## Note on the credentials

The key and secret were read from a screenshot, so they were verified by
authenticating rather than by inspection. The first attempt failed because one
character was misread; the value now in `.env` is the corrected one.

Those credentials are visible in that screenshot. They belong to a Test product
environment, but if the screenshot has been shared anywhere, rotate the key on
the Cloudinary console API Keys page and update `.env`. Nothing else needs to
change.
