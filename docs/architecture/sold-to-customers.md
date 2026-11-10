# Sold to customers, and shown in the web shop

Two separate questions, kept apart on purpose.

## 1. Is a product sold at all? (the business classification)

A **business classification** (Products & inventory) has the answer **Sold to customers**. It is not about the web shop: it applies at every point where a product is put on a sale document.

| Place | Rule |
|---|---|
| Web shop (catalogue, search, cart, wishlist, reviews, checkout) | Only products that are sold. |
| Quotes and quote templates | A product that is not sold cannot be added. |
| Orders from any channel (web, staff, point of sale, on account) and so the invoices made from them | Refused with "is not sellable and cannot be ordered", unless the line came from a quote already made. |
| Price books | Only products that are sold are listed. |
| Checkout packaging | Must be sold. |

Some companies sell raw materials and others never do, so no classification is assumed to be one or the other: the company decides, per classification.

A product also needs a selling price to be sold: a service without a price is never sold (delivery is charged from the delivery rates), and goods in a classification that has just started selling stay unsold until they are priced.

### How the products follow the classification

Each product holds a copy of the answer (`products.is_sellable`) so every query can filter on it. **The database keeps the copy in step**: `item_types_cascade_trg` (migration `0155`) updates the classification's products in the same transaction whenever the answer changes, whatever edited the classification (the screen, an import, a script). Nobody sets the product's copy by hand: a product saved from the browser follows its classification as it is now, and an answer sent by the browser is ignored.

* Turning a classification **off** stops all its products being sold. It is refused while any of its products is offered as checkout packaging (the packaging must be sold); stop offering it as packaging first. The database refuses it too.
* Turning it **on** sells the products that have a selling price; the others wait for one.
* Before saving, the screen asks the server what would change and shows the person the number of products ("12 products will stop being sold …"); nothing is applied until they confirm. Quotes already made keep their lines; orders and invoices already made are not touched.
* A classification's name and code are read live by the products, so a rename reaches them at once.

Migration `0155` also repaired products that were already out of step. A product that became sold only through that repair is set not to show in the web shop, so nothing appears online by surprise.

## 2. Is a sold product shown in the web shop? (the product)

`products.show_on_web_shop` (default on), set on the product form: **Show in the web shop**. Turn it off to sell a product only through quotes and staff orders. It does not belong on the classification, because two products of one classification can be sold differently.

The web shop (catalogue, product page, search, sitemap, cart, wishlist, reviews, checkout packaging, basket and checkout) shows a product only if it is active, sold and shown. A web order for a product that is not shown is refused; a quote or staff order for it is not.
