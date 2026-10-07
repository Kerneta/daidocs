require_relative 'discounts'
require_relative 'utils'

def item_price(cart_item)
  gross = cart_item.line_cents
  saved = bulk_discount(cart_item.qty, gross)
  gross - saved
end

def cart_total(items, tier)
  subtotal = 0
  items.each { |it| subtotal += item_price(it) }
  saved = loyalty_discount(subtotal, tier)
  net = subtotal - saved
  [net, format_money(net)]
end
