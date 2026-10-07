import { pct } from "./utils.js";

export function bulk_discount(qty, price_cents) {
  if (qty >= 5) {
    return pct(price_cents, 10);
  }
  return 0;
}

export function loyalty_discount(price_cents, tier) {
  const rates = { silver: 2, gold: 5, platinum: 8 };
  return pct(price_cents, rates[tier] || 0);
}
