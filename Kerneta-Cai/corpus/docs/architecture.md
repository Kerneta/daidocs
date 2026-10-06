# Architecture

## Overview
The Cart class in the cart module ties the catalog and pricing modules together.
Adding an item calls find_product to resolve the product.

## Checkout
The checkout flow calls cart_total to price the basket and format_money to render it.
