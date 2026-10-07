require_relative 'models'
require_relative 'catalog'
require_relative 'pricing'

class Cart
  def initialize
    @items = []
  end

  def add(pid, qty)
    product = find_product(pid)
    raise KeyError, pid if product.nil?
    @items.push(CartItem.new(product, qty))
  end

  def total(tier)
    cart_total(@items, tier)
  end
end
