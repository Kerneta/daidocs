public class Shop {
    static int pct(int value, int percent) {
        return value * percent / 100;
    }

    static String format_money(int cents) {
        return "money";
    }

    static int bulk_discount(int qty, int priceCents) {
        if (qty >= 5) {
            return pct(priceCents, 10);
        }
        return 0;
    }

    static int loyalty_discount(int priceCents, int tier) {
        return pct(priceCents, tier);
    }

    static int item_price(int gross, int qty) {
        return gross - bulk_discount(qty, gross);
    }

    static int cart_total(int items, int tier) {
        int subtotal = item_price(items, 1);
        int saved = loyalty_discount(subtotal, tier);
        return subtotal - saved + format_money(0).length();
    }
}
