/**
 * Which coins have expired, worked out from the ledger alone.
 *
 * Coins sit in one balance and are fungible, so "these coins are 90 days old"
 * is not a fact stored anywhere -- it has to be derived. This applies debits
 * against credits in the order they happened (FIFO), which leaves every credit
 * with an unspent remainder, and then expires the remainder of any credit
 * older than the configured window.
 *
 * FIFO rather than LIFO deliberately: the oldest coins are the ones closest to
 * expiring, so spending them first is what a customer would expect and it
 * expires the least. Under LIFO a customer who spends regularly would still
 * watch their oldest coins expire, which is the opposite of helpful.
 *
 * Previous expiry debits are ordinary debits here, so coins already expired
 * are already consumed and cannot be expired twice.
 *
 * Pure, and in its own module, so the accounting can be tested without a
 * database or a clock.
 */

/**
 * @param {Array<{id:string,direction:'credit'|'debit',coins:number,created_at:string|Date}>} transactions
 *        the customer's whole ledger, oldest first
 * @param {{expiryDays:number, now?:Date}} options
 */
export function expiredCoins(transactions, {expiryDays, now = new Date()}) {
  if (!(expiryDays > 0)) return {coins: 0, lots: [], lastLotId: null};

  // Credits become lots with an unspent remainder; debits are a pool to apply.
  const lots = [];
  let toConsume = 0;
  for (const row of transactions) {
    if (row.direction === 'credit') {
      lots.push({id: row.id, coins: row.coins, remaining: row.coins, createdAt: new Date(row.created_at)});
    } else {
      toConsume += row.coins;
    }
  }

  // Oldest first. A debit does not say which credit it drew on, so this is the
  // accounting convention, not a recorded fact -- stated plainly because it
  // determines whose coins expire.
  lots.sort((a, b) => a.createdAt - b.createdAt);
  for (const lot of lots) {
    if (toConsume <= 0) break;
    const taken = Math.min(lot.remaining, toConsume);
    lot.remaining -= taken;
    toConsume -= taken;
  }

  const cutoff = new Date(now.getTime() - expiryDays * 86400000);
  const stale = lots.filter((lot) => lot.remaining > 0 && lot.createdAt <= cutoff);

  return {
    coins: stale.reduce((sum, lot) => sum + lot.remaining, 0),
    lots: stale.map((lot) => ({id: lot.id, coins: lot.remaining, creditedAt: lot.createdAt.toISOString()})),
    // The newest lot in this batch. Used as the idempotency key for the expiry
    // debit: recomputing the same batch yields the same key and so writes
    // nothing twice, while a later batch has a different newest lot and is
    // therefore a different, allowed debit.
    lastLotId: stale.length ? stale[stale.length - 1].id : null,
  };
}

/**
 * When a customer's next coins will expire, for display.
 *
 * Returns null when nothing is due to expire, so the wallet page can stay
 * quiet rather than showing an empty warning.
 */
export function nextExpiry(transactions, {expiryDays, now = new Date()}) {
  if (!(expiryDays > 0)) return null;
  const lots = [];
  let toConsume = 0;
  for (const row of transactions) {
    if (row.direction === 'credit') lots.push({coins: row.coins, remaining: row.coins, createdAt: new Date(row.created_at)});
    else toConsume += row.coins;
  }
  lots.sort((a, b) => a.createdAt - b.createdAt);
  for (const lot of lots) {
    if (toConsume <= 0) break;
    const taken = Math.min(lot.remaining, toConsume);
    lot.remaining -= taken;
    toConsume -= taken;
  }
  const live = lots.filter((lot) => lot.remaining > 0);
  if (!live.length) return null;
  const soonest = live[0];
  const at = new Date(soonest.createdAt.getTime() + expiryDays * 86400000);
  return {
    coins: soonest.remaining,
    at: at.toISOString(),
    days: Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 86400000)),
  };
}
