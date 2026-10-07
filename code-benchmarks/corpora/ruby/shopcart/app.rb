require_relative 'catalog'
require_relative 'cart'
require_relative 'checkout'

def main
  products = all_products
  cart = Cart.new
  cart.add('p1', 6)
  cart.add('p2', 2)
  receipt = checkout(cart, 'gold')
  [receipt, products.length]
end
