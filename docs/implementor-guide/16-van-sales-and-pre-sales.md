# Guide 16: Van Sales & Pre-Sales (`/admin/settings/sales/van-sales`, and the Van sales screens under Sales)

> **What is built so far.** This guide describes what a company can use today: **the Van sales settings screen** (which of the two modes are on, and the rules every van day follows), **Vans**, **Sales reps** and **Routes** (set up who sells, from what, and to whom), **Van days** (planning a day from a route and a date) **Loading** (making up a load, sending it and signing for it) **Running the day** (the rep sends the day out and works the visits) and **Selling from the van** (cash and credit sales at a visit). Pre-sell orders, loading, selling, collections, the day-end count, the rep phone app, offline selling and reports are built one slice at a time; each adds its screens to this guide in the same change. The full plan is in `docs/architecture/van-sales.md`. Nothing here is switched on for a company until its administrator switches it on.

## 1. Executive Overview & Commercial Value Proposition

### Operational Problems Solved
- **Stock and cash that are away from the company all day.** A van leaves in the morning with stock worth hundreds of thousands of shillings and a rep who sells with no supervisor beside them. Van sales signs the stock and the float out in the morning, counts both back at night, and turns every difference into a named, approved, recorded item instead of an argument.
- **Two ways of selling, one system.** *Van sell* is the rep who sells from the van and hands the goods over on the spot. *Pre-sell* is the rep who takes an order and the goods follow later. Most distributors do both; the system runs either alone or both together on the same day.
- **Unplanned loading.** The load for tomorrow is worked out from the route's usual stock levels and the orders already taken for tomorrow's customers, so vans leave full of what will sell and what is owed.
- **Visits that cannot be seen.** Every call on a customer is recorded with its time, its result and, when no sale was made, the reason.
- **No signal on the road.** Reps keep selling and bringing orders in with no connection, and everything is taken in safely when the signal returns (a later slice; its own switch and its own permission).

### Target Client Profiles
Beverage, water, bread and dairy distributors; gas and fuel dealers; FMCG wholesalers selling to kiosks and shops; agro-input and feed suppliers; any company with outside reps who visit customers on a round.

### Commercial Sales Pitch & Talk Track
> "Your reps already sell outside the shop. What you cannot see today is what is on the van, what cash they hold, and which customers they actually visited. With van sales, the van is a stock location with its own till: you load it against a signed sheet, the rep sells with the customer's own prices and your discount rules, the system takes every shilling through the same till and receipts your counters use, and at the end of the day the van and the cash are counted back and any difference needs a reason and, above your limit, a second person. Orders taken on the road reserve stock the same moment, and tomorrow's load already includes them."

### Measurable ROI & Safeguards
Shrinkage visible per van, per rep and per day; fewer disputed shortages; cash differences found the same evening; more calls per day; fewer stock-outs on the van; orders delivered on the customer's next round without a separate delivery cost. Every sale on a van carries a KRA-signed receipt like any counter sale.

## 2. Prerequisites & Configuration Sequence

1. **Branches** and **stock locations** ([Guide 13](13-settings-branches-numbering-and-kra-etims.md), [Guide 05](05-products-catalog-and-inventory-control.md)).
2. **Registers** (tills) and **payment methods** that pay into a cash or bank account ([Guide 11](11-banking-cash-and-payment-gateways.md)); a van's till is one of them.
3. **Customers** with their price lists, credit limits and blocks ([Guide 03](03-sales-quotes-and-customer-orders.md), [Guide 04](04-pricing-engine-promotions-and-margins.md)).
4. **Delivery vehicles** if the company uses the vehicle register ([Guide 06](06-delivery-logistics-and-field-dispatch.md)).
5. **Van sales settings** (this guide, section 4): switch on the modes the company uses.
6. **Vans**, then **Sales reps**, then **Routes**, then **Van days** and loading (this guide, sections 4 to 6); loading also needs **stock by location** switched on under Inventory, and a warehouse or store to load from: a route needs a branch, and may name a van and a rep, so make those first. A route's customers must already be on the customer list, and the products of its usual stock must be kept in stock. Permissions: see section 5.

**Required permission to open the settings:** *Van sales: settings*. Held by Super Admin and Administrator by default.

## 3. Module & Sub-Module Architecture

**Mental model.** A **van** is a stock location with its own till. A **rep** sells from it. A **route** is the round of customers. A **van day** is one rep's one outing: loaded in the morning, out, back, counted, closed. A **visit** is one call on one customer. **Pre-sold orders** are taken on visits and handed over from a van day or a normal delivery run.

**Upstream:** products and prices, customers and credit, stock locations, registers and payment methods. **Downstream:** the till's shifts and Z reports, the sales ledger and receipts with KRA signing, stock movements and the books' stock value, delivery runs for pre-sold orders, and customer statements for credit sold and money collected.

**Sub-modules (built as slices):** Settings (built), Vans (built), Sales reps (built), Routes (built), Van days, Loading and Running the day (built) and the load planner, the rep's phone app, Day-end count and reconciliation, Offline selling for reps, Reports.

## 4. Interface-by-Interface Walkthrough

### Settings › Sales › Van sales (`/admin/settings/sales/van-sales`)
A single card with these parts, top to bottom:

1. **Status line and chips.** Who last changed it and when ("Never changed: both are off by default" for a new company), and two chips: *Van sell on/off* and *Pre-sell on/off*.
2. **What your reps do.** Two switches, *Van sell* and *Pre-sell*, each with a plain explanation. A company may switch on one or both.
3. **Customers not on the route.** Two choices: a rep **may** sell to a customer who is not on the route (recorded as off-route), or **may sell only** to the route's customers.
4. **Stock that is missing from a van.** Two choices: **charge the rep** for what is missing, or **write it off** as a stock loss.
5. **A second person must decide a shortage worth more than (KES, at cost).** An amount. 0 means every shortage must be decided by a second person.
6. **Stock may stay on the van overnight.** A switch. Off: every van is unloaded and counted every day. On: the rest stays, signed for by the rep, and is counted when the day closes.
7. **Where the rep is when visiting.** Two choices: **record** how far the rep was from the customer and never stop the sale, or **require** the rep to be near the customer to start a visit. When *require* is chosen, a field appears: **how near counts as at the customer (metres)**.
8. **Reason** (a list the company controls) and **Save**; **Undo** appears once something changed.

### Sales › Van sales (`/admin/van-sales`)
The home of the module (needs *Van sales: read*). It shows, when van sales is **switched off** for the company, a card saying so with a button to switch it on in Settings (for people who hold *Van sales: settings*; others are told to ask an administrator); when it is on, two chips (*Van sell on/off*, *Pre-sell on/off*) and a **Change these** link. Below are four cards, **Van days**, **Routes**, **Vans** and **Sales reps**, each with its counts (in use, stopped; selling, paused, ended) and a button that opens its list. Vans and reps can be set up while the modes are still off.

### Sales › Van sales › Vans (`/admin/van-sales/vans`)
A list of the company's vans, a page at a time, by name.
1. **Search box** (name or stock code) and the **In use / Stopped / All** buttons (In use is shown first).
2. **Add a van** button (needs *Van sales: manage*) opens the **New van** form.
3. **Each van** shows its name, a status chip (*In use* or *Stopped*), *Till open* when a shift is open on its till, its branch, its **stock place** code (such as `VAN-KDA-123X`), its vehicle, the account its till cash is kept in, its cash limit, and how many products are on the van. A stopped van also shows **Stopped because:** and the reason typed.
4. **Buttons on a van:** **Change**, **Stop this van** (for a van in use); **Use again** (for a stopped one).
5. **Show more** loads the next page. An empty list says so and, for a new company, says to add the first van.

### Sales › Van sales › Sales reps (`/admin/van-sales/reps`)
A list of the people who sell outside, a page at a time, by name.
1. **Search box** (name, email or phone) and the **Selling / Paused / Ended / All** buttons.
2. **Add a sales rep** button (needs *Van sales: manage*) opens the **New sales rep** form.
3. **Each rep** shows their name, a status chip (*Selling*, *Paused* or *Ended*), what they do (*Van sell*, *Pre-sell*), email, phone, home branch, the most discount they may give, the credit they may give in a day, whether they may change a price, and, for a paused or ended rep, **Paused because:** or **Ended because:** with the reason typed.
4. **Buttons on a rep:** **Change** (not for an ended rep), **Pause** (selling reps), **End work as a rep** (selling or paused reps), **Put back to work** (paused or ended reps).

### Sales › Van sales › Routes (`/admin/van-sales/routes`)
A list of the company's routes, a page at a time, by name.
1. **Search box** (name or code) and the **In use / Stopped / All** buttons.
2. **Add a route** button (needs *Van sales: manage*, and at least one mode switched on) opens the **New route** form. When both modes are off, a notice says so and the button is not offered.
3. **Each route** shows its name and code, a chip for *In use* or *Stopped* and one for what it is for (*Van sell*, *Pre-sell*, *Van sell and pre-sell*), its branch, how many customers it has, how many products are in its usual stock, and its usual van and rep. A stopped route also shows **Stopped because:**.
4. **Open route** opens the route's own page.

### A route's page (`/admin/van-sales/routes/<route>`)
Four parts, top to bottom. A route that does not exist shows the not-found page.
1. **The route.** Its status and mode, its usual van and rep, and the buttons **Change the route**, **Stop this route** (asks why) or **Use again**.
2. **Customers on this route.** The round, in order, each with its place number, name, town and phone, the days it is visited and how often, any note, and a warning chip if the customer is blocked or no longer in use. Buttons: **Add a customer**; on each customer **Up**, **Down**, **Change days** and **Take off route** (asks once). An empty route says so.
3. **Usual stock of the van.** The products the van should start the day with, each with its quantity and unit, a product search with quantity and **Add to the list**, **Take off** on each line, and **Save the usual stock** (with **Undo** while there are unsaved changes).
4. **Who is due on a day.** A date box, and the customers a rep would visit that day, in the order of the round, with a count such as *Monday: 3 customers due* or *nobody is due*.

### Sales › Van sales › Van days (`/admin/van-sales/days`)
A list of van days, the latest date first, a page at a time.
1. **Search box** (day number, route or rep) and the **Open / Closed / Cancelled / All** buttons (Open is shown first: a day is open until it is closed or cancelled).
2. **Plan a day** button (needs *Van sales: plan* and at least one mode switched on) opens the **Plan a day** form.
3. **Each day** shows its date and number (such as `VDY-26-00000012`), a chip for where it is (*Planned*, *Being loaded*, *Out on the route*, *Back at the depot*, *Being counted*, *Closed*, *Cancelled*) and one for what it is for, the route, the rep, the van, and how many of its visits are done. A cancelled day shows **Cancelled because:**.
4. **Open day** opens the day's own page.

### A van day's page (`/admin/van-sales/days/<day>`)
1. **The day.** Its state, what it is for, the rep and van, a link **Open the route**, and **Cancel this day** (asks why) while the day has not gone out.
2. **Visits.** The customers to visit, in order, each with its place number, name, town and phone, the route's note, a state chip (*To visit*, *At the customer*, *Done*, *Skipped*, *Shop closed*), a warning chip if the customer is blocked or no longer in use, and *Added to this day by hand* where it did not come from the route. While the day is planned or being loaded: **Add a customer**, and on each customer who has not been visited **Up**, **Down** and **Take off the day**.
3. **History.** Everything that has happened to the day, oldest first, each with the time, who did it and, where one was given, the reason.

### Loading, on a van day's page
Below the visits, for a day that has a van (a day that only takes orders has none of this):
1. **Make up the load** (or **Make up a top-up** once the day is out). Shown to people with *Van sales: plan* while the day has no load that is still wanted. **Load from** chooses the warehouse or store (the day's own branch first). The list below is what the route's usual stock suggests: for each product the usual quantity, what is already on the van, what the warehouse has that is not promised to a customer, and how much is **short** when the warehouse cannot give it all. Each line has a quantity to change and **Take off**; **Add a product** adds one that is not in the usual stock. **Ask for the load** makes it up.
2. **Loads.** Each load or top-up shows its number, where it has got to (*Asked for*, *Approved*, *On its way to the van*, *Partly signed for*, *Signed for*, *Cancelled*), where it is from, what was asked, sent and signed for on each line, and who signed and when. The buttons offered are only the next step: **Approve** (where the company wants a second person to), **Send it**, **Sign for the load**, **Call it off**.
3. **On the van now.** What the van holds, from the stock records, with anything already promised.

### Running the day, on a van day's page (the rep's own)
1. **Send the day out.** Shown while the day is planned or being loaded. It says **Ready to go** or **Not ready** and why (for a day with a van: *The van has no stock yet. Make up the load, send it and sign for it before the day goes out.*). The rep counts the **cash into the van's till** (the float, nothing is allowed) and presses **Send the day out**. Anyone else sees where it stands and who sends it out.
2. **Visits, once the day is out.** For each customer the rep has **Arrive** (the phone says where it is), then **Finish: no sale** (asks why), or **Skip** (asks why) for a customer not to be visited today, or **Shop closed** (asks once) if the shop is found shut. A customer can be added on the road (**Add a customer**) where the company allows it. Each visit shows when the rep arrived and how far from the shop, how it ended and why.

### Selling at a visit, on a van day's page (the rep's own)
1. **Sell.** On a visit the rep has arrived at, in a day that sells from a van. The rep adds products from what is **on the van** (search by name or code; only products with stock on the van are offered), types the quantity, and sees the **total** worked out by the system at the customer's own prices. A rep allowed to change prices sees **Price for one**; a rep allowed discounts sees **Discount %** with their limit.
2. **Paid now.** The rep chooses how it is paid (cash, M-Pesa, card), types the amount handed over and, for M-Pesa or card, the reference. The screen says what is still to pay, or the **change to give**. **Complete the sale** is available only when the total is covered.
3. **On account.** A rep allowed to sell on credit also has **On account**: the sale goes on the customer's account within their credit terms and the rep's credit allowance for the day.
4. **Sales** shows what the day has sold, the total, and how it was taken (cash, mobile money, card, on account).
5. **Finish the visit.** A visit with a sale is finished as sold; a visit with no sale is finished with a reason. The two cannot be mixed.

### Taking an order at a visit, on a van day's page (the rep's own)
1. **Take an order.** On a visit the rep has arrived at, in a day whose route takes orders (pre-sell or both) while Pre-sell is switched on. The rep searches any product (not only what is on the van, since the goods come later), types the quantity and, if the customer wants it by a day, **Needed on**. The system works out the total at the customer's own prices; the rep cannot type a price or a discount on an order.
2. **Take the order.** Nothing is paid and nothing leaves the van. The order is an ordinary sales order: it appears under Sales Orders, its stock is held at the warehouse, and it follows the company's normal approval and credit rules.
3. **Sales** on the day lists the order marked *Order* and shows **Orders for later** apart from the money taken, so the day's takings are not overstated.
4. **Finish the visit.** A visit with an order is recorded as *Order taken*; with a sale as well, *Sold and order taken*. A visit with either cannot be finished as no sale.

## 5. Granular Field-by-Field Reference

| Field | Type | Allowed | Default | Required |
|---|---|---|---|---|
| Van sell | on/off | on, off | off | yes |
| Pre-sell | on/off | on, off | off | yes |
| Customers not on the route | choice | allow, refuse | allow | yes |
| Stock missing from a van | choice | charge the rep, write off | charge the rep | yes |
| Shortage a second person must decide | amount (KES) | 0 to 100,000,000 (two decimals) | 1,000 | yes |
| Stock may stay on the van overnight | on/off | on, off | off | yes |
| Where the rep is | choice | record, require | record | yes |
| How near counts as at the customer | whole metres | 20 to 5,000 | 200 | only when *require* |
| Reason | list + comment | an active reason the company has | none | yes, to save |

**Van form** (*Add a van*, *Change*):

| Field | Type | Rules | Required |
|---|---|---|---|
| Name or plate | text | 2 to 60 characters; no other van may have the same name, whatever the letter case | yes |
| Branch | choice from the company's branches in use | fixed once the van is made | yes, when adding |
| Vehicle | choice from vehicles in use that are not behind another van in use | a vehicle is behind one van at a time | no |
| Cash account for the till | choice from the company's cash accounts | cannot be changed while a shift is open on the van's till | no |
| Most cash the van should hold (KES) | amount | more than nothing, or empty for no limit | no |

**Sales rep form** (*Add a sales rep*, *Change*):

| Field | Type | Rules | Required |
|---|---|---|---|
| Member of staff | choice from staff whose account is in use and who are not reps yet | fixed once the rep is made | yes, when adding |
| Phone | text | a number that can be called, such as +254 711 000 222 | no |
| Home branch | choice from branches in use | | no |
| What the rep does | Van sell, Pre-sell | at least one | yes |
| Most discount the rep may give (%) | number | 0 to 100; 0 means none | yes |
| Most credit in one day (KES) | amount | 0 or more; 0 means no limit while they may sell on credit | yes |
| May sell on credit | tick | | no |
| May change a price | tick | | no |

**Reason** (stopping a van; pausing or ending a rep): typed in the rep's or manager's own words, 3 to 300 characters, kept with the change.

**Route form** (*Add a route*, *Change the route*):

| Field | Type | Rules | Required |
|---|---|---|---|
| Route code | text | up to 20 letters, digits, spaces or dashes; shown in capitals; no other route may have the same code, whatever the letter case | yes |
| Route name | text | 2 to 60 characters; no other route may have the same name | yes |
| Branch the route starts from | choice from branches in use | fixed once the route is made | yes, when adding |
| What the route is for | Van sell, Pre-sell, or both | a mode is offered only while the company has it switched on | yes |
| Usual van | choice from vans in use in the route's branch | none for a pre-sell route | no |
| Usual sales rep | choice from reps who are selling | must do what the route is for | no |

**Customer on a route** (*Add a customer*, *Change days*):

| Field | Type | Rules | Required |
|---|---|---|---|
| Customer | choice from customers in use, not the walk-in customer, not already on this route | fixed once added | yes, when adding |
| Days of the week | seven ticks, Monday to Sunday | at least one | yes |
| How often | every week, every 2 weeks, every 4 weeks | counted from the week of the start date | yes |
| Visits start from | a date | a real date in the first week of visits | yes |
| Note for the rep | text | up to 300 characters | no |

**Usual stock** (one line for each product): **Product** (kept in stock, once on the list) and **Quantity** (more than nothing, in the product's own unit: whole numbers for a product counted in pieces).

**Plan a day form:**

| Field | Type | Rules | Required |
|---|---|---|---|
| Route | choice from routes in use | the route's mode must be switched on | yes |
| Date | a date | today or later: a day cannot be planned for a date that has passed | yes |
| Sales rep | choice from reps who are selling | empty uses the route's usual rep; must do what the route needs | no |
| Van | choice from vans in use | empty uses the route's usual van; none for a route that only takes orders; must be in the route's branch | no |

**Add a customer to a day:** one customer, in use, not the walk-in customer and not already on the day.

**Reason for cancelling a day:** 3 to 300 characters, kept with the day's history.

**Make up the load:** *Load from* (a warehouse or store in use), then one line for each product with a **quantity to load** (more than nothing, in the product's own unit) and, if wanted, products added by hand. **Call it off** and **Sign for the load** each take what is described in the steps below.

**Send the day out:** *Cash counted into the van's till (KES)*: nothing or more, to two decimals. A day that only takes orders has no till and no float.

**Reasons** for finishing a visit with no sale and for skipping a customer: 3 to 300 characters, kept with the visit and in the day's history.

**Permissions for the whole module** (granted in Users & Roles, [Guide 07](07-users-roles-and-access-governance.md)):

| Permission | Allows | Held by default |
|---|---|---|
| Van sales: read | See vans, reps, routes, van days and figures | Administrator |
| Van sales: manage | Set up vans, reps and routes, and put customers and usual stock on a route | Administrator |
| Van sales: plan | Plan days and loads; answer a rep's request for stock | Administrator |
| Van sales: sell | Sell, take orders and collect as a rep, for their own day only | Reps only (given by hand) |
| Van sales: reconcile | Count a van in; decide stock and cash differences | Administrator |
| Van sales: settings | This settings screen | Administrator |
| Van sales: report | Van sales reports | Administrator |
| Van sales: offline | Selling with no connection and its limits | Administrator; no other role |

## 6. Step-by-Step User Actions

**Switch van selling or pre-selling on.**
1. Open *Settings › Sales › Van sales* (needs *Van sales: settings*).
2. Tick *Van sell*, *Pre-sell* or both.
3. Set the rules if the built-in ones do not suit the company (section 5).
4. Choose a **Reason** and press **Save**. The screen says *Saved. Van sales now follows these rules.*

**Change a rule later.** Open the screen, change it, choose a reason, **Save**. **Undo** puts the screen back to what is saved.

**Two people at once.** If a colleague saved while you were editing, **Save** is refused with *Someone else changed these settings while you were looking at them. Reload the page to see the latest and make your change again.* Nothing is overwritten.

**Add a van.** *Sales › Van sales › Vans*, **Add a van**; type the name or plate; choose the branch; optionally the vehicle, the till's cash account and a cash limit; **Add the van**. The screen says *`name` added. Its stock place is `code` and its till is ready.* Three things are made together: the van, its stock place (so stock can be loaded onto it) and its till (so cash can be taken). If anything fails, none is made.

**Change a van.** **Change** on the van; edit the name, vehicle, cash account or cash limit (the branch is shown but cannot be changed: to move a van to another branch, add a new van there and stop this one); **Save**. The name follows into its stock place and its till.

**Stop a van.** **Stop this van**; type why; **Stop the van**. It is refused, in words, while the van still holds or has promised stock (*unload it to the warehouse first*) or has a shift open on its till (*close it first*). A stopped van's stock place and till are stopped with it.

**Use a van again.** In the *Stopped* list, **Use again**. It is refused if its vehicle is now behind another van in use.

**Add a sales rep.** *Sales › Van sales › Sales reps*, **Add a sales rep**; search and choose the member of staff; phone, home branch; tick what they do; set their discount, credit and price rights; **Add the sales rep**. The person is no longer offered in the staff list.

**Change a sales rep.** **Change**; edit the phone, branch, what they do and their limits; **Save**.

**Pause, end or put back to work.** **Pause** or **End work as a rep**; type why; confirm. **Put back to work** needs no reason; it is refused while the person's account is switched off in Users.

**Add a route.** *Sales › Van sales › Routes*, **Add a route**; type the code and name; choose the branch; choose what the route is for; optionally its usual van and rep; **Add the route**. Open it to put customers on it.

**Put a customer on a route.** On the route's page, **Add a customer**; search and choose the customer; tick the days; choose how often; set the date visits start from; add a note if useful; **Put on the route**. The customer goes to the end of the round. Without a day, the screen says *Choose at least one day of the week to visit.*

**Arrange the round.** **Up** or **Down** on a customer moves it one place; the places renumber. The first customer cannot go up and the last cannot go down.

**Change a customer's days.** **Change days** on the customer; edit the days, how often, start date or note; **Save**. The customer stays the same: to visit another customer, add them as a new stop.

**Take a customer off.** **Take off route**, then the confirmation. The customers after it move up a place. The customer can be put back later.

**Set the usual stock.** Search a product, give a quantity, **Add to the list**; change a quantity on its line, or **Take off** a line; then **Save the usual stock**. What is saved replaces the list as a whole, so it is exactly what was on screen. A quantity that does not fit the product's unit, such as 24.5 of something counted in pieces, is refused in words.

**See who is due.** Choose a date in *Who is due on a day*. The list follows the days and the every-2-or-4-weeks rule, and changes when the round is changed.

**Change, stop or use a route again.** **Change the route** edits its code, name, mode, van and rep (not its branch). **Stop this route** asks why; a stopped route cannot be changed, and its customers and usual stock cannot be edited, until it is used again.

**Plan a day.** *Sales › Van sales › Van days*, **Plan a day**; choose the route; choose the date; choose another rep or van only if the route's usual ones are not going; **Plan the day**. The day opens with its number. The customers due that date, by their days and how often they are visited, are put on it in the order of the round. If no customer is due, the screen says so and suggests another date.

**Arrange the visits.** On the day's page, **Add a customer** (a customer who is not due that date, for a one-off call), **Up** or **Down** to change the order, **Take off the day** to remove a customer who has not been visited. The route itself is not changed.

**Cancel a day.** **Cancel this day**, type why, **Cancel the day**. The rep, the van and the route are free to be planned again for that date. A day that has gone out cannot be cancelled: it runs its course.

**Read the history.** The *History* list on the day's page shows each step with the server's time and who did it.

**Make up a load.** On the day's page, choose where to load from, check the suggested quantities, change or add as needed, **Ask for the load**. The day moves to *Being loaded* and a stock transfer from the warehouse to the van is asked for. Nothing has left the warehouse yet.

**Approve.** Only where Inventory settings ask for a second person to approve transfers: someone other than the person who asked approves it.

**Send it.** The stock leaves the warehouse and is on its way to the van. It is refused, naming the product, if the warehouse does not have that much that is not promised to a customer.

**Sign for the load.** The rep counts what arrived on the van: everything that was sent, unless the count is changed. If something did not arrive, put what was counted; the rest stays on its way and is settled under **Stock › Transfers** (written off or sent back). **The rep signs for their own load.** The office may sign for a rep who is on the road or signed the paper copy, but must give a reason, and the load shows that it was signed on the rep's behalf, by whom, and why. Once signed, the stock is on the van.

**Call it off.** Before the stock has left the warehouse, **Call it off** with a reason; the day may then make another load. A load that has left cannot be called off.

**A top-up.** While the day is out on the route, the planner makes up a top-up in the same way (**Make up a top-up**), and it is sent and signed for like a load. A day may have several.

**Send the day out (the rep).** Once the load is signed for, count the cash into the till and **Send the day out**. This opens a shift on the van's till with that float, ties it to the day, and moves the day to *Out on the route*. A day that only takes orders goes out with no float.

**Arrive.** At a customer, **Arrive**. The phone is asked where it is; the time, the position and how far it is from the customer's map pin (where the customer has one) are kept. Depending on the company's setting the distance is only recorded, or the rep must be within the set distance to start the visit (*You are 340 m from the shop. Get within 200 m to start the visit.*). One visit is under way at a time.

**Finish with no sale.** **Finish: no sale**, type why, **Finish the visit**.

**Skip or shop closed.** **Skip** a customer who will not be visited today, with a reason. **Shop closed** (confirmed once) ends a visit where the shop was found shut, whether or not the rep had arrived.

**Add a customer on the road.** **Add a customer**, search, **Add to the visits**. Refused when the company lets reps visit only the customers on the route.

**Two people at once.** Every change is checked against the version on screen; if someone else saved first the change is refused with *Someone else changed this van (or sales rep)… Reload the page to see the latest.*

**Every change** is in the decision log with the old and new values, the person, the time and the reason.

## 7. Conditions, Business Rules & Edge Cases

- **Both modes are off for every company until switched on**; with both off, the van sales screens are not shown to anyone (the screens are added slice by slice; today only this settings screen exists).
- A route can be in a mode only while the company has that mode switched on, and a mode cannot be switched off while a route in use needs it (see the route rules below).
- **The database enforces the allowed values too**: a wrong choice, a negative limit or a distance outside 20 to 5,000 metres cannot be stored, whichever way it arrives.
- The settings are company-wide and apply from the next action. As each later slice is built, this guide says which rules a van day already out keeps.
- **A van is one stock place and one till, made together** and kept together: its stock place sells only to van sales, so **no shop, quote, warehouse order or counter sale can take van stock**, and the shop never promises it. Its stock place cannot be changed or stopped from *Stock › Locations*, and its till cannot be moved or switched off from *Registers*: both say so and point to Van sales.
- **A van is never deleted**, only stopped, so past days keep it. It is stopped only when it holds no stock and has no shift open.
- **A van name is unique** whatever the letter case. **A vehicle is behind one van in use at a time.**
- **A sales rep is never deleted**, only ended, so past days keep their name. Their account must be in use to put them back to work. Only staff can be reps, and a person is a rep once.
- **A route is for van sell, pre-sell or both**, and only while the company has those modes switched on. **A mode cannot be switched off while a route in use needs it**: the screen names the routes (*Pre-selling cannot be switched off while routes in use need it (Kiambu Monday)*) and they are changed or stopped first.
- **A pre-sell route has no van** (it sells nothing from one). A usual van must be in use and in the route's own branch. A usual rep must be selling and must do what the route needs (a route for both needs a rep who does both).
- **A van that is the usual van of a route in use cannot be stopped, and a rep who is the usual rep of one cannot be ended**, until another is chosen for that route. A rep may be paused.
- **A customer is on a route once at a time**; the walk-in customer and customers no longer in use cannot be put on a route. A **blocked** customer can be on the route but is shown with a warning, so the office sees it before the rep does.
- **Two people adding customers at the same moment each get their own place**: the places in the round are never doubled.
- **Taking a customer off keeps the record** (a past visit will still point to it) and the round closes up. A route is stopped, never deleted.
- **The usual stock holds each product once**, only products kept in stock, with a quantity that fits the product's unit.
- **A stopped route cannot be changed**, and cannot be used again while its van or rep is no longer in use or its mode has been switched off.
- **A day belongs to a route, a rep and a van on a date.** A rep, a van and a route each have one day on a date; planning a second is refused in words. A cancelled day gives them back. A day for a route that only takes orders has no van.
- **The customers on a day are copied from the route when it is planned.** Changing the route afterwards does not change days already planned; the day's visits can be arranged on the day itself.
- **A day moves in one direction:** planned, being loaded, out on the route, back at the depot, being counted, closed. It is cancelled only before it goes out. The steps after *planned* are added by the parts of van sales that own them (loading, selling, the count at the end).
- **A route, van or rep with a day that is not finished (not closed or cancelled) cannot be stopped, paused or ended**; the screen names the day and says to cancel or close it first.
- **The visits can be arranged only while the day is planned or being loaded**, and a visit that has started cannot be taken off.
- **The history of a day is append-only.** The database refuses any change or removal of an entry. Each entry has the server's time (never the phone's), who did it, and the reason where one is needed.
- **Days are numbered from their own series** (`VDY-{YY}-…`, set under Settings › Number series), with no gaps within a year.
- **A load is a stock transfer** from a warehouse or store to the van's own stock place, so it follows the company's transfer rules (approval, stock not promised to customers) and appears under *Stock › Transfers* with its number. Stock-by-location must be switched on; if it is not, the screen says so.
- **The stock moves twice:** it leaves the warehouse when the load is **sent**, and arrives on the van when the rep **signs**. In between it is in transit and belongs to neither place.
- **The suggestion is the route's usual stock less what is on the van** (never below nothing), limited by what the warehouse has that is not promised to a customer. Orders already taken for the day's customers will be added to it when pre-selling is built.
- **One load a day**, plus top-ups once the day is out. A second load is refused while one is still wanted.
- **Signing is the rep's.** Anyone else needs *Van sales: plan* and a typed reason, and it is recorded as signed on the rep's behalf.
- **A day with stock loaded cannot be cancelled** while a load has not left the warehouse (call it off first), while one is on its way (sign for it or settle it), or while its stock is on the van (bring it back to the warehouse with a transfer from the van under *Stock › Transfers*).
- **Van stock is for the van's reps.** No shop, quote or warehouse order can take it.
- **A rep runs only their own day.** Sending out and every visit step are refused for anyone else, in words, because the stock and the cash are in the rep's care. The office plans and loads; the rep runs.
- **A day goes out only after its load is signed for** (a day that only takes orders needs none), while its mode is switched on, and for a rep who is selling.
- **The float opens the van's till shift.** A shift the rep already opened on the van's till for this day is used again (so a retry never opens a second); another person's shift on that till, or a shift of the rep's own elsewhere, is refused in words.
- **Once the day is out the office cannot rearrange the visits**, and the day cannot be cancelled: it runs its course.
- **A visit moves one way:** to visit, at the customer, done, with *skipped* and *shop closed* as other ends. A visit with no sale always has its reason.
- **The phone's own time is kept beside the server's** and never used to order anything.
- **Stock comes from the van and nowhere else.** A van sale is taken from the van's own stock, whatever the channel; if the van does not hold enough, the sale is refused. The warehouse is never drawn on quietly.
- **Prices are the system's.** The rep cannot type a price or a discount unless their profile allows it, and never beyond their discount limit (percentages only). The customer's own price list applies.
- **Credit is limited twice:** by the customer's own credit terms and by what the rep may give in a day. The refusal says how much is left.
- **A retry never sells twice.** If the connection drops and the rep presses again, the same sale is found, not made again.
- **Blocked or stopped customers** cannot be sold to. Selling needs a visit under way, a day that is out, and a mode that sells from a van; a day that only takes orders sells nothing from the van.
- **Cash goes into the day's till shift** opened when the day was sent out; the shift's count at the end of the day is the cash the rep must hand over.
- **An order is priced by the system.** The rep's own price and discount rights do not apply to an order; the customer's own price list does.
- **An order holds stock at the warehouse**, as any sales order does, and is refused if the warehouse cannot cover it. The van's stock is not touched; delivering it is done later (a delivery run, or a drop on a van day).
- **A route that only sells from the van takes no orders**, and a route that only takes orders sells nothing from a van.
- **A retry never takes an order twice.**
- Every add, change, stop, pause, end and resume is in the decision log with the person, the time and the reason typed.
- The database itself refuses a stopped van, route, or a paused or ended rep with no reason, a pre-sell route with a van, a visit with no day or one visited every 3 weeks, a discount over 100%, a negative credit or cash limit, and a mode other than van sell or pre-sell.
- A reason is required for every change, so an auditor can see why a rule was relaxed.

## 8. Implementor Checklist & Go-Live Verification

- [ ] Decide with the client which mode(s) they use and switch them on with a reason.
- [ ] Decide the shortage rule with the owner: charge the rep, or write off. Record the owner's decision in the reason comment.
- [ ] Set the approval limit with finance (a limit that is too high lets large shortages through without a second person).
- [ ] Decide whether stock may stay on vans overnight (most companies: no).
- [ ] Decide whether position is only recorded or required, and, if required, test the distance at a real customer before go-live (phone GPS can be 50 to 100 metres out in built-up areas; 200 metres is a safe start).
- [ ] Verify: reload the screen and confirm each value kept; check the decision log shows the change.
- [ ] Add one van for each vehicle that sells; name it by plate. Give it the cash account its money is banked from.
- [ ] Add every rep, with the modes they do. Start with a low discount and credit limit and raise them as trust is earned.
- [ ] Verify: a van's stock place appears in *Stock › Locations* with *Sells: Van sales*, its till in *Registers*, and neither can be stopped from there.
- [ ] Verify: stopping a van that still has stock is refused.
- [ ] Add each route with its code, name, branch, what it is for, and the usual van and rep.
- [ ] Put the customers on each route in the order a rep would drive, with the days and how often. Use the notes for gates and contacts.
- [ ] Set the usual stock for each route's van from what it sells on a normal day.
- [ ] Verify: choose a date in *Who is due on a day* for a Monday, a fortnightly week and a week off, and compare with what the sales manager expects.
- [ ] Verify: a customer already on the route is not offered again, and stopping a route's usual van is refused.
- [ ] Plan a day for each route for the coming week, and read the visits against what the sales manager expects.
- [ ] Verify: a second day for the same route, rep or van on the same date is refused; cancelling the first frees them.
- [ ] Verify: a route with a day planned cannot be stopped; cancel the day, then it can.
- [ ] Verify: the history shows who planned and who cancelled, with the time.
- [ ] Switch on stock by location (Inventory) and make sure each warehouse or store a van loads from exists.
- [ ] Set the usual stock on each route, then plan a day and read the suggested load against what the warehouse has.
- [ ] Verify: ask for, send and sign for a load; the warehouse falls when it is sent and the van's stock rises when it is signed for.
- [ ] Verify: the office signing for a rep is refused without a reason and shows as signed on their behalf.
- [ ] Verify: a day with stock on its van cannot be cancelled until the stock is brought back.
- [ ] Verify: the rep (not the office) can send the day out, and the office is refused with the rep's name.
- [ ] Verify: sending out opens a shift on the van's till with the counted float (see *Shifts*).
- [ ] Verify: a visit with no sale cannot be finished without a reason; one visit is under way at a time.
- [ ] Decide with the owner whether reps must be near a customer to start a visit (Settings › Sales › Van sales), and set customers' map pins if so.
- [ ] Verify: a sale made at a visit takes stock from the van only (Stock by location) and appears on the till's shift.
- [ ] Verify: a rep without the right to change prices or give discounts is refused; credit is refused past the rep's daily allowance.
- [ ] Test sale: sell 2 of a product for cash with more than the total handed over and check the change shown.
- [ ] Verify: an order taken at a visit appears under Sales Orders for the right customer, with its stock held at the warehouse.
- [ ] Verify: a van-only route offers no *Take an order* button, and an order-only day offers no *Sell*.
- **Common pitfalls:** asking the office to send a day out for the rep (refused: the rep does it); requiring the rep to be near a customer who has no map pin (the visit starts and the distance is not known); loading before stock by location is switched on (the screen says so); signing a load that was never sent; expecting stock to be on the van when the load was only asked for; planning a day before the route has customers due that date (the screen says none is due); planning a day for the usual rep who is already on another route that date (refused); giving two routes the same code or name (refused); starting a fortnightly customer's visits in the wrong week (the date sets which weeks count); naming two vans alike (refused); putting a vehicle behind two vans (refused); switching on *require* with a very small distance, which blocks reps in town centres; leaving the approval limit at 0, which sends every small shortage to a second person.
