import {jobs,emailNotifications,withSession} from './mongo.mjs';
import {id} from './security.mjs';
import {config} from './config.mjs';

/**
 * Enqueues one background job.
 *
 * `dedupe_key` is uniquely indexed across every job kind, so the write is a
 * no-op if that key is already queued. `ON CONFLICT (dedupe_key) DO NOTHING`
 * becomes an upsert whose update contains only `$setOnInsert`: if the document
 * exists nothing is written, and if it does not it is created. That is the
 * exact semantics, and unlike a plain insert it does not have to throw and be
 * caught on the common duplicate path.
 *
 * The id is generated before the call and used for both `_id` and `id`, so a
 * document gets a consistent identifier in one round trip. It is simply
 * discarded when the key already existed.
 *
 * Pass `client` to make the enqueue atomic with the state change that
 * justifies it.
 */
export const enqueue=async(kind,key,payload,client=undefined)=>{
  const jobId=id();
  const now=new Date();
  await jobs().updateOne(
    {dedupe_key:key},
    {$setOnInsert:{
      _id:jobId,
      id:jobId,
      kind,
      dedupe_key:key,
      payload,
      status:'pending',
      attempts:0,
      available_at:now,
      locked_until:null,
      last_error:null,
      ran_at:null,
      created_at:now,
    }},
    {upsert:true,...withSession(client)},
  );
};

/**
 * Queues one email.
 *
 * Writes two documents: a ledger entry in `email_notifications` and the job
 * itself. Both are keyed on `key`, which is also sent to Resend as its
 * Idempotency-Key, so one key means one delivered email — whether the
 * duplicate came from a redelivered webhook, a retried job, or a double-
 * clicked admin button.
 *
 * `payload.template` selects the template; `payload.orderId` / `payload.userId`
 * are copied onto the ledger so a delivery can be traced to what it was about
 * after the job payload has been wiped. `payload.data` carries anything the
 * template needs that is not derivable from those ids.
 *
 * Nothing is validated as an email address here — callers pass addresses that
 * came from `users.email` or a zod-parsed form field, both already validated.
 */
export async function queueEmail(key,recipient,subject,payload,client=undefined){
  const notificationId=id();
  const now=new Date();
  await emailNotifications().updateOne(
    {dedupe_key:key},
    {$setOnInsert:{
      _id:notificationId,
      id:notificationId,
      dedupe_key:key,
      recipient,
      subject,
      template:payload.template??null,
      user_id:payload.userId??null,
      order_id:payload.orderId??null,
      status:'pending',
      attempts:0,
      provider_id:null,
      last_error:null,
      created_at:now,
      updated_at:now,
    }},
    {upsert:true,...withSession(client)},
  );
  await enqueue('email',key,{...payload,recipient,subject,key},client);
}

/**
 * Queues an operator notification to ADMIN_NOTIFICATION_EMAIL.
 *
 * A no-op when no admin address is configured: queueing to nobody would
 * accumulate jobs that can only ever fail. The store works without it, so this
 * is intentionally not an error.
 *
 * Returns whether it was queued, so a caller can log the difference.
 */
export async function queueAdminEmail(key,subject,payload,client=undefined){
  if(!config.adminEmail)return false;
  await queueEmail(`admin:${key}`,config.adminEmail,subject,payload,client);
  return true;
}
