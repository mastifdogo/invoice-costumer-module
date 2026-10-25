# Invoices & customers — a Ledger module

A module for [Ledger](https://github.com/mastifdogo/Bookeeping) that lets you:

- **write invoices**: line items with quantity, unit price and tax rate per line,
  automatic numbering (`INV-0001`…), due dates from payment terms, drafts you
  can edit, duplicate, issue, void
- **keep customer records**: contact details, billing address, Cc addresses,
  currency, payment terms, private notes, outstanding balance and invoice history
- **email invoices** as PDF attachments through your own mail account (SMTP:
  Gmail, Microsoft 365, Fastmail, iCloud, Zoho or a local relay), with an
  editable message and a log of every send
- **record payments**, with partial payments and an overdue view
- optionally **post to the books**: issuing an invoice posts
  Dr receivable / Cr revenue + sales tax, a payment posts Dr bank / Cr
  receivable, and voiding or removing a payment reverses its entry

It has no dependencies (PDF and SMTP are built in), so Ledger installs it as-is.

## Install

On Ledger's **Modules** page, enter `mastifdogo/invoice-costumer-module` and
install. Ledger installs the latest GitHub Release, creates the module's
database schema (`mod_invoices`) and adds **Invoices** to the sidebar.
Needs Ledger 0.6.0 or newer.

## Set up

Open **Invoices → Settings**:

1. **Your business**: name, address, tax number and footer appear on every invoice.
2. **Invoices**: number prefix and next number, default currency, payment
   terms, tax rate and tax name (e.g. `HST`, 13).
3. **Ledger posting** (optional): tick *Post invoices and payments to the
   books* and choose, for each currency you bill in, the receivable, revenue,
   sales-tax and bank accounts. Create them under **Accounts** in Ledger first
   (e.g. `1200 Accounts receivable` asset, `4000 Revenue`, `2200 HST payable`
   liability, `1000 Bank` asset).
4. **Email**: pick your provider to fill in the server, then enter your
   username, password and sender address, save, and press **Send a test email**.

   | Provider | Server | Port / security | Password |
   |---|---|---|---|
   | Gmail / Google Workspace | smtp.gmail.com | 465 TLS | an [App Password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification) |
   | Microsoft 365 / Outlook | smtp.office365.com | 587 STARTTLS | account or app password; SMTP AUTH must be enabled for the mailbox |
   | Fastmail | smtp.fastmail.com | 465 TLS | app password |
   | iCloud | smtp.mail.me.com | 587 STARTTLS | app-specific password |
   | Local relay (Postfix…) | e.g. localhost | 25 none | usually none |

   The container needs outbound access to that port. The password is stored
   in the module's database table and never sent back to the browser.

## Using it

- **Customers → + New customer**, then **+ New invoice** from the customer.
- **Save draft** keeps it editable; **Save & issue** locks it (and posts it
  when ledger posting is on).
- **Email** sends the PDF to the customer's address (plus Cc addresses);
  emailing a draft issues it first. The message template and placeholders
  (`{{number}}`, `{{customer}}`, `{{total}}`, `{{due_date}}`…) are in Settings.
- **Record payment** for full or partial payments; the invoice becomes *paid*
  when the balance reaches zero.
- **Void** an issued invoice with no payments (remove payments first). Drafts
  can simply be deleted.
- **Download PDF** at any time.

Money is kept as integer cents and tax is computed per rate on the sum of the
lines at that rate, rounded half away from zero.

## API

Everything the page does is available under `/api/v1/m/invoices` with a Ledger
login: `customers`, `invoices` (plus `/:id/issue`, `/:id/send`, `/:id/pdf`,
`/:id/payments`, `/:id/void`, `/:id/duplicate`), `settings`,
`settings/test-email`, `summary`. See `server.mjs`.

## Development

```
ledger-module.json     manifest
server.mjs             API routes (register(ctx))
lib/money.mjs          exact money/tax arithmetic
lib/pdf.mjs            PDF writer and invoice layout
lib/mail.mjs           SMTP client (TLS, STARTTLS, AUTH PLAIN/LOGIN) and MIME builder
migrations/            database schema (runs once per file, never edit a released one)
ui/                    the page shown inside Ledger (plain HTML/JS, no build)
test/                  unit tests: npm test
```

To run it against a local Ledger checkout, copy (not symlink) this directory
to `$MODULES_DIR/invoices` and follow "Developing locally" in Ledger's
`docs/MODULES.md`.

## Releasing

Bump `version` in `ledger-module.json`, tag (`git tag v1.0.0 && git push origin
v1.0.0`) and create a GitHub Release from the tag. Ledger picks it up on its
update schedule.
