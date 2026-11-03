/**
 * Per-line billing figures for an invoice.
 *
 * The order stores one discount and one tax amount for the whole order --
 * `totals()` computes the coupon on the subtotal and the tax on the discounted
 * subtotal, not per item. An invoice has to show a taxable value and a tax
 * amount on every line, so those two figures are allocated across the lines
 * here.
 *
 * The hard requirement is that the columns ADD UP. An invoice whose lines sum
 * to one paise less than its total is a broken document, so every share is
 * floored and the entire rounding remainder is then placed on the largest
 * line. That guarantees:
 *
 *   sum(line.discount) === order.discount
 *   sum(line.tax)      === order.tax
 *   sum(line.total)    === order.subtotal - order.discount + order.tax
 *
 * which the test suite asserts over randomised baskets.
 *
 * Pure, and in its own module, so it can be tested without a database.
 */

/**
 * @param {{subtotal:number,discount:number,tax:number,tax_bps:number}} order
 * @param {Array<{unit_price:number,quantity:number}>} items
 */
export function allocateInvoiceLines(order, items) {
  const gross = items.map((item) => item.unit_price * item.quantity);
  const subtotal = gross.reduce((a, b) => a + b, 0);

  // Degenerate but possible: a zero-value basket cannot carry a share of
  // anything, so everything is zero rather than a division by zero.
  if (subtotal <= 0) {
    return {
      lines: items.map((item, i) => line(item, gross[i], 0, 0, 0)),
      subtotal: 0, discount: 0, tax: 0, net: 0,
    };
  }

  const discounts = gross.map((value) => Math.floor((order.discount * value) / subtotal));
  settle(discounts, order.discount, gross);

  const taxable = gross.map((value, i) => value - discounts[i]);
  const taxBase = taxable.reduce((a, b) => a + b, 0);
  const taxes = taxable.map((value) => (taxBase > 0 ? Math.floor((order.tax * value) / taxBase) : 0));
  settle(taxes, order.tax, taxable);

  const lines = items.map((item, i) => line(item, gross[i], discounts[i], taxable[i], taxes[i]));
  return {
    lines,
    subtotal,
    discount: discounts.reduce((a, b) => a + b, 0),
    tax: taxes.reduce((a, b) => a + b, 0),
    net: lines.reduce((sum, l) => sum + l.total, 0),
  };
}

/**
 * Pushes the rounding remainder onto the largest line.
 *
 * Flooring every share leaves a few paise unallocated. Spreading them a paise
 * at a time across lines would make two identical lines show different tax,
 * which looks like a mistake on a printed invoice; putting the whole remainder
 * on the biggest line is both less visible and still exact.
 */
function settle(shares, target, weights) {
  const allocated = shares.reduce((a, b) => a + b, 0);
  const remainder = target - allocated;
  if (remainder === 0) return;
  let biggest = 0;
  for (let i = 1; i < weights.length; i += 1) if (weights[i] > weights[biggest]) biggest = i;
  shares[biggest] += remainder;
}

function line(item, gross, discount, taxable, tax) {
  return {
    name: item.name,
    sku: item.sku,
    hsn: item.hsn ?? null,
    size: item.size,
    color: item.color,
    quantity: item.quantity,
    unitPrice: item.unit_price,
    gross,
    discount,
    taxable,
    tax,
    // What the line contributes to the amount due: taxable value plus its tax.
    total: taxable + tax,
  };
}

/**
 * The tax rate to print, as basis points.
 *
 * Prefers the rate recorded on the order. Falls back to deriving it from the
 * recorded amounts for orders placed before that column existed, and reports
 * which of the two it is so the invoice never implies a precision it does not
 * have.
 */
export function taxRateFor(order) {
  if (order.tax_bps > 0) return {bps: order.tax_bps, derived: false};
  if (order.tax <= 0) return {bps: 0, derived: false};
  const base = order.subtotal - order.discount;
  return {bps: base > 0 ? Math.round((order.tax * 10000) / base) : 0, derived: true};
}
