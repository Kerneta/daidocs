def format_money(cents)
  "$%.2f" % (cents / 100.0)
end

def pct(value, percent)
  (value * percent / 100.0).round
end
