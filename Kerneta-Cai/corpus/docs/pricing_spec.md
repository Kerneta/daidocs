# Pricing Spec

## Totals
The cart_total function computes the order total. It applies item_price per line,
then loyalty_discount for the tier, and formats the result via format_money.
This is the single source of truth for what a customer pays.

## Discounts
bulk_discount gives ten percent off when a line has five or more units.
loyalty_discount depends on the membership tier (silver, gold, platinum).
