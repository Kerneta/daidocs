export function format_money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

export function pct(value, percent) {
  return Math.round((value * percent) / 100);
}
