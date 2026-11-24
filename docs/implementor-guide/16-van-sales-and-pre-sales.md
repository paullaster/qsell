# Guide 16: Van Sales & Pre-Sales (`/admin/settings/sales/van-sales`, and the Van sales screens under Sales)

> **What is built so far.** This guide describes what a company can use today: **the Van sales settings screen** (which of the two modes are on, and the rules every van day follows), **Vans** and **Sales reps** (set up who sells and from what). Routes, van days, loading, selling, collections, the day-end count, the rep phone app, offline selling and reports are built one slice at a time; each adds its screens to this guide in the same change. The full plan is in `docs/architecture/van-sales.md`. Nothing here is switched on for a company until its administrator switches it on.

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
6. **Vans**, then **Sales reps** (this guide, sections 4 to 6). Routes come with a later slice. Permissions: see section 5.

**Required permission to open the settings:** *Van sales: settings*. Held by Super Admin and Administrator by default.

## 3. Module & Sub-Module Architecture

**Mental model.** A **van** is a stock location with its own till. A **rep** sells from it. A **route** is the round of customers. A **van day** is one rep's one outing: loaded in the morning, out, back, counted, closed. A **visit** is one call on one customer. **Pre-sold orders** are taken on visits and handed over from a van day or a normal delivery run.

**Upstream:** products and prices, customers and credit, stock locations, registers and payment methods. **Downstream:** the till's shifts and Z reports, the sales ledger and receipts with KRA signing, stock movements and the books' stock value, delivery runs for pre-sold orders, and customer statements for credit sold and money collected.

**Sub-modules (built as slices):** Settings (built), Vans (built), Sales reps (built), Routes, Van days and the load planner, the rep's phone app, Day-end count and reconciliation, Offline selling for reps, Reports.

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
The home of the module (needs *Van sales: read*). It shows, when van sales is **switched off** for the company, a card saying so with a button to switch it on in Settings (for people who hold *Van sales: settings*; others are told to ask an administrator); when it is on, two chips (*Van sell on/off*, *Pre-sell on/off*) and a **Change these** link. Below are two cards, **Vans** and **Sales reps**, each with its counts (in use, stopped; selling, paused, ended) and a button that opens its list. Vans and reps can be set up while the modes are still off.

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

**Permissions for the whole module** (granted in Users & Roles, [Guide 07](07-users-roles-and-access-governance.md)):

| Permission | Allows | Held by default |
|---|---|---|
| Van sales: read | See vans, reps, routes, van days and figures | Administrator |
| Van sales: manage | Set up vans, reps and routes | Administrator |
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

**Two people at once.** Every change is checked against the version on screen; if someone else saved first the change is refused with *Someone else changed this van (or sales rep)… Reload the page to see the latest.*

**Every change** is in the decision log with the old and new values, the person, the time and the reason.

## 7. Conditions, Business Rules & Edge Cases

- **Both modes are off for every company until switched on**; with both off, the van sales screens are not shown to anyone (the screens are added slice by slice; today only this settings screen exists).
- A route can be in a mode only while the company has that mode switched on (enforced when routes are built).
- **The database enforces the allowed values too**: a wrong choice, a negative limit or a distance outside 20 to 5,000 metres cannot be stored, whichever way it arrives.
- The settings are company-wide and apply from the next action. As each later slice is built, this guide says which rules a van day already out keeps.
- **A van is one stock place and one till, made together** and kept together: its stock place sells only to van sales, so **no shop, quote, warehouse order or counter sale can take van stock**, and the shop never promises it. Its stock place cannot be changed or stopped from *Stock › Locations*, and its till cannot be moved or switched off from *Registers*: both say so and point to Van sales.
- **A van is never deleted**, only stopped, so past days keep it. It is stopped only when it holds no stock and has no shift open.
- **A van name is unique** whatever the letter case. **A vehicle is behind one van in use at a time.**
- **A sales rep is never deleted**, only ended, so past days keep their name. Their account must be in use to put them back to work. Only staff can be reps, and a person is a rep once.
- Every add, change, stop, pause, end and resume is in the decision log with the person, the time and the reason typed.
- The database itself refuses a stopped van or a paused or ended rep with no reason, a discount over 100%, a negative credit or cash limit, and a mode other than van sell or pre-sell.
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
- **Common pitfalls:** naming two vans alike (refused); putting a vehicle behind two vans (refused); switching on *require* with a very small distance, which blocks reps in town centres; leaving the approval limit at 0, which sends every small shortage to a second person.
