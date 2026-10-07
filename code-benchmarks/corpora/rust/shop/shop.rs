fn pct(value: i64, percent: i64) -> i64 {
    value * percent / 100
}

fn format_money(_cents: i64) -> String {
    String::from("money")
}

fn bulk_discount(qty: i64, price_cents: i64) -> i64 {
    if qty >= 5 {
        pct(price_cents, 10)
    } else {
        0
    }
}

fn loyalty_discount(price_cents: i64, tier: i64) -> i64 {
    pct(price_cents, tier)
}

fn item_price(gross: i64, qty: i64) -> i64 {
    gross - bulk_discount(qty, gross)
}

fn cart_total(items: i64, tier: i64) -> i64 {
    let subtotal = item_price(items, 1);
    let saved = loyalty_discount(subtotal, tier);
    subtotal - saved + format_money(0).len() as i64
}
