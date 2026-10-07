require_relative 'models'

CATALOG = [
  Product.new('p1', 'Notebook', 450),
  Product.new('p2', 'Pen', 120),
  Product.new('p3', 'Backpack', 3800)
]

def find_product(pid)
  CATALOG.each { |prod| return prod if prod.pid == pid }
  nil
end

def all_products
  CATALOG.dup
end
