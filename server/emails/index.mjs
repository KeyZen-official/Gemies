/**
 * Turns a queued email payload into the rendered message the worker sends.
 *
 * The queue stores the smallest description it can — a template name plus the
 * ids it applies to — and the body is rendered here, at send time. That
 * matters for two reasons:
 *
 *   1. An order email rendered at send time reflects the order as it is now,
 *      so a retry two hours later does not describe stale state.
 *   2. The job payload stays free of customer data. jobs.mjs wipes the payload
 *      on success precisely because a verification payload carries a live
 *      token; keeping bodies out of it in the first place means a `failed` job
 *      row is not a copy of someone's address either.
 */
import {config} from '../config.mjs';
import {orderDetails} from '../commerce.mjs';
import {invoicePdf, businessDetails} from '../invoices.mjs';
import {renderEmail, shippingStage} from './templates.mjs';

/** Templates whose data comes from an order. */
const ORDER_TEMPLATES = new Set([
  'paid', 'invoice', 'cancelled', 'payment_failed',
  'refund_started', 'refunded', 'partially_refunded', 'refund_failed',
  'shipment_created', 'awb', 'tracking',
  'exchange_requested', 'exchange_update',
  'admin_order', 'admin_payment_attention', 'admin_cancelled', 'admin_refund',
]);

/**
 * Builds `{subject, html, text, attachments?}` for one queued payload.
 *
 * The subject stored on the notification row when it was queued is used as the
 * fallback, so an email whose template produces nothing still carries the
 * subject the ledger recorded.
 */
export async function buildEmail(payload) {
  // Legacy shape: a payload that already carries its own body and no template.
  // Kept so jobs queued before templates existed still send rather than
  // failing eight times and landing in `failed`.
  if (!payload.template) {
    if (payload.text) return {subject: payload.subject, text: payload.text};
    throw new Error(`Email payload has no template: ${payload.key}`);
  }

  const data = {
    origin: config.origin,
    businessAddress: businessDetails().address || '',
    ...payload.data,
  };

  if (ORDER_TEMPLATES.has(payload.template)) {
    const order = await orderDetails(payload.orderId);
    // A missing order is permanent, not transient: fail fast rather than
    // retrying for two hours. 'reconciliation' marks the job terminal.
    if (!order) throw new Error(`Email reconciliation required: order ${payload.orderId} no longer exists.`);
    data.order = order;
    // Tracking wording is derived from the live shipment, not from whatever
    // the status was when the job was queued.
    if (payload.template === 'tracking') {
      data.stage = payload.data?.stage ?? shippingStage(order.shipment?.status, payload.data?.code);
    }
  }

  const rendered = renderEmail(payload.template, data);

  // Reply-to is a property of the message, not the template: a contact
  // enquiry replies to the customer, its acknowledgement to the business.
  if (payload.replyTo) rendered.replyTo = payload.replyTo;

  if (payload.attachInvoice) {
    const order = data.order ?? await orderDetails(payload.orderId);
    // Only attach when the invoice record exists; otherwise send the email
    // without it rather than failing the whole send.
    if (order?.invoice?.number) {
      rendered.attachments = [{
        filename: `${order.invoice.number}.pdf`,
        content: (await invoicePdf(order.id)).toString('base64'),
      }];
    }
  }

  return {...rendered, subject: rendered.subject || payload.subject};
}

export {renderEmail, shippingStage};
export {templateNames} from './templates.mjs';
