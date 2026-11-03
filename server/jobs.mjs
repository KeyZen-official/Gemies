import {
  orders, payments, refunds, shipments, jobs, emailNotifications,
  sessions, authTokens, rateLimits, transaction,
} from './mongo.mjs';
import {createInvoice} from './invoices.mjs';
import {createShipment,syncTracking,requestRefund,syncRefund} from './fulfillment.mjs';
import {sendEmail,razorpay} from './providers.mjs';
import {buildEmail} from './emails/index.mjs';
import {releaseOrder,acceptCapturedPayment} from './commerce.mjs';
import {enqueue} from './queue.mjs';
import {config} from './config.mjs';
import {expireReservations,expireCoinsSweep} from './wallet.mjs';

/**
 * The background worker.
 *
 * Bodies are rendered at send time by server/emails. See the note there on why
 * the queue stores ids rather than text.
 *
 * ## Claiming a job without SKIP LOCKED
 *
 * PostgreSQL did this with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`: take a
 * row lock on the first runnable job and step over any row another worker has
 * already locked. MongoDB has no row locks to skip, so the claim is a single
 * `findOneAndUpdate` instead.
 *
 * That is not a weaker guarantee, it is a different one that happens to be
 * sufficient. A `findOneAndUpdate` matches and modifies one document
 * atomically, so two workers issuing the same claim cannot both be handed the
 * same job: the first flips it to `running` with a lease in the future, and by
 * the time the second evaluates the filter that document no longer matches it,
 * so the second gets the next runnable job or nothing. There is no blocking
 * and no lost wake-up, which is what SKIP LOCKED was for.
 *
 * ## Leases and abandoned jobs
 *
 * `locked_until` is a lease, not a flag. A worker that crashes mid-job leaves
 * the document at `status: 'running'` forever, so the claim filter also
 * matches a running job whose lease has elapsed. That is the recovery path,
 * and it is the same single statement -- nothing has to sweep for orphans.
 *
 * The lease is deliberately longer than any job should take. A job that
 * outlives its lease can be picked up a second time while the first attempt is
 * still running, so every job body is idempotent (keyed invoices, keyed
 * emails, conditional shipment and refund claims) rather than relying on the
 * lease alone.
 */

/** How long a claimed job is ours. Was `now() + interval '5 minutes'`. */
const LEASE_MS = 5 * 60 * 1000;

/** Attempts after which a failure stops being retried. */
const MAX_ATTEMPTS = 8;

/**
 * Claims the next runnable job, atomically.
 *
 * Runnable means either queued and due, or running with an elapsed lease.
 * Ordered by `available_at` so the oldest due job goes first, which is the
 * ordering the SQL had.
 */
async function claimJob() {
  const now = new Date();
  return jobs().findOneAndUpdate(
    {$or: [
      {status: 'pending', available_at: {$lte: now}},
      {status: 'running', locked_until: {$lt: now}},
    ]},
    {
      $set: {status: 'running', locked_until: new Date(now.getTime() + LEASE_MS), ran_at: now},
      $inc: {attempts: 1},
    },
    {sort: {available_at: 1}, returnDocument: 'after'},
  );
}

export async function runJob(){
  const job=await claimJob();
  if(!job)return false;
  try{
    if(job.kind==='invoice')await createInvoice(job.payload.orderId);
    else if(job.kind==='shipment')await createShipment(job.payload.orderId);
    else if(job.kind==='tracking')await syncTracking(job.payload.orderId);
    else if(job.kind==='refund')await requestRefund(job.payload.orderId,job.payload.reason);
    else if(job.kind==='refund_sync')await syncRefund(job.payload.orderId);
    else if(job.kind==='payment_sync'){
      const p=await payments().findOne({order_id:job.payload.orderId});
      if(p?.gateway_order_id){
        const list=await razorpay(`/orders/${p.gateway_order_id}/payments`);
        for(const payment of list.items||[])if(payment.status==='captured')await acceptCapturedPayment(payment);
      }
    }
    else if(job.kind==='email'){
      const n=await emailNotifications().findOne({dedupe_key:job.payload.key});
      // A job with no ledger row means something enqueued 'email' directly
      // instead of through queueEmail. Terminal: a retry cannot invent the row.
      if(!n)throw new Error(`Email reconciliation required: no notification row for ${job.payload.key}.`);
      if(n.status!=='sent'){
        // Resend retains idempotency keys for 24 hours; do not blindly retry
        // uncertain sends beyond that window.
        if(n.status==='sending'&&Date.now()-new Date(n.created_at).getTime()>23*3600000)throw new Error('Email reconciliation required: idempotency window elapsed.');
        const built=await buildEmail(job.payload);
        await emailNotifications().updateOne({dedupe_key:job.payload.key},{$set:{status:'sending',updated_at:new Date()},$inc:{attempts:1}});
        const result=await sendEmail({...built,key:job.payload.key,recipient:job.payload.recipient});
        await emailNotifications().updateOne({dedupe_key:job.payload.key},{$set:{status:'sent',provider_id:result.id,last_error:null,updated_at:new Date()}});
        // Recipient is logged as a domain only: enough to spot a provider
        // problem with one mail host, without putting customer addresses in logs.
        console.log(JSON.stringify({event:'email_sent',template:job.payload.template??'legacy',domain:String(job.payload.recipient).split('@')[1]??'',providerId:result.id}));
      }
    }
    else throw new Error('Unknown job type');

    // `payload=CASE WHEN kind='email' THEN '{}' ELSE payload END`: an email
    // payload is wiped on success because a verification payload carries a
    // live token. The branch is decided here because the kind is already known.
    await jobs().updateOne({_id:job._id},{$set:{
      status:'done',locked_until:null,last_error:null,
      ...(job.kind==='email'?{payload:{}}:{}),
    }});
  }catch(e){
    const terminal=job.attempts>=MAX_ATTEMPTS||String(e.message).includes('reconciliation');
    const reason=e.status?e.message:'Job failed. Inspect provider state before retrying.';
    // Exponential backoff. `attempts` was incremented when the job was
    // claimed, so this is the delay after that many failures: 30s, 60s, 120s
    // ... up to 1920s at the seventh, after which the eighth is terminal. The
    // one-hour ceiling is therefore never reached; it is kept because it is
    // what the SQL had and because it bounds the delay if MAX_ATTEMPTS is ever
    // raised.
    const backoffSeconds=Math.min(3600,15*2**job.attempts);
    await jobs().updateOne({_id:job._id},{$set:{
      status:terminal?'failed':'pending',
      locked_until:null,
      available_at:new Date(Date.now()+backoffSeconds*1000),
      last_error:reason,
    }});
    // Mirror the terminal state onto the ledger, so "did this customer ever
    // get their email" is answerable from one table. The stored reason is the
    // same redacted string as the job's: never a provider body or a token.
    if(job.kind==='email'&&terminal){
      await emailNotifications().updateOne(
        {dedupe_key:job.payload.key,status:{$ne:'sent'}},
        {$set:{status:'failed',last_error:reason,updated_at:new Date()}},
      );
    }
    console.error(JSON.stringify({event:'job_failed',id:job._id,kind:job.kind,status:e.status||500,terminal}));
  }
  return true;
}

let busy=false,lastMaintenance=0;
export async function tick(){
  if(busy)return;
  busy=true;
  try{
    if(Date.now()-lastMaintenance>60000){lastMaintenance=Date.now();await maintenance();}
    for(let i=0;i<10;i++)if(!await runJob())break;
  }catch(e){
    console.error(JSON.stringify({event:'worker_error',code:e.code||'unknown'}));
  }finally{busy=false;}
}

export async function maintenance(){
  const now=new Date();

  // Abandoned checkouts. releaseOrder now gets a real MongoDB session, so
  // cancelling the order, returning the reserved stock and releasing the held
  // coins commit together or not at all.
  const expired=await orders()
    .find({status:'pending',expires_at:{$lt:now}},{projection:{_id:1}})
    .limit(100).toArray();
  for(const o of expired)await transaction(session=>releaseOrder(o._id,session));

  const bucket=Math.floor(Date.now()/900000);

  if(config.shippingEnabled){
    // The tracking sweep, and the reconciliation fallback for webhooks.
    //
    // Filtered on the normalised `stage` rather than on the provider's free
    // text, which the previous version matched against a hardcoded list of
    // four spellings of "Delivered" and so kept polling anything a courier
    // worded differently. A parcel in a terminal stage is finished and is not
    // polled again.
    const TERMINAL=['delivered','rto_delivered','cancelled'];
    const live=await shipments().find({
      $or:[{provider_shipment_id:{$ne:null}},{awb:{$ne:null}}],
      stage:{$nin:TERMINAL},
      status:{$ne:'cancelled'},
    },{projection:{order_id:1}}).toArray();
    for(const s of live)await enqueue('tracking',`track:${s.order_id}:${bucket}`,{orderId:s.order_id});
  }

  if(config.paymentEnabled){
    // Was `orders o JOIN payments p ON p.order_id=o.id`. The orders side is
    // filtered first because it is the selective half -- pending orders from
    // the last seven days -- and the payments read is then a single keyed
    // lookup over that small set rather than a scan of every payment.
    const cutoff=new Date(Date.now()-7*86400000);
    const pending=await orders()
      .find({payment_status:'pending',created_at:{$gt:cutoff}},{projection:{_id:1}})
      .toArray();
    if(pending.length){
      const started=await payments().find({
        order_id:{$in:pending.map(o=>o._id)},
        gateway_order_id:{$ne:null},
      },{projection:{order_id:1}}).toArray();
      for(const p of started)await enqueue('payment_sync',`pay-sync:${p.order_id}:${bucket}`,{orderId:p.order_id});
    }

    const unsettled=await refunds().find({
      provider_id:{$ne:null},
      status:{$nin:['processed','failed']},
    },{projection:{order_id:1}}).toArray();
    for(const r of unsettled)await enqueue('refund_sync',`refund-sync:${r.order_id}:${bucket}`,{orderId:r.order_id});
  }

  // Wallet housekeeping. Both are no-ops unless an operator has configured
  // them: expireReservations only lapses abandoned checkout holds, and
  // expireCoinsSweep returns immediately when coin expiry is switched off.
  await expireReservations();
  await expireCoinsSweep();

  await sessions().deleteMany({expires_at:{$lt:now}});
  await authTokens().deleteMany({expires_at:{$lt:now}});
  await rateLimits().deleteMany({expires_at:{$lt:now}});
  await jobs().deleteMany({status:'done',created_at:{$lt:new Date(Date.now()-30*86400000)}});
}

export function startWorker(){const timer=setInterval(tick,5000);timer.unref();tick();return timer;}
