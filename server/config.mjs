export const config = {
  production: process.env.NODE_ENV === 'production', port: Number(process.env.PORT || 3001),
  // APP_BASE_URL is accepted as an alias for APP_URL. The two name the same
  // thing; APP_URL came first and is still what deployments set, so it stays
  // supported rather than being renamed out from under them.
  origin: process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:3000',
  // MongoDB is the only database. `mongoDbName` is separate from the URI so
  // one cluster can host development and production without the connection
  // string differing between them.
  //
  // MONGO_URL and MONGO_DB are accepted as aliases, because those are the
  // names Atlas's own Connect dialog and most tutorials use, and having the
  // app silently ignore a correctly-pasted connection string under a slightly
  // different name is a bad half-hour. MONGODB_URI wins if both are set.
  mongoUri: process.env.MONGODB_URI || process.env.MONGO_URL,
  mongoDbName: process.env.MONGODB_DB_NAME || process.env.MONGO_DB || 'gemies_dev',
  currency: process.env.STORE_CURRENCY || 'INR',
  paymentEnabled: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  // 'test' or 'live'. Declared explicitly rather than inferred from the key
  // prefix, so a mismatch between what the operator intended and what the keys
  // actually are is caught at startup instead of at the first real payment.
  paymentMode: process.env.RAZORPAY_MODE || 'test',
  shippingEnabled: !!(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD && process.env.SHIPROCKET_PICKUP_LOCATION),
  // Shiprocket does not sign its webhook bodies, so this is a shared secret
  // configured against a request header in their dashboard, not a signing key.
  // With it unset the webhook endpoint refuses every delivery and tracking
  // falls back to the polled reconciliation job, which is a working setup --
  // just a slower one. See the header of shiprocket.mjs.
  shiprocketWebhookSecret: process.env.SHIPROCKET_WEBHOOK_SECRET || '',
  // Cloudinary image hosting. All three parts are required, so a partial
  // configuration falls back to local disk rather than failing every upload.
  mediaEnabled: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
  // Sanitised here once, because it is interpolated into both a delivery URL
  // and the validation pattern that decides which image URLs are accepted.
  mediaCloud: (process.env.CLOUDINARY_CLOUD_NAME || '').replace(/[^a-zA-Z0-9_-]/g, ''),
  mediaFolder: (process.env.CLOUDINARY_FOLDER || '').replace(/[^a-zA-Z0-9_/-]/g, ''),

  // ------------------------------------------------- transactional email
  // Resend. RESEND_FROM_EMAIL is the documented name; EMAIL_FROM is the
  // original one and keeps working, so existing deployments are unaffected.
  //
  // Both the key and a from-address are required: a key without a verified
  // sender produces a 403 from Resend on every send, which would then be
  // retried eight times per email.
  emailEnabled: !!(process.env.RESEND_API_KEY && (process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM)),
  emailFrom: process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || '',
  emailFromName: process.env.RESEND_FROM_NAME || 'GEMIES',
  // Operator notifications. Optional: with no address configured, the admin
  // emails are skipped rather than queued to nobody.
  adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL || '',
  // Where customer enquiries go. Falls back to the invoice business address,
  // which is already required for checkout in production.
  businessEmail: process.env.BUSINESS_EMAIL || '',
};
export const mediaHost = 'https://res.cloudinary.com';
// A connection string is required everywhere, not only in production:
// connect() has no default to fall back on now that the embedded development
// database is gone, so a missing URI should fail at startup with a sentence
// rather than at the first query with a driver error.
if(!config.mongoUri) throw new Error('MONGODB_URI (or MONGO_URL) is required');
if(!/^mongodb(\+srv)?:\/\//.test(config.mongoUri)) throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
// Atlas's Connect dialog hands you a string with <db_username> and
// <db_password> as placeholders. Pasted unedited, the angle brackets are
// literal characters in the userinfo and authentication fails with a generic
// error that does not say why. Caught here instead.
if(/[<>]/.test(config.mongoUri)) throw new Error('MONGODB_URI still contains <angle brackets> from the Atlas template. Replace <db_username> and <db_password> with the real values.');
// The database name, not the username. Easy to mix up, because Atlas shows
// both on the same screen and neither is validated by the driver -- it will
// happily create and use an empty database named after your user.
if(/[\\/. "$*<>:|?]/.test(config.mongoDbName)) throw new Error('MONGODB_DB_NAME contains a character MongoDB does not allow in a database name');
if(config.production && !config.origin.startsWith('https://')) throw new Error('Production requires an HTTPS APP_URL');
if(!['INR','USD'].includes(config.currency)) throw new Error('STORE_CURRENCY must be INR or USD');
if(!config.production && process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) throw new Error('Live payment keys are forbidden in development');
if(config.mediaEnabled && config.mediaCloud !== (process.env.CLOUDINARY_CLOUD_NAME || '')) throw new Error('CLOUDINARY_CLOUD_NAME may only contain letters, digits, hyphens and underscores');

// ------------------------------------------------------- payment configuration
// Checked at startup, because every one of these is a mistake that would
// otherwise surface as a failed or, worse, a wrongly-live customer payment.
if(!['test','live'].includes(config.paymentMode)) throw new Error("RAZORPAY_MODE must be 'test' or 'live'");
if(config.paymentEnabled){
  const keyId=process.env.RAZORPAY_KEY_ID;
  // Razorpay key IDs are prefixed rzp_test_ or rzp_live_. Refuse any mismatch
  // in either direction: live keys in test mode would take real money, and
  // test keys in live mode would silently fail every checkout.
  if(!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) throw new Error('RAZORPAY_KEY_ID is not a valid Razorpay key id');
  const keyMode=keyId.startsWith('rzp_live_')?'live':'test';
  if(keyMode!==config.paymentMode) throw new Error(`RAZORPAY_MODE is '${config.paymentMode}' but RAZORPAY_KEY_ID is a ${keyMode} key`);
  if(config.paymentMode==='live'&&!config.production) throw new Error('Live Razorpay keys require NODE_ENV=production');
  // Without a webhook secret, a captured payment whose browser callback never
  // arrives would never be reconciled, so this is required rather than optional.
  if(!process.env.RAZORPAY_WEBHOOK_SECRET) throw new Error('RAZORPAY_WEBHOOK_SECRET is required whenever Razorpay keys are set');
  // The webhook secret is configured separately in the dashboard and is not the
  // API secret. Catching the common confusion here is cheap.
  if(process.env.RAZORPAY_WEBHOOK_SECRET===process.env.RAZORPAY_KEY_SECRET) throw new Error('RAZORPAY_WEBHOOK_SECRET must not be the API key secret');
}

// --------------------------------------------------------- email configuration
// Checked at startup for the same reason as the payment keys: every one of
// these is a misconfiguration that would otherwise appear as a silent pile of
// failed jobs long after the customer expected an email.
//
// A bare address or a "Display Name <address>" pair are both accepted, because
// Resend takes either in its `from` field.
const fromAddress = /<([^>]+)>\s*$/.exec(config.emailFrom)?.[1] ?? config.emailFrom;
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);

if (config.emailFrom && !looksLikeEmail(fromAddress.trim())) {
  throw new Error('RESEND_FROM_EMAIL must be an email address, optionally as "Name <you@domain>"');
}
if (config.adminEmail && !looksLikeEmail(config.adminEmail.trim())) {
  throw new Error('ADMIN_NOTIFICATION_EMAIL must be a single email address');
}
// Production must be able to send: verification links, invoices and refund
// notices are all part of a lawful checkout, not optional extras.
if (config.production && !config.emailEnabled) {
  throw new Error('Production requires RESEND_API_KEY and RESEND_FROM_EMAIL (or EMAIL_FROM)');
}
// Resend only delivers from a verified domain. A gmail.com or other free-mail
// sender cannot be verified, so it fails in production while appearing to work
// against Resend's own test address in development.
if (config.production && /@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton(mail)?)\./i.test(fromAddress)) {
  throw new Error('RESEND_FROM_EMAIL must be on a domain you have verified in Resend, not a free mailbox');
}

/**
 * GSTIN shape check.
 *
 * This string is printed verbatim on every tax invoice as the business's GST
 * registration, so a typo is not a cosmetic problem -- it makes the invoice
 * wrong. Checked at boot so it fails immediately rather than on the first
 * invoice a customer receives.
 *
 * Format: 2-digit state code, 10-character PAN, 1 entity digit, 1 letter, 1
 * checksum character. This validates the shape and the state code only; it
 * does not verify the registration exists, which only the GST portal can do.
 */
if (process.env.BUSINESS_TAX_ID) {
  const gstin = process.env.BUSINESS_TAX_ID.trim().toUpperCase();
  if (!/^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw new Error(
      'BUSINESS_TAX_ID does not look like a GSTIN (expected 15 characters: 2-digit state code, '
      + '10-character PAN, entity digit, Z, checksum). Leave it empty rather than printing a '
      + 'malformed registration on invoices.',
    );
  }
  const state = Number(gstin.slice(0, 2));
  if (state < 1 || state > 38) {
    throw new Error(`BUSINESS_TAX_ID starts with state code ${gstin.slice(0, 2)}, which is not a valid Indian state code.`);
  }
}
