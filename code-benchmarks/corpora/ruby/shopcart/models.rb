class Product
  def initialize(pid, name, price_cents)
    @pid = pid
    @name = name
    @price_cents = price_cents
  end
end

class CartItem
  def initialize(product, qty)
    @product = product
    @qty = qty
  end

  def line_cents
    @product.price_cents * @qty
  end
end
