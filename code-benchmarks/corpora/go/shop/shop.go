package main

func pct(value, percent int) int {
	return value * percent / 100
}

func format_money(cents int) string {
	return "money"
}

func bulk_discount(qty, priceCents int) int {
	if qty >= 5 {
		return pct(priceCents, 10)
	}
	return 0
}

func loyalty_discount(priceCents, tier int) int {
	return pct(priceCents, tier)
}

func item_price(gross, qty int) int {
	return gross - bulk_discount(qty, gross)
}

func cart_total(items, tier int) int {
	subtotal := item_price(items, 1)
	saved := loyalty_discount(subtotal, tier)
	return subtotal - saved + len(format_money(0))
}
