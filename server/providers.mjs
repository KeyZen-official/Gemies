import {HttpError,assert} from './security.mjs';
import {config,mediaHost} from './config.mjs';
async function request(url,options={}){let response;try{response=await fetch(url,{...options,signal:AbortSignal.timeout(20000)});}catch{throw new HttpError(503,'Provider response is uncertain. Reconciliation is required before retrying this operation.');}if(!response.ok)throw new HttpError(502,`Provider request failed (HTTP ${response.status}).`);return response.json();}

/**
 * Like `request`, but keeps the provider's own status code and body.
 *
 * `request` above flattens every failure to 502 with no detail, which is right
 * for a customer-facing path and useless for Shiprocket: its 4xx bodies carry
 * the actual reason (`message`, or `errors` keyed by field) and an operator
 * needs to see it. The status is returned rather than thrown so the caller can
 * distinguish 401 (re-authenticate and retry once) from 422 (a payload the
 * provider will never accept, so do not retry).
 */
async function rawRequest(url,options={}){
  let response;
  try{
    response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)});
  }catch{
    // A timeout or a dropped connection. The request may or may not have been
    // processed, which matters for shipment creation, so this is reported as
    // uncertain rather than as a failure.
    return {status:0,uncertain:true,body:null};
  }
  const text=await response.text();
  let body=null;
  try{body=text?JSON.parse(text):null;}catch{body={message:text.slice(0,300)};}
  return {status:response.status,ok:response.ok,uncertain:false,body};
}
export async function razorpay(path,body){assert(config.paymentEnabled,503,'Payments are not configured yet.');return request(`https://api.razorpay.com/v1${path}`,{method:body?'POST':'GET',headers:{Authorization:`Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
/* ------------------------------------------------------------- Shiprocket */

const SHIPROCKET_BASE='https://apiv2.shiprocket.in/v1/external';
let shipToken=null,shipExpiry=0,shipAuthInFlight=null;

/**
 * The cached Shiprocket bearer token.
 *
 * Shiprocket's token is valid for 240 hours (10 days) and is obtained by
 * posting the account email and password to /auth/login. It is cached for nine
 * days, a day inside that window, so a token is never used right as it lapses.
 *
 * Concurrent callers share one login: `shipAuthInFlight` means ten jobs
 * starting together authenticate once rather than ten times, which is also
 * what keeps this clear of Shiprocket's rate limits.
 *
 * The token lives only in this module's closure. It is never returned to a
 * caller, never logged, and never reaches a response body.
 */
async function shiprocketToken(force=false){
  if(!force&&shipToken&&Date.now()<shipExpiry)return shipToken;
  if(shipAuthInFlight)return shipAuthInFlight;
  shipAuthInFlight=(async()=>{
    try{
      const result=await rawRequest(`${SHIPROCKET_BASE}/auth/login`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:process.env.SHIPROCKET_EMAIL,password:process.env.SHIPROCKET_PASSWORD}),
      });
      if(result.uncertain)throw new HttpError(503,'The shipping provider did not respond to the authentication request.');
      // 400/403 here is a credential problem, not a transient one. Saying so
      // stops the job queue retrying it eight times.
      assert(result.status!==400&&result.status!==403,503,'Shiprocket rejected the configured email and password. Check SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD.');
      assert(result.ok&&result.body?.token,502,'Shiprocket authentication failed.');
      shipToken=result.body.token;
      shipExpiry=Date.now()+9*86400000;
      return shipToken;
    }finally{shipAuthInFlight=null;}
  })();
  return shipAuthInFlight;
}

/** Drops the cached token, so the next call authenticates again. */
export function resetShiprocketToken(){shipToken=null;shipExpiry=0;}

/**
 * One authenticated Shiprocket call.
 *
 * `method` defaults to POST when a body is given, as most of their write
 * endpoints are POST, but PATCH and DELETE are supported because courier
 * cancellation and pickup rescheduling use them.
 *
 * Three failures are handled rather than flattened:
 *
 *   401/403  the token has been rejected. It is cleared and the call is
 *            retried once with a fresh one. A second rejection is a
 *            configuration problem and is reported as such.
 *   429      rate limited. Retried after the Retry-After hint, once, because
 *            the queue's own backoff handles the rest and holding a request
 *            open for minutes is worse than failing it.
 *   timeout  reported as 503 "uncertain", which is the signal the callers use
 *            to refuse a blind retry of a non-idempotent operation.
 *
 * The provider's own message is surfaced for 4xx, because "HTTP 422" alone
 * sends an operator hunting for something Shiprocket already explained.
 */
export async function shiprocket(path,body,{method,retried=false,rateRetried=false}={}){
  assert(config.shippingEnabled,503,'Shipping provider is not configured yet.');
  const token=await shiprocketToken();
  const verb=method??(body?'POST':'GET');
  const result=await rawRequest(`${SHIPROCKET_BASE}${path}`,{
    method:verb,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),
  });

  if(result.uncertain)throw new HttpError(503,'Shipping provider response is uncertain. Reconciliation is required before retrying this operation.');

  if((result.status===401||result.status===403)&&!retried){
    resetShiprocketToken();
    await shiprocketToken(true);
    return shiprocket(path,body,{method,retried:true,rateRetried});
  }
  if(result.status===429&&!rateRetried){
    const wait=Math.min(5000,Number(result.body?.retry_after??2)*1000||2000);
    await new Promise((resolve)=>setTimeout(resolve,wait));
    return shiprocket(path,body,{method,retried,rateRetried:true});
  }

  if(!result.ok){
    const detail=shiprocketMessage(result.body);
    // 401 after a retry, or 403, is credentials. 5xx and 429 are transient.
    // Everything else in the 4xx range is a payload the provider will keep
    // refusing, so it is reported as a 409 the caller can show and not retry.
    const status=result.status===401||result.status===403?503
      :result.status===429?503
        :result.status>=500?502:409;
    throw new HttpError(status,detail?`Shiprocket: ${detail}`:`Shiprocket request failed (HTTP ${result.status}).`);
  }
  return result.body;
}

/** Shiprocket reports errors as `message`, or as `errors` keyed by field. */
function shiprocketMessage(body){
  if(!body)return '';
  if(typeof body.message==='string'&&body.message)return body.message.slice(0,300);
  if(body.errors&&typeof body.errors==='object'){
    return Object.entries(body.errors)
      .map(([field,messages])=>`${field}: ${[].concat(messages).join(', ')}`)
      .join('; ').slice(0,300);
  }
  return '';
}
/**
 * Sends one email through Resend.
 *
 * `Idempotency-Key` is the queue's dedupe key, which Resend honours for 24
 * hours: a job retried inside that window cannot deliver the message twice.
 * The worker refuses to retry an uncertain send once the window has elapsed
 * (see jobs.mjs), because after that the key no longer protects us.
 *
 * `html` and `text` are both sent. Every template renders both, so a client
 * that refuses HTML still gets a readable message, and spam filters see a
 * multipart message rather than HTML alone.
 */
export async function sendEmail(payload){
  assert(config.emailEnabled,503,'Transactional email is not configured.');
  // A display name makes the sender read as GEMIES rather than a bare address.
  // Skipped when the operator has already written their own "Name <addr>".
  const from=config.emailFrom.includes('<')?config.emailFrom:`${config.emailFromName} <${config.emailFrom}>`;
  return request('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':payload.key},body:JSON.stringify({
    from,
    to:[payload.recipient],
    subject:payload.subject,
    text:payload.text,
    ...(payload.html?{html:payload.html}:{}),
    // Lets a customer reply to a contact acknowledgement, and lets the team
    // reply straight to the customer on an enquiry.
    ...(payload.replyTo?{reply_to:[payload.replyTo]}:{}),
    ...(payload.attachments?{attachments:payload.attachments}:{}),
  })});
}

/**
 * Uploads an image to Cloudinary.
 *
 * HTTP Basic with the key and secret, which Cloudinary documents as the
 * recommended method for server-side uploads and which needs no signature or
 * timestamp (https://cloudinary.com/documentation/image_upload_api_reference).
 * It is also the same scheme `razorpay` above uses, so there is one pattern for
 * provider auth in this file. The secret stays in this process; nothing about
 * the upload is done in the browser.
 *
 * Cloudinary reports configuration mistakes in the response body, and a bare
 * "HTTP 401" would send whoever set this up hunting. So the body is read and
 * its message logged server-side, while the caller gets a message that names
 * the likely cause without echoing any credential.
 */
export async function cloudinaryUpload(content, {filename, folder}) {
  assert(config.mediaEnabled, 503, 'Image hosting is not configured yet.');
  const form = new FormData();
  form.append('file', new Blob([content], {type: 'image/webp'}), filename);
  if (folder) form.append('folder', folder);

  const credentials = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString('base64');
  let response;
  try {
    response = await fetch(`https://api.cloudinary.com/v1_1/${config.mediaCloud}/image/upload`, {
      method: 'POST',
      headers: {Authorization: `Basic ${credentials}`},
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new HttpError(503, 'The image host did not respond. The upload may or may not have been stored.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.secure_url) {
    console.error(JSON.stringify({event: 'cloudinary_upload_failed', status: response.status, detail: payload.error?.message}));
    throw new HttpError(response.status === 401 || response.status === 403 ? 503 : 502,
      response.status === 401 || response.status === 403
        ? 'The image host rejected our credentials. Check CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.'
        : `The image host refused the upload (HTTP ${response.status}).`);
  }
  // Pin the host and cloud we expect, so an unexpected response cannot put a
  // foreign URL into the catalogue.
  assert(payload.secure_url.startsWith(`${mediaHost}/${config.mediaCloud}/`), 502,
    'The image host returned an unexpected URL.');
  return {url: payload.secure_url, publicId: payload.public_id, bytes: payload.bytes};
}
