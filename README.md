# PAS - multi-tenant inventory (static HTML/JS + Firestore, Spark plan)

Live: https://pos-pas.web.app - free (Firebase Spark), no server, no Firebase Authentication.

## Structure (add features by adding a page)
```
index.html            shell (mounts #app)
styles.css            design system: tokens, layout, components (mobile first, dark-mode aware)
core.js               crypto, RBAC, tenant/user/role/price logic (no browser deps; also used by Node scripts)
js/main.js            boot: restore session, render login or shell
js/router.js          hash router (#/inventory), lazy-loads pages
js/routes.js          route registry - ONE line per page (title, icon, permission, loader)
js/shell.js           top bar, sidebar (desktop), bottom tabs (phone), account sheet
js/state.js           auth state (sessionStorage) + can(resource, action)
js/data.js            live Firestore listeners -> `store`
js/ui.js              DOM builder, icons, sheets, forms, toasts, charts, Excel export
js/stock.js           batch / expiry helpers derived from the live data
js/components/        shared components (supplier price sheet, order line editor, payments + receipt/voucher, branch editor, write-off)
js/pages/             login, dashboard, sales, inventory, batches, purchases, expenses, customers, suppliers, prices, ledgers, users, roles, tenants
scripts/              seed-admin, seed-lebanon (demo data), test-core (Firestore logic), ui-test (headless browser), delete-tenants
```
**New feature = `js/pages/thing.js` exporting `default { mount(view) { ...; return cleanup } }` + one entry in `js/routes.js`** (+ add its collection to `DATA_COLLS` in core.js and `firestore.rules` if it stores data). A page doesn't need its own nav entry: set `nav: false` in its `routes.js` line to keep it out of the sidebar/bottom-nav/More menu while it stays reachable by hash from wherever it belongs (see Batches under Inventory, Roles under Users, Users itself under the account sheet).

On a phone, the bottom bar only has room for 4 tabs plus a **More** button (the "•••" icon) that opens the rest in a sheet - so a tenant with several pages (Sales, Inventory, Purchases, Expenses, Reports, Ledgers, Customers, Suppliers, Prices) will have some of them under **More**, not missing. On desktop the sidebar always lists every page directly, no More needed.

## Login links (URL parameters)
- `https://pos-pas.web.app/?tenant=acme` - pre-fills the Tenant ID (send this link to a tenant's staff). Invalid IDs are ignored.
- `https://pos-pas.web.app/?admin` - reveals the "Platform admin" tab. Without `?admin` the option is not shown at all.
- Both can be combined: `/?tenant=acme&admin`.

## People and roles
- **Platform admin** - open the login page with `?admin`, then use the "Platform admin" tab. Creates/suspends/deletes tenants, can open any tenant.
- **Tenant users** - Tenant ID + username + password. Each has a role; roles have Create/Read/Update/Delete per resource (inventory, batches, waste, sales orders, purchase orders, expenses, reports, ledgers, customers, suppliers, supplier prices, settings, users, roles - manage roles from Users -> **Roles**). Defaults: Owner (locked), Admin, Manager, Staff, Viewer. `settings` currently just governs who can change the exchange rate; everyone can read it live (payments in any role need it to convert LBP). `reports` gates the Reports page and its statistics separately from the raw order data they're built from, so a role can see orders without seeing revenue/margin analytics, or vice versa.
- **Users lives in the account sheet, not the main menu** - tap your name/avatar (top bar, or the account row at the bottom of the desktop sidebar) for Change password / Log out, plus **Manage users** (shown to anyone with `users` read access) which opens the Users page - itself the entry point to Roles.
- **The Owner is protected** - the user holding the `owner` role cannot be edited, disabled or deleted by anyone (including other admins), and no one can be assigned the Owner role directly. The only way to change who owns a tenant is **Transfer ownership** (a "Make owner" action on the Users page, visible to the current owner on every other enabled user), which atomically hands the Owner role to them and moves the outgoing owner to a role they choose. A tenant always has exactly one owner.
- **Admin is the built-in "several full-access users" role** - unlike Owner, any number of users can hold the Admin role, and being an ordinary role it can be freely edited or deleted (Owner cannot). Use it when a tenant needs more than one person with full access, while keeping exactly one protected Owner.

## Features
Dashboard statistics, inventory (per-item low-stock alert level, quick quantity stepper), customers with branches, suppliers with per-supplier item prices, cheapest-supplier report with price history, user & role management with a protected Owner, plus:

- **Document references** - every sales order, purchase order, and each invoice/return/payment generated from them, gets its own sequential reference in the form `PREFIX-YY-####` (`YY` = the current two-digit year; numbering restarts at `0001` every year, separately for each document type): **SO** (sales order), **SI** (sales invoice, assigned the moment a sale is fulfilled), **SR** (sales return, one per customer return), **PO** (purchase order), **PI** (purchase invoice, one per goods receipt - a purchase order received in several deliveries gets one PI per delivery), **PR** (purchase return, one per return to a supplier), **REC** (sales receipt, one per payment/refund that is money coming in) and **PV** (payment voucher, one per payment/refund that is money going out). These references appear on the order card and detail sheet, in Excel exports, and are what customer/supplier statements cite (a statement's "Sale"/"Goods received"/"Payment"/"Refund" lines cite the SI/PI/REC/PV number, not the underlying order number).
- **Batches & waste** (under Inventory -> **Batches**) - stock is received in batches (lot number, unit cost, expiry date; perishable items *must* have an expiry date). Each item has its own expiry alert window. Expired stock is written off into a waste log with a reason and its cost value; expiry and waste show on the dashboard.
- **Purchase cycle** - draft -> ordered -> part received -> received (or closed short). Only items the chosen supplier has a price for can be ordered, at that price (with a hint when another supplier is cheaper). Receiving creates batches, adds stock, can update the supplier's price list, and assigns that delivery a purchase invoice reference (PI). One line can be received as several batches at once (different lots/expiry dates).
- **Sales cycle** - draft -> confirmed -> fulfilled -> paid, or "Fulfil now" for a walk-in sale. Fulfilling takes stock First-Expiry-First-Out by default (never from expired batches), or you can "Choose batches" to override FEFO and pick specific lots, and assigns the sale its invoice reference (SI). It records which lots were used and the cost of goods (margin), and cannot oversell: every stock change runs as a Firestore transaction.
- **Dual currency (USD / LBP)** - the tenant sets a live exchange rate (Ledgers -> **Exchange rate**, LBP per 1 USD). Every order's own totals stay in USD, but a payment or refund can be split across both currencies at once (e.g. part cash USD, part cash LBP); the LBP side is converted to its USD equivalent using the rate in effect *at that moment*, and that rate is stamped onto the payment so it keeps its value even if the rate changes later. Balances, statements and dashboard figures are always the USD-equivalent total, so they read correctly regardless of the currency mix customers actually paid in.
- **Partial payments & refunds** - sales and purchase orders track a list of payments/refunds (USD amount, LBP amount, method, note), so an order can be part-paid in either or both currencies. The order's balance, payment state (unpaid/part paid/paid/settled/refund due) and a full payment history are shown on its detail sheet; each payment/refund opens its own printable **sales receipt** or **payment voucher** (its REC/PV reference, date, party, currency split and method).
- **Partial returns** - a customer can return some or all of the items on a fulfilled sale; the returned units go back into the exact batches they came from (latest lot first), and the order's balance updates accordingly. A supplier return works the same way in reverse: pick which received batches to send back, and the amount you owe that supplier drops.
- **Expenses** - business costs that aren't a purchase order (rent, salaries, electricity, transport, ...), each recorded with a USD/LBP split and its own payment voucher reference (PV). Categories are per-tenant and editable (Expenses -> **Categories**).
- **Statement of account** - Customers and Suppliers each have a "Print statement of account" button right on their row (next to Edit/Delete), opening the same running-balance statement as Ledgers, with **Print** and **Export** (Excel) actions - no detour through Ledgers needed to hand someone their statement.
- **Ledgers** - running-balance statements per customer ("who owes you") and per supplier ("who you owe"), a **Transactions** tab (every payment/refund/expense ever recorded, as money in vs money out, with USD and LBP totals shown separately plus one merged USD-equivalent net, **its own date range** (defaults to all time; "This month" or pick From/To) - click a row for its receipt/voucher), a **P&L** tab (a simple income statement for its own date range: revenue net of returns, cost of goods sold, gross profit, expenses by category, net profit - all in USD), and a full stock ledger (every receipt, sale, return, waste write-off and manual adjustment, each with the on-hand balance after it). All export to Excel.
- **Customer branches** - a customer can have several branches/locations, each with a name, city, area, a Google Maps link and an address description. A sales order can be tied to a specific branch, shown on the order card, detail and export.
- **Customer detail** - clicking a customer's name (in Customers, or anywhere else a customer is named) opens one shared detail sheet: contact info, branches (with map links), order stats, and Edit/Delete/Print-statement actions where you have permission for them.
- **Reports** (its own `reports` permission - see above) - drill-down statistics on top of the same live data other pages use, every list capped at the top 10 so it stays a highlight reel, not a spreadsheet: an **Overview** (all-time revenue/margin/orders/stock value/net profit, top 10 sellers and top 10 customers), a **Revenue** tab (revenue by month, last 6 months, exportable), and a **Customers** tab (a chart of customers by **city or area** - switchable, click a bar to see who's in it - a top-10 leaderboard by revenue, and a "most returns" watch list). Every customer name here is clickable straight through to their detail sheet (walk-in sales aren't, since there's no customer record behind them).
- **Export / Import** - Inventory, Customers and Suppliers each have one discreet **Export / Import** button (a small sheet to choose which) instead of two separate buttons: Export downloads an `.xlsx`; Import picks a file with the same column headers (case-insensitive) and bulk-creates the rows, skipping any name that already exists.

Other order-cycle details: edit a batch's lot/expiry/cost, write off unbatched stock, edit draft orders, print orders, "Reorder low stock" (cheapest supplier per item, as draft POs), order/statement history on customers and suppliers, item -> batches link.

`inventory.qty` is the on-hand total. Stock not covered by a batch (entered by hand) is "unbatched" and is sold last. Manual +/- and edits cannot drop stock below what is held in batches; use Write off instead.

## Deploy / test
```bash
node -v                                        # Node 20.19+ (24 LTS recommended)
firebase deploy --only hosting,firestore:rules
cd scripts && npm install                      # once
node scripts/seed-admin.mjs admin              # once: seeds the platform admin, prints a random password
node scripts/check.mjs                         # static check: every module parses and every import resolves
node scripts/test-core.mjs                     # Firestore logic tests incl. FEFO, waste, order cycles, concurrency (cleans up after itself)
node scripts/ui-test.mjs <adminPassword>       # headless-browser test of the live site (cleans up after itself)
node scripts/seed-lebanon.mjs admin <adminPassword> [tenantId=pas]   # adds a Lebanon-context demo dataset (items, suppliers, customers with branches, orders, dual-currency payments, expenses) - purely additive, safe to re-run
# If Edge headless misbehaves: npx @puppeteer/browsers install chrome@stable, then set EDGE_PATH to that chrome.exe
```

## Security model (no Firebase Authentication)
Firestore rules cannot identify callers without Auth, so isolation is capability-based (see `core.js` header):
- Tenant data lives under `data/{dataKey}/...` (random 256-bit key). Rules allow exact-path access only, no listing.
- Logins live at `tenants/{tenant}/logins/{id}`; `id` and the encryption key both come from PBKDF2(tenant, username, password). A wrong password can't find or decrypt anything; no password hash is stored.
- The platform admin unlocks an `adminKey` that decrypts every tenant's `dataKey`.
- **RBAC is enforced by the app code, not by Firestore.** A technically skilled member who holds their tenant's key could bypass role limits by calling Firestore directly (they still can't reach other tenants). True server-side RBAC needs Firebase Auth or Cloud Functions.
- Removing a user blocks future logins but can't take back a key they already hold.
- Deleting a tenant purges its data and logins; the tenant ID stays reserved.
- Spark limits to keep in mind: 50k document reads/day and 20k writes/day. Live listeners read every document once when a user opens the app.
