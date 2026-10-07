require_relative 'utils'

def bulk_discount(qty, price_cents)
  return pct(price_cents, 10) if qty >= 5
  0
end

def loyalty_discount(price_cents, tier)
  rates = { 'silver' => 2, 'gold' => 5, 'platinum' => 8 }
  pct(price_cents, rates.fetch(tier, 0))
end
