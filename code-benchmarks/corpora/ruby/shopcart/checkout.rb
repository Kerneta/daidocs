require_relative 'pricing'
require_relative 'utils'

def checkout(cart, tier)
  net, human = cart.total(tier)
  label = format_money(net)
  "TOTAL #{label}"
end
