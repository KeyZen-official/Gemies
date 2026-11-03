import {z} from 'zod';
import {contactMessages, storeSettings, transaction} from './mongo.mjs';
import {id, assert, hash} from './security.mjs';
import {config} from './config.mjs';
import {queueEmail} from './queue.mjs';
import {email as emailSchema} from './validation.mjs';

/**
 * Contact Us enquiries.
 *
 * The enquiry is stored first and the emails are queued second, both in one
 * transaction. That ordering is deliberate: if the mail provider is down, the
 * customer's message is still recorded and the queue retries the delivery, so
 * an enquiry is never lost to a transient provider failure. The customer is
 * told their message was received because it was.
 *
 * Abuse controls, in the order they bite:
 *   1. A per-IP rate limit on the route (see routes.mjs).
 *   2. A honeypot field most bots fill in and no real form shows.
 *   3. A link-density check, which is what distinguishes a question from an
 *      advertisement.
 *   4. A fingerprint unique index, so a double-submitted form is one enquiry
 *      and one pair of emails.
 */

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name.').max(100),
  email: emailSchema,
  subject: z.string().trim().min(3, 'Add a short subject.').max(140),
  message: z.string().trim().min(20, 'Please include a little more detail.').max(4000),
  // Optional, so a question about an existing order can be routed quickly.
  orderNumber: z.string().trim().max(32).optional().or(z.literal('')),
  // The honeypot. A real browser leaves this empty because it is hidden from
  // both the viewport and the accessibility tree.
  website: z.literal('').optional(),
}).strict();

/** Rejects messages that are mostly links. */
function looksLikeSpam({message, subject}) {
  const links = (message.match(/https?:\/\//gi) ?? []).length;
  if (links >= 3) return true;
  // A link in the subject line of a support question is not a thing.
  if (/https?:\/\//i.test(subject)) return true;
  // Classic injected-header attempt.
  if (/\b(bcc|cc|content-type)\s*:/i.test(message)) return true;
  return false;
}

/**
 * Where enquiries go. BUSINESS_EMAIL is the invoice contact and is already
 * required for checkout in production; the store's published support address
 * is the fallback so this works before that env var is set.
 */
export async function enquiryRecipient() {
  if (config.businessEmail) return config.businessEmail;
  const settings = await storeSettings().findOne({_id: 1}, {projection: {support_email: 1}});
  return settings?.support_email || '';
}

export async function submitEnquiry(body, user = null) {
  const v = contactSchema.parse(body);
  // Answered identically to a genuine submission: a bot learns nothing, and a
  // real customer never sees this branch.
  assert(!looksLikeSpam(v), 202, 'Thank you — your message has been received.');

  const recipient = await enquiryRecipient();
  assert(recipient, 503, 'The store has not published a contact address yet. Please try again later.');
  assert(config.emailEnabled, 503, 'Messages cannot be delivered right now. Please try again later.');

  // Same person, same message, twice: one enquiry.
  const fingerprint = hash(`${v.email}|${v.subject}|${v.message}`);
  const messageId = id();

  let stored;
  try {
    stored = await transaction(async (session) => {
      // `INSERT ... ON CONFLICT(fingerprint) DO NOTHING RETURNING *` returns a
      // row only when it actually inserted. An upsert carrying only
      // $setOnInsert, asked for the document as it was BEFORE the write, says
      // the same thing: null means there was nothing there and this call is
      // the one that created it. A plain insert could not be used because a
      // duplicate-key error aborts a MongoDB transaction rather than being
      // absorbed the way ON CONFLICT absorbed it.
      const before = await contactMessages().findOneAndUpdate(
        {fingerprint},
        {$setOnInsert: {
          _id: messageId,
          id: messageId,
          name: v.name,
          email: v.email,
          subject: v.subject,
          message: v.message,
          order_number: v.orderNumber || null,
          user_id: user?.id ?? null,
          handled_at: null,
          handled_by: null,
          created_at: new Date(),
        }},
        {upsert: true, returnDocument: 'before', session},
      );
      // Already submitted: do not queue a second pair of emails.
      if (before) return null;

      // To the business, with the customer as reply-to so a reply goes straight
      // back to them.
      await queueEmail(
        `contact:${messageId}`, recipient, `Contact form: ${v.subject}`,
        {
          template: 'contact_enquiry', userId: user?.id ?? null, replyTo: v.email,
          data: {name: v.name, email: v.email, subject: v.subject, message: v.message, orderNumber: v.orderNumber || ''},
        },
        session,
      );
      // And the acknowledgement to the customer.
      await queueEmail(
        `contact-ack:${messageId}`, v.email, 'We have received your message',
        {
          template: 'contact_ack', userId: user?.id ?? null, replyTo: recipient,
          data: {name: v.name, subject: v.subject},
        },
        session,
      );
      return messageId;
    });
  } catch (error) {
    // Two identical submissions racing each other: the unique index rejected
    // the second upsert, which aborts its transaction. That is the duplicate
    // path, and the duplicate path queues nothing.
    if (error.code !== 11000) throw error;
    stored = null;
  }

  // Logged without the message body or the address: enough to see the form is
  // working, nothing that puts customer content in a log aggregator.
  console.log(JSON.stringify({event: 'contact_enquiry', stored: !!stored, domain: v.email.split('@')[1] ?? ''}));

  return {message: 'Thank you — your message has been received. We usually reply within one working day.'};
}
