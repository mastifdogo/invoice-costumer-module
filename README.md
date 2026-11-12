# Sales — a Ledger module

A module for [Ledger](https://github.com/mastifdogo/Bookeeping). It appears
in Ledger's sidebar as **Sales**, with a hammer icon, and lets you:

- **write invoices** with line items, automatic numbering (`INV-0001`…), due
  dates from payment terms, drafts you can edit, duplicate, issue or void
- **write quotes and estimates**, each with its own numbering (`QUO-`, `EST-`)
  and a "valid until" date. You can email them, mark them accepted or declined,
  and turn one into an invoice with one click. Quotes are firm prices;
  estimates carry an "approximate" disclaimer.
- **charge GST and other sales taxes**. GST (5%) is set up and on by default.
  HST, PST and QST are ready to switch on, and you can add your own. A line
  can carry several taxes (e.g. GST + PST). Customers and categories can
  have their own taxes (e.g. none for an exempt or US customer). Your GST/HST
  registration number prints on every document.
- **sort sales into categories** (Labour, Materials, …), each tracking to
  a revenue account. The Categories page shows sales per category over any
  date range.
- **keep customer records**: contact details, billing address, Cc addresses,
  currency, payment terms, taxes, notes, balance owing and every document
  sent to them
- **email PDFs** through Ledger's shared Gmail account, or your own mail
  server (SMTP: Microsoft 365, Fastmail, iCloud, Zoho, a local relay…), with
  editable messages and a log of every send
- **receive payments**: from a customer's page, enter what came in and it's
  spread over their open invoices, oldest first (you can change the split),
  and posted to the books. Partial payments are fine.
- **match bank deposits** that are already in the books (e.g. imported from
  a statement) to the invoices they pay: exact matches by amount or invoice
  number, and, when an admin allows Sales under **Settings → LLM API**, Ledger's
  AI for the rest (one deposit paying several invoices, vague descriptions).
  Matches are saved as suggestions on the **Payments** tab (and the
  dashboard shows how many wait): change the amounts if needed, then
  **Apply** or **Reject**. Nothing is applied until a person approves it; a
  rejected deposit isn't suggested again. Applying never counts the money twice:
  a deposit credited to receivable is just linked; one sitting in another
  account (e.g. suspense) is moved to receivable with one entry.
- **put reminders on Ledger's dashboard**: a notification when invoices are
  overdue, a to-do for each issued invoice that hasn't been emailed, and a
  to-do to follow up on each sent quote or estimate. They clear themselves
  when the invoice is emailed or paid, or the quote is decided. Each one
  opens the document it's about.
- **bring in customers from other software**: when you migrate to Ledger
  (Settings → Import & export → Migrate), Ledger sends the customer list to
  Sales. The Customers tab (and a dashboard to-do) shows it: who's new and
  who's already a customer, with a box to tick for each. Only the people you
  choose are added; **Don't import** sets the list aside.
- **create accounts on the spot**: the account dropdowns for categories and
  taxes end with **+ New account…**, which opens Ledger's New account
  dialog and selects the new account, without losing what you'd filled in.
- **find things from Ledger's search bar**: customers, and invoices, quotes
  and estimates by number, customer or PO number.
- optionally **post to the books**: issuing an invoice posts Dr receivable,
  Cr each line's category revenue account and Cr each tax's payable account.
  A payment posts Dr bank / Cr receivable. Voiding an invoice or removing a
  payment reverses its entry. Quotes and estimates are never posted.
  Every entry Sales posts (and every bank deposit it applies) is linked to
  its invoice: Ledger shows "Invoice INV-0031 · Acme" on the entry and in
  the journal, and the link opens the invoice in Sales.

It has no dependencies (the PDF writer and the email client are built in),
so Ledger installs it as-is. The page works at full width and in a narrow
side pane.

## Install

Needs **Ledger 0.12.0 or newer** (customer lists from Ledger's migration,
"+ New account…", journal entry links, settings per organization, plus the
settings form, Gmail, search and user roles from earlier versions). In
Ledger, open **Settings → Modules**, enter `mastifdogo/sales_module` and add it.
Ledger installs the latest GitHub Release, creates the module's database
schema (`mod_sales`) and adds **Sales** to the sidebar. You can hide or move
it under **Settings → Sidebar**.

**Upgrading from v0.1.0**: your settings are copied into Ledger's settings
form (Settings → Sales) on the first start; check them there. If you had set
up SMTP, Sales keeps using it.

**Upgrading from v0.0.0** (then called "Invoices & customers", id
`invoices`): Ledger won't update a module whose id changed, so the old one
keeps running with the generic icon. Remove it under Settings → Modules,
then add `mastifdogo/sales_module` again. The old module's data
stays in the `mod_invoices` schema.

**Organizations**: each organization has its own customers, documents,
taxes, numbering and settings (business name, GST number, prefixes, account
codes, email), so a business and someone's personal books, or two
businesses, invoice separately. Each organization's admins fill in
**Settings → Sales** for it; a new organization starts from the defaults.

### Changes

- **0.5.0**: customer lists from Ledger's migration, reviewed before
  anyone is added; "+ New account…" in account dropdowns; the old settings
  table no longer keeps an SMTP password (Ledger 0.13.0 backups copy module
  tables to CSV). Needs Ledger 0.12.0.
- **0.4.1**: in lists and a customer's Transactions, the whole row opens
  the record (click, or Enter from the keyboard); numbers are plain text.
- **0.4.0**: journal entries Sales posts, reversals, and matched bank
  deposits carry a link to their invoice (needs Ledger 0.11.2).
- **0.3.0**: settings per organization; payment suggestions wait on the
  Payments tab for a person to apply or reject them.

### Accounts it uses

Only when ledger posting is on. Create them under **Accounts** first, in
each currency you invoice in. The codes are examples; pick them in Settings.

| Purpose | Type | Example |
|---|---|---|
| Accounts receivable | asset | `1200 Accounts receivable` |
| Bank (where payments land) | asset | `1000 Bank` |
| Revenue per category, plus a default for lines without one | revenue | `4000 Sales`, `4100 Labour`, `4200 Materials` |
| Each sales tax you collect | liability | `2200 GST/HST payable`, `2210 PST payable` |

## Set up

Setup is for admins (Ledger's user roles). Bookkeepers create and send
documents, record payments and manage customers; viewers can only look.

1. **Settings → Sales** (Ledger's settings form for the module):
   - **Your business**: name, address, GST/HST registration number, footer.
   - **Numbering and defaults**: number prefixes, payment terms, how long
     quotes and estimates stay valid, the terms printed on them.
   - **Ledger posting** (optional): turn it on and enter the receivable,
     default revenue and bank account codes for each currency.
   - **Email**: *Ledger's Gmail account* (the default) or *My own mail
     server* with its SMTP details.
   - **Email messages**: subject and text for invoices and for
     quotes/estimates, with placeholders.
2. Below that form on the same tab:
   - **Email** shows whether sending works, with a **Send a test email** button.
   - **Numbering** sets the next invoice, quote and estimate number.
   - **Taxes**: GST is on. Click **Edit** on each tax you collect, turn it
     on, choose the account it's owed to (e.g. `2200 GST/HST payable`) and
     whether new lines get it by default.
3. **Gmail** (if you use it): an admin connects the account under
   **Settings → Gmail** and ticks **Sales** under "may send". Until then the
   Email section says what's missing.
4. Under **Sales → Categories**, add your sales categories and the revenue
   account each goes to. Lines without a category use the default revenue
   account.

For your own mail server:

| Provider | Server | Port / security | Password |
|---|---|---|---|
| Microsoft 365 / Outlook | smtp.office365.com | 587 STARTTLS | account or app password; SMTP AUTH must be enabled for the mailbox |
| Fastmail | smtp.fastmail.com | 465 TLS | app password |
| iCloud | smtp.mail.me.com | 587 STARTTLS | app-specific password |
| Gmail without Ledger's connection | smtp.gmail.com | 465 TLS | an [App Password](https://myaccount.google.com/apppasswords) |
| Local relay (Postfix…) | e.g. localhost | 25 none | usually none |

The container needs outbound access to that port. The SMTP password is a
secret field in Ledger's form and is never sent back to the browser.

## Using it

- **Customers → + Invoice / + Quote / + Estimate** starts a document for that customer.
- On each line, pick a category; its taxes fill in (category's, else the
  customer's, else the defaults). Click the tax chips to change them.
- **Invoices**: *Save draft* keeps it editable. *Save & issue* locks it and
  posts it when posting is on. *Email* sends the PDF; emailing a draft issues
  it first. Use *Record payment* for payments and *Void* to cancel.
- **Quotes and estimates**: *Email* (or *Mark as sent*), then *Accepted* or
  *Declined*. *Convert to invoice* creates a draft invoice with the same
  lines and tax rates, linked both ways. Sent quotes stay editable until
  they're decided.
- Saved documents keep the tax rates they were written with, so changing a
  rate later only affects new lines.

Money is kept as integer cents. Each tax is computed once on the lines it
applies to and rounded half away from zero.

## API

Everything the page does is available under `/api/v1/m/sales` with a Ledger
login:

- `invoices`, `quotes`, `estimates`: list, create, read, update, delete, plus
  `/:id/pdf`, `/:id/send`, `/:id/duplicate`
- invoices also have `/:id/issue`, `/:id/void` and `/:id/payments`
- quotes and estimates also have `/:id/mark-sent`, `/:id/accept`,
  `/:id/decline`, `/:id/reopen` and `/:id/convert`
- `customers/:id/payments` (receive a payment), `payments/match` (look for
  deposit matches and save them as suggestions), `payments/suggestions`
  (list; `/:id/apply` with optional changed amounts, `/:id/reject`),
  `payments/apply` (apply a deposit the user picked)
- `customers`, `categories`, `taxes`, `settings` (read-only), `numbering`,
  `settings/test-email`, `summary`
- Changing taxes, categories or numbering needs the admin role.

## Development

```
ledger-module.json      manifest
server.mjs              register(ctx): wires up the route files
server/common.mjs       input validation, settings, shared helpers
server/documents.mjs    invoices, quotes, estimates (lines, posting, PDF, email)
server/catalog.mjs      taxes and categories
server/customers.mjs    customers
server/settings.mjs     settings for the page, numbering, test email, summary
server/email.mjs        sending through ctx.gmail or SMTP
server/search.mjs       results for Ledger's search bar
server/payments.mjs     receive payment, deposit matching (rules + ctx.llm)
server/dashboard.mjs    notifications and to-dos on Ledger's dashboard
server/move-settings.mjs  one-time copy of pre-0.2.0 settings into Ledger's form
lib/money.mjs           exact money and tax arithmetic
lib/pdf.mjs             PDF writer and document layout
lib/mail.mjs            SMTP client (TLS, STARTTLS, AUTH PLAIN/LOGIN) and MIME builder
migrations/             database schema (each file runs once; never edit a released one)
ui/                     the page shown inside Ledger (plain HTML/JS, no build);
                        setup.html is shown under the settings form
test/                   unit tests: npm test
```

Check it with Ledger's module checker, from a Ledger checkout (needs
PostgreSQL):

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  node .claude/skills/ledger-module/scripts/check-module.ts ../invoice-costumer-module
```

Add `--serve 8098` to keep it running and try it in a browser.

## Releasing

Bump `version` in `ledger-module.json`: new features raise the middle
number (`0.4.0` → `0.5.0`), fixes only the last (`0.4.0` → `0.4.1`), and
merge it into `main`. The **Release** workflow
(`.github/workflows/release.yml`) then creates the tag `v<version>` and the
GitHub Release by itself; don't tag by hand. If it fails with "Resource not
accessible by integration", allow it once under the repository's Settings →
Actions → General → Workflow permissions ("Read and write permissions"),
then Actions → Release → Run workflow. Ledger installs the release on its
update schedule, or straight away with **Update modules now** under
Settings → Modules.
