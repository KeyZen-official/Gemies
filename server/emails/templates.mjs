/**
 * Every transactional email GEMIES sends, as data.
 *
 * A template is `(data) => {subject, ...layoutDescription}`. It never produces
 * markup; `layout()` does that, so all of them share one design and one
 * plain-text renderer.
 *
 * Template names are the `template` field on the queued payload and are
 * recorded on the email_notifications row, so what was sent is auditable
 * after the job payload has been wiped.
 *
 * Nothing here is allowed to include a password, a raw token, or a provider
 * response. Verification and reset emails receive a complete URL that the
 * caller built; this file never sees the token on its own and never logs it.
 */
import {layout, section, money, escape} from './layout.mjs';

const {paragraph, panel, rows, items, totals, address, divider} = section;

/** Order lines as display rows. */
const orderLines = (order) => items(order.items.map((i) => ({
  name: i.name,
  meta: [i.size && `Size ${i.size}`, i.color, `Qty ${i.quantity}`, `${money(i.unit_price, order.currency)} each`]
    .filter(Boolean).join(' · '),
  amount: money(i.unit_price * i.quantity, order.currency),
})));

/** Subtotal through to total, skipping the lines that are zero. */
const orderTotals = (order) => totals([
  ['Subtotal', money(order.subtotal, order.currency)],
  ...(order.discount > 0 ? [['Discount', `− ${money(order.discount, order.currency)}`]] : []),
  ...(order.tax > 0 ? [['Tax', money(order.tax, order.currency)]] : []),
  ['Shipping', order.shipping > 0 ? money(order.shipping, order.currency) : 'Free'],
  ['Total', money(order.total, order.currency), true],
]);

const addressLines = (a) => [
  a?.name, a?.line1, a?.line2,
  [a?.city, a?.state, a?.postalCode].filter(Boolean).join(', '),
  a?.country, a?.phone,
];

const orderMeta = (order) => rows([
  ['Order number', `#${order.number}`],
  ['Order date', new Date(order.created_at).toISOString().slice(0, 10)],
  ...(order.invoice?.number ? [['Invoice', order.invoice.number]] : []),
]);

const firstName = (order) => String(order.address?.name || '').split(' ')[0] || 'there';
const orderUrl = (order, origin) => `${origin}/orders/${order.id}`;

/**
 * Shipping status, in words a customer recognises.
 *
 * Shiprocket returns free-text statuses plus a numeric code. The code is the
 * reliable part (7 delivered, 6/17/18 in transit, 19 out for delivery), so it
 * drives the wording and the raw provider status is shown alongside rather
 * than being the headline.
 */
export function shippingStage(status, code) {
  const text = String(status || '').toLowerCase();
  if (code === 7 || text.includes('deliver') && !text.includes('out for')) return 'delivered';
  if (code === 19 || text.includes('out for delivery')) return 'out_for_delivery';
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('rto') || text.includes('undeliver') || text.includes('exception') || text.includes('lost')) return 'exception';
  if ([6, 17, 18].includes(code) || text.includes('transit') || text.includes('shipped') || text.includes('picked')) return 'shipped';
  return 'update';
}

const STAGE_COPY = {
  delivered: {subject: (o) => `Delivered — order #${o.number}`, heading: 'Your order has been delivered', lede: 'We hope it is everything you expected.'},
  out_for_delivery: {subject: (o) => `Out for delivery — order #${o.number}`, heading: 'Out for delivery today', lede: 'Your parcel is with the courier for delivery.'},
  shipped: {subject: (o) => `Shipped — order #${o.number}`, heading: 'Your order is on its way', lede: 'Your parcel has left our facility.'},
  cancelled: {subject: (o) => `Shipment cancelled — order #${o.number}`, heading: 'This shipment was cancelled', lede: 'The courier booking for your order has been cancelled.'},
  exception: {subject: (o) => `Delivery needs attention — order #${o.number}`, heading: 'Your delivery needs attention', lede: 'The courier reported a problem while delivering your parcel.'},
  update: {subject: (o) => `Delivery update — order #${o.number}`, heading: 'Delivery update', lede: 'There is a new update on your delivery.'},
};

const shipmentRows = (order) => rows([
  ['Order', `#${order.number}`],
  ...(order.shipment?.courier ? [['Courier', order.shipment.courier]] : []),
  ['Tracking number', order.shipment?.awb || 'Awaiting assignment'],
  ['Status', order.shipment?.status || 'Pending'],
]);

export const templates = {
  // ------------------------------------------------------------------ auth
  welcome: ({name, origin}) => ({
    subject: 'Welcome to GEMIES',
    preheader: 'Your account is ready once your email is confirmed.',
    heading: `Welcome, ${String(name || '').split(' ')[0] || 'there'}`,
    lede: 'Thank you for creating a GEMIES account.',
    sections: [
      paragraph('We make men’s everyday essentials — T-shirts, shirts and bottom wear cut for comfortable, versatile wear.'),
      paragraph('One step remains: confirm your email address using the separate verification message we have just sent. Until then your account cannot be used to sign in.'),
    ],
    cta: {label: 'Browse the collection', href: `${origin}/shop`},
    note: 'If you did not create this account, you can ignore both emails and nothing further will happen.',
  }),

  verify: ({url}) => ({
    subject: 'Confirm your GEMIES email address',
    preheader: 'This confirmation link expires in one hour.',
    heading: 'Confirm your email address',
    lede: 'Confirming your address activates your GEMIES account.',
    sections: [paragraph('This link can be used once and expires one hour after it was requested.')],
    cta: {label: 'Confirm email address', href: url},
    note: 'If you did not request this, ignore this email. No account can be used until its address is confirmed.',
  }),

  /**
   * Exchange requested.
   *
   * Deliberately says nothing about coins being credited. They are not, and
   * will not be until the item has come back and passed inspection -- telling
   * a customer otherwise here is the quickest way to create a complaint.
   */
  exchange_requested: ({order, origin}) => ({
    subject: `Exchange request received — order #${order.number}`,
    preheader: 'We have your request. Nothing is credited until the item is inspected.',
    heading: 'Exchange request received',
    lede: `We have your exchange request for order #${order.number}.`,
    sections: [
      paragraph('Our team will review it and let you know whether it is approved. If it is, we will arrange collection of the item.'),
      paragraph('GEMIES store coins are credited to your wallet only after the returned item reaches us and passes inspection. Nothing has been credited yet.'),
    ],
    cta: {label: 'View your exchanges', href: `${origin}/account`},
    note: 'GEMIES does not offer cash refunds through the exchange process. Approved exchanges are credited as store coins, which can be spent on GEMIES.',
  }),

  /** An exchange changed state. The coin figure is only present once credited. */
  exchange_update: ({order, origin, data}) => {
    const status = String(data?.status ?? '').replace(/_/g, ' ');
    const credited = data?.status === 'coins_credited' && data?.coins;
    return {
      subject: `Exchange ${status} — order #${order.number}`,
      preheader: credited ? `${data.coins} GEMIES coins are now in your wallet.` : `Your exchange is now ${status}.`,
      heading: credited ? 'Your coins are ready' : `Exchange ${status}`,
      lede: credited
        ? `${data.coins} GEMIES coins have been added to your wallet for order #${order.number}.`
        : `Your exchange request for order #${order.number} is now ${status}.`,
      sections: [
        ...(credited
          ? [paragraph('You can spend them on your next GEMIES order. Coins are redeemable only on GEMIES and cannot be withdrawn as cash.')]
          : []),
        ...(data?.note ? [paragraph(`Note from our team: ${data.note}`)] : []),
      ],
      cta: {label: credited ? 'Open your wallet' : 'View your exchanges', href: `${origin}/account`},
      note: 'Approved exchanges are credited as GEMIES store coins. We do not issue cash refunds through the exchange process.',
    };
  },

  reset: ({url}) => ({
    subject: 'Reset your GEMIES password',
    preheader: 'This reset link expires in one hour and can be used once.',
    heading: 'Reset your password',
    lede: 'Use the link below to choose a new password.',
    sections: [
      paragraph('This link can be used once and expires one hour after it was requested. Setting a new password signs you out on every device.'),
    ],
    cta: {label: 'Choose a new password', href: url},
    note: 'If you did not request a password reset, ignore this email — your current password remains unchanged. We never ask for your password by email.',
  }),

  password_changed: ({origin, when}) => ({
    subject: 'Your GEMIES password was changed',
    preheader: 'If this was not you, act now.',
    heading: 'Your password was changed',
    lede: 'This is a security notification, not a request.',
    sections: [
      rows([['Changed at', when]]),
      paragraph('For your protection, every signed-in device has been signed out. You will need to sign in again with the new password.'),
      paragraph('If you did not make this change, reset your password immediately and contact us.'),
    ],
    cta: {label: 'Reset your password', href: `${origin}/forgot`},
  }),

  // ----------------------------------------------------------------- order
  // Sent only after the backend has verified a capture with Razorpay.
  paid: ({order, origin}) => ({
    subject: `Order confirmed — #${order.number}`,
    preheader: `We have received your payment of ${money(order.total, order.currency)}.`,
    heading: 'Your order is confirmed',
    lede: `Thank you, ${firstName(order)}. Your payment has been received and verified.`,
    sections: [
      orderMeta(order),
      orderLines(order),
      orderTotals(order),
      address({title: 'Delivery address', lines: addressLines(order.address)}),
      paragraph('We will email you again as soon as your parcel is on its way.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  invoice: ({order, origin}) => ({
    subject: `Invoice ${order.invoice?.number || ''} for order #${order.number}`.trim(),
    preheader: 'Your invoice is attached as a PDF.',
    heading: 'Your invoice',
    lede: `Invoice ${order.invoice?.number || ''} for order #${order.number}.`.trim(),
    sections: [
      orderMeta(order),
      orderTotals(order),
      paragraph('The full invoice is attached to this email as a PDF. You can also download it from your order page at any time, after signing in.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  cancelled: ({order, origin}) => ({
    subject: `Order #${order.number} cancelled`,
    preheader: 'No payment was taken.',
    heading: 'Your order was cancelled',
    lede: `Order #${order.number} has been cancelled and the reserved items released.`,
    sections: [
      orderMeta(order),
      paragraph('This happens when a payment was not completed within the reservation window, or when the order was cancelled before payment. No money was taken.'),
      paragraph('The items are back in stock, so you are welcome to order again.'),
    ],
    cta: {label: 'Return to the shop', href: `${origin}/shop`},
  }),

  // --------------------------------------------------------------- payment
  payment_failed: ({order, origin, reason}) => ({
    subject: `Payment could not be completed — order #${order.number}`,
    preheader: 'Your order is saved and you can try again.',
    heading: 'Your payment did not go through',
    lede: `The payment for order #${order.number} was not completed.`,
    sections: [
      orderMeta(order),
      ...(reason ? [panel({title: 'Reason given by the bank', value: reason})] : []),
      paragraph('Nothing has been charged. Your order is held for a short while, so you can retry the payment from your order page.'),
    ],
    cta: {label: 'Retry payment', href: orderUrl(order, origin)},
    note: 'If the payment keeps failing, your bank or card issuer can tell you why. We never see your full card details.',
  }),

  // ---------------------------------------------------------------- refund
  refund_started: ({order, origin, amount}) => ({
    subject: `Refund initiated for order #${order.number}`,
    preheader: 'Your refund is on its way back to you.',
    heading: 'Your refund has been initiated',
    lede: `We have asked your bank to return ${money(amount ?? order.total, order.currency)}.`,
    sections: [
      orderMeta(order),
      rows([['Refund amount', money(amount ?? order.total, order.currency)]]),
      paragraph('Refunds are returned to the original payment method. Banks usually take five to seven working days to show it on your statement.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  refunded: ({order, origin, amount}) => ({
    subject: `Refund completed for order #${order.number}`,
    preheader: 'Your refund has been settled.',
    heading: 'Your refund is complete',
    lede: `${money(amount ?? order.total, order.currency)} has been returned to your original payment method.`,
    sections: [
      orderMeta(order),
      rows([['Refund amount', money(amount ?? order.total, order.currency)]]),
      paragraph('If it has not appeared on your statement after seven working days, contact your bank quoting the order number above.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  partially_refunded: ({order, origin, amount}) => ({
    subject: `Partial refund completed for order #${order.number}`,
    preheader: 'Part of your order has been refunded.',
    heading: 'A partial refund is complete',
    lede: `${money(amount ?? 0, order.currency)} has been returned to your original payment method.`,
    sections: [
      orderMeta(order),
      rows([['Refunded now', money(amount ?? 0, order.currency)], ['Order total', money(order.total, order.currency)]]),
      paragraph('The remainder of your order is unaffected.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  refund_failed: ({order, origin}) => ({
    subject: `Refund needs attention — order #${order.number}`,
    preheader: 'We are following this up for you.',
    heading: 'Your refund needs attention',
    lede: `The refund for order #${order.number} was not accepted by the bank.`,
    sections: [
      orderMeta(order),
      paragraph('This usually means the original payment method can no longer receive a refund. Our team has been notified and will contact you about an alternative.'),
      paragraph('You do not need to do anything right now.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  // -------------------------------------------------------------- shipping
  shipment_created: ({order, origin}) => ({
    subject: `Preparing order #${order.number} for dispatch`,
    preheader: 'A courier booking has been created for your order.',
    heading: 'We are preparing your order',
    lede: `Order #${order.number} has been booked with our courier.`,
    sections: [
      shipmentRows(order),
      paragraph('You will receive a tracking number as soon as the courier assigns one.'),
    ],
    cta: {label: 'View your order', href: orderUrl(order, origin)},
  }),

  awb: ({order, origin}) => ({
    subject: `Tracking is ready for order #${order.number}`,
    preheader: `Tracking number ${order.shipment?.awb || ''}`.trim(),
    heading: 'Your tracking number is ready',
    lede: 'You can follow your parcel from here on.',
    sections: [
      shipmentRows(order),
      paragraph('Tracking can take a few hours to show its first scan after the number is issued.'),
    ],
    cta: order.shipment?.tracking_url
      ? {label: 'Track your parcel', href: order.shipment.tracking_url}
      : {label: 'View your order', href: orderUrl(order, origin)},
  }),

  /** Every post-dispatch status change, worded by stage. */
  tracking: ({order, origin, stage}) => {
    const copy = STAGE_COPY[stage] ?? STAGE_COPY.update;
    return {
      subject: copy.subject(order),
      preheader: `${order.shipment?.status || 'Update'} — order #${order.number}`,
      heading: copy.heading,
      lede: copy.lede,
      sections: [
        shipmentRows(order),
        ...(stage === 'delivered'
          ? [paragraph('If anything is not right with your order, reply to this email within 7 days and we will put it right.')]
          : []),
        ...(stage === 'exception'
          ? [paragraph('The courier will usually try again. If it cannot be delivered, the parcel returns to us and we will refund you automatically.')]
          : []),
        ...(stage === 'cancelled'
          ? [paragraph('If you were expecting this parcel, contact us and we will re-book it.')]
          : []),
      ],
      cta: order.shipment?.tracking_url
        ? {label: 'Track your parcel', href: order.shipment.tracking_url}
        : {label: 'View your order', href: orderUrl(order, origin)},
    };
  },

  // --------------------------------------------------------------- contact
  contact_ack: ({name, subject: enquirySubject}) => ({
    subject: 'We have received your message',
    preheader: 'Our team will reply shortly.',
    heading: 'Thank you for getting in touch',
    lede: `We have your message, ${String(name || '').split(' ')[0] || 'there'}, and will reply as soon as we can.`,
    sections: [
      rows([['Subject', enquirySubject || 'General enquiry']]),
      paragraph('We usually reply within one working day. There is no need to send your message again.'),
    ],
    note: 'This is an automatic acknowledgement. Replies to this address reach our team.',
  }),

  /** The enquiry itself, to the business inbox. */
  contact_enquiry: ({name, email, subject: enquirySubject, message, orderNumber}) => ({
    subject: `Contact form: ${enquirySubject || 'General enquiry'}`,
    preheader: `From ${name} <${email}>`,
    heading: 'New contact enquiry',
    lede: 'Submitted through the website contact form.',
    sections: [
      rows([
        ['Name', name],
        ['Email', email],
        ['Subject', enquirySubject || 'General enquiry'],
        ...(orderNumber ? [['Order number', orderNumber]] : []),
      ]),
      divider(),
      paragraph(message),
    ],
    note: 'Reply directly to this email to answer the customer.',
  }),

  // ----------------------------------------------------------------- admin
  // Operator notifications. These go to ADMIN_NOTIFICATION_EMAIL and are the
  // only emails that may name internal state.
  admin_order: ({order, origin}) => ({
    subject: `New paid order #${order.number} — ${money(order.total, order.currency)}`,
    preheader: `${order.items.length} item(s), ${money(order.total, order.currency)}`,
    heading: `New paid order #${order.number}`,
    lede: 'Payment has been verified and captured.',
    sections: [
      rows([
        ['Order', `#${order.number}`],
        ['Total', money(order.total, order.currency)],
        ['Items', String(order.items.reduce((n, i) => n + i.quantity, 0))],
        ['Customer', order.email],
      ]),
      orderLines(order),
      address({title: 'Ship to', lines: addressLines(order.address)}),
    ],
    cta: {label: 'Open in admin', href: `${origin}/admin/orders` },
  }),

  admin_payment_attention: ({order, origin, detail}) => ({
    subject: `Payment needs attention — order #${order.number}`,
    heading: `Payment needs attention on #${order.number}`,
    lede: detail || 'A payment on this order requires manual review.',
    sections: [rows([
      ['Order', `#${order.number}`],
      ['Order status', order.status],
      ['Payment status', order.payment_status],
      ['Total', money(order.total, order.currency)],
    ])],
    cta: {label: 'Open in admin', href: `${origin}/admin/orders`},
  }),

  admin_cancelled: ({order, origin}) => ({
    subject: `Order #${order.number} cancelled`,
    heading: `Order #${order.number} was cancelled`,
    lede: 'The reservation was released and stock returned.',
    sections: [rows([
      ['Order', `#${order.number}`],
      ['Total', money(order.total, order.currency)],
      ['Customer', order.email],
    ])],
    cta: {label: 'Open in admin', href: `${origin}/admin/orders`},
  }),

  // `phase` rather than `stage`: `stage` already means a shipping stage on the
  // tracking template, and one payload field meaning two different things is
  // how a wrong subject line gets shipped.
  admin_refund: ({order, origin, phase, amount}) => ({
    subject: `Refund ${phase} — order #${order.number}`,
    heading: `Refund ${phase} on #${order.number}`,
    lede: `${money(amount ?? order.total, order.currency)} on order #${order.number}.`,
    sections: [rows([
      ['Order', `#${order.number}`],
      ['Refund amount', money(amount ?? order.total, order.currency)],
      ['Payment status', order.payment_status],
      ['Customer', order.email],
    ])],
    cta: {label: 'Open in admin', href: `${origin}/admin/orders`},
  }),

  /**
   * An integration failure an operator has to act on.
   *
   * `detail` is a short internal description. It is never shown to a customer,
   * and the sender is responsible for keeping credentials and provider bodies
   * out of it.
   */
  admin_error: ({origin, area, detail, reference}) => ({
    subject: `Action required: ${area} needs attention`,
    heading: `${area} needs attention`,
    lede: detail || 'An integration reported a problem that needs manual reconciliation.',
    sections: [rows([
      ['Area', area],
      ...(reference ? [['Reference', reference]] : []),
    ].filter(Boolean))],
    cta: {label: 'Open the admin dashboard', href: `${origin}/admin`},
  }),
};

/**
 * Renders a template to `{subject, html, text}`.
 *
 * Throws on an unknown name rather than sending a blank email: an unknown
 * template means a caller typo, and a retry will not fix it.
 */
export function renderEmail(name, data = {}) {
  const template = templates[name];
  if (!template) throw new Error(`Unknown email template: ${name}`);
  const {subject, ...description} = template(data);
  const {html, text} = layout({...description, footerAddress: data.businessAddress});
  return {subject, html, text};
}

export const templateNames = Object.keys(templates);
