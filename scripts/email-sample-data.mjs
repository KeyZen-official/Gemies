// Representative data for rendering email templates outside a real request.
//
// Shared by scripts/email-preview.mjs (writes HTML to disk) and
// scripts/email-doctor.mjs (sends a real one), so a preview and a test send
// show the same thing.
//
// Everything here is obviously fictitious. It is never used by the running
// application: real emails are rendered from the order in the database.

export const sampleOrder = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 1042,
  currency: 'INR',
  created_at: new Date().toISOString(),
  status: 'confirmed',
  payment_status: 'paid',
  subtotal: 249800,
  discount: 20000,
  tax: 11988,
  shipping: 0,
  total: 241788,
  email: 'customer@example.invalid',
  user_id: 'sample-user',
  address: {
    name: 'Arjun Mehta',
    line1: '12 Hill Road',
    line2: 'Flat 4',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400050',
    country: 'India',
    phone: '9876543210',
  },
  items: [
    {name: 'Essential Cotton T-Shirt', size: 'M', color: 'Black', quantity: 2, unit_price: 79900},
    {name: 'Camp Collar Shirt', size: 'L', color: 'White', quantity: 1, unit_price: 149900},
  ],
  invoice: {number: 'SZ-00001042'},
  shipment: {
    courier: 'Delhivery',
    awb: '1234567890',
    status: 'In Transit',
    tracking_url: 'https://example.com/track/1234567890',
  },
};

/** Everything any template might read, for a given link base. */
export function sampleData(origin) {
  return {
    origin,
    businessAddress: process.env.BUSINESS_ADDRESS || '',
    order: sampleOrder,
    name: 'Arjun Mehta',
    // Obviously not a real token, and it is not one: nothing here can verify
    // an account or reset a password.
    url: `${origin}/verify?token=sample-token-not-a-real-one`,
    when: `${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    amount: 50000,
    email: 'customer@example.invalid',
    subject: 'Sizing question',
    message: 'Is the medium true to size? I am usually a 40 inch chest and between sizes.',
    orderNumber: '1042',
    area: 'Courier assignment',
    detail: 'The courier did not return an AWB for this shipment.',
    reference: 'Order #1042',
    // Shipping stage for `tracking`, refund phase for `admin_refund`.
    stage: 'delivered',
    phase: 'completed',
  };
}
