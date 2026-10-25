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
- **email PDFs** through your own mail account (SMTP: Gmail, Microsoft 365,
  Fastmail, iCloud, Zoho or a local relay), with editable messages and a
  log of every send
- **record payments**, including partial payments, and see what's overdue
- **put reminders on Ledger's dashboard**: a notification when invoices are
  overdue, a to-do for each issued invoice that hasn't been emailed, and a
  to-do to follow up on each sent quote or estimate. They clear themselves
  when the invoice is emailed or paid, or the quote is decided. This needs a
  Ledger with dashboard support (the release after v0.7.1); on older
  versions the module works the same without them.
- optionally **post to the books**: issuing an invoice posts Dr receivable,
  Cr each line's category revenue account and Cr each tax's payable account.
  A payment posts Dr bank / Cr receivable. Voiding an invoice or removing a
  payment reverses its entry. Quotes and estimates are never posted.

It has no dependencies (the PDF writer and the email client are built in),
so Ledger installs it as-is. The page works at full width and in a narrow
side pane.

## Install

Needs **Ledger 0.7.0 or newer** (for the sidebar icon). In Ledger, open
**Settings → Modules**, enter `mastifdogo/invoice-costumer-module` and add it.
Ledger installs the latest GitHub Release, creates the module's database
schema (`mod_sales`) and adds **Sales** to the sidebar. You can hide or move
it under **Settings → Sidebar**.

**Upgrading from v0.0.0** (then called "Invoices & customers", id
`invoices`): Ledger won't update a module whose id changed, so the old one
keeps running with the generic icon. Remove it under Settings → Modules,
then add `mastifdogo/invoice-costumer-module` again. The old module's data
stays in the `mod_invoices` schema.

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

Open **Sales → Settings**:

1. **Your business**: name, address, GST/HST registration number and footer.
2. **Taxes**: GST is on. Click **Edit** on each tax you collect, turn it on
   and choose the account it's owed to (e.g. `2200 GST/HST payable`). The
   chips under the table choose which taxes new lines get by default.
3. **Numbering and defaults**: prefixes and next numbers for invoices,
   quotes and estimates; payment terms; how long quotes and estimates stay
   valid; the terms printed on quotes and estimates.
4. **Ledger posting** (optional): turn on *Post invoices and payments to the
   books* and choose the receivable, default revenue and bank accounts for
   each currency. Create the accounts under **Accounts** in Ledger first.
5. **Email**: pick your provider, enter username, password and sender
   address, save, and press **Send a test email**.

   | Provider | Server | Port / security | Password |
   |---|---|---|---|
   | Gmail / Google Workspace | smtp.gmail.com | 465 TLS | an [App Password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification) |
   | Microsoft 365 / Outlook | smtp.office365.com | 587 STARTTLS | account or app password; SMTP AUTH must be enabled for the mailbox |
   | Fastmail | smtp.fastmail.com | 465 TLS | app password |
   | iCloud | smtp.mail.me.com | 587 STARTTLS | app-specific password |
   | Local relay (Postfix…) | e.g. localhost | 25 none | usually none |

   The container needs outbound access to that port. The password is stored
   in the module's database table and never sent back to the browser.

Then, under **Categories**, add your sales categories and the revenue
account each goes to. Lines without a category use the default revenue
account.

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
- `customers`, `categories`, `taxes`, `settings`, `settings/test-email`, `summary`

## Development

```
ledger-module.json      manifest
server.mjs              register(ctx): wires up the route files
server/common.mjs       input validation, settings, shared helpers
server/documents.mjs    invoices, quotes, estimates (lines, posting, PDF, email)
server/catalog.mjs      taxes and categories
server/customers.mjs    customers
server/settings.mjs     settings, test email, summary
server/dashboard.mjs    notifications and to-dos on Ledger's dashboard
lib/money.mjs           exact money and tax arithmetic
lib/pdf.mjs             PDF writer and document layout
lib/mail.mjs            SMTP client (TLS, STARTTLS, AUTH PLAIN/LOGIN) and MIME builder
migrations/             database schema (each file runs once; never edit a released one)
ui/                     the page shown inside Ledger (plain HTML/JS, no build)
test/                   unit tests: npm test
```

To run it against a local Ledger checkout, put this directory (or a symlink)
at `$MODULES_DIR/sales` and follow "Developing locally" in Ledger's
`docs/MODULES.md`.

## Releasing

Bump `version` in `ledger-module.json`, tag it (`git tag v0.2.0 && git push
origin v0.2.0`) and create a GitHub Release from the tag (not a draft or
pre-release). Ledger installs it on its update schedule, or straight away
with **Update modules now** under Settings → Modules.
