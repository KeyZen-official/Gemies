// Shared between the client Info component and the /info/[page] server
// metadata, so route titles and page headings can never drift apart.
export const infoTitles = {
  privacy: 'Privacy Policy',
  terms: 'Terms & Conditions',
  returns: 'Returns & Refunds',
  shipping: 'Shipping & Delivery',
  contact: 'Contact Us',
  about: 'About Gemies',
  'how-to-order': 'How to Order',
};

// Policy pages are authored by the store owner in admin settings.
export const infoSettingKeys = {
  privacy: 'privacy_policy',
  terms: 'terms',
  returns: 'returns_policy',
};

// Fixed editorial copy that does not depend on store settings.
export const infoBodies = {
  shipping: 'Delivery is currently supported within India. Availability depends on the destination PIN code and courier serviceability. Check delivery on a product page. After fulfillment, tracking information appears in your account. Shipping charges are shown at checkout.',
  about: 'Gemies brings together T-shirts, shirts and bottom wear in one thoughtfully selected collection of men’s essentials. Explore clean cuts, honest fabrics, and pieces for your everyday rotation.',
  'how-to-order': 'Create an account and verify your email. Choose a product, select your size, and add it to your bag. Enter your delivery address at checkout and complete secure payment. Your account shows your payment status, invoice, and delivery updates.',
};

export const contactBody = (supportEmail) =>
  supportEmail
    ? `For product, order, or delivery assistance, contact ${supportEmail}. Please include your order number when applicable.`
    : 'The store has not published a support email yet. Please check back before placing an order.';
