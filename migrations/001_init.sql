-- Runs once, as the module's own role, in its own schema (mod_invoices).
-- Money is integer cents. Quantities are thousandths (1.5 = 1500) and tax
-- rates thousandths of a percent (5% = 5000), so all arithmetic is exact.

CREATE TABLE settings (
    id                 int     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    business_name      text    NOT NULL DEFAULT '',
    business_address   text    NOT NULL DEFAULT '',
    business_email     text    NOT NULL DEFAULT '',
    business_phone     text    NOT NULL DEFAULT '',
    tax_id             text    NOT NULL DEFAULT '',
    invoice_prefix     text    NOT NULL DEFAULT 'INV-',
    next_number        int     NOT NULL DEFAULT 1 CHECK (next_number > 0),
    default_currency   text    NOT NULL DEFAULT 'CAD' CHECK (default_currency IN ('CAD', 'USD')),
    default_terms_days int     NOT NULL DEFAULT 30 CHECK (default_terms_days BETWEEN 0 AND 365),
    default_tax_rate   int     NOT NULL DEFAULT 0 CHECK (default_tax_rate BETWEEN 0 AND 100000),
    tax_label          text    NOT NULL DEFAULT 'Tax',
    footer             text    NOT NULL DEFAULT '',
    -- Ledger posting: {"CAD": {"receivable": "1200", "revenue": "4000", "tax": "2200", "bank": "1000"}, "USD": {...}}
    post_to_ledger     boolean NOT NULL DEFAULT false,
    accounts           jsonb   NOT NULL DEFAULT '{}',
    -- Outgoing mail (SMTP)
    smtp_host          text    NOT NULL DEFAULT '',
    smtp_port          int     NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
    smtp_security      text    NOT NULL DEFAULT 'starttls' CHECK (smtp_security IN ('tls', 'starttls', 'none')),
    smtp_username      text    NOT NULL DEFAULT '',
    smtp_password      text    NOT NULL DEFAULT '',
    from_name          text    NOT NULL DEFAULT '',
    from_email         text    NOT NULL DEFAULT '',
    reply_to           text    NOT NULL DEFAULT '',
    bcc_self           boolean NOT NULL DEFAULT false,
    email_subject      text    NOT NULL DEFAULT 'Invoice {{number}} from {{business}}',
    email_body         text    NOT NULL DEFAULT E'Hello {{customer}},\n\nPlease find attached invoice {{number}} for {{total}}, due {{due_date}}.\n\nThank you for your business.\n{{business}}',
    updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings DEFAULT VALUES;

CREATE TABLE customers (
    id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text    NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    company     text    NOT NULL DEFAULT '',
    email       text    NOT NULL DEFAULT '',
    cc_emails   text    NOT NULL DEFAULT '',
    phone       text    NOT NULL DEFAULT '',
    address     text    NOT NULL DEFAULT '',
    tax_id      text    NOT NULL DEFAULT '',
    currency    text    NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD', 'USD')),
    terms_days  int     CHECK (terms_days BETWEEN 0 AND 365),
    notes       text    NOT NULL DEFAULT '',
    archived    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_idx ON customers (lower(name));

-- draft: editable, not in the books. posting: being posted to Ledger right now.
-- open: issued (and posted when enabled). paid: fully paid. void: cancelled after issuing.
CREATE TABLE invoices (
    id               bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    number           text    NOT NULL UNIQUE,
    customer_id      bigint  NOT NULL REFERENCES customers (id),
    status           text    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posting', 'open', 'paid', 'void')),
    issue_date       date    NOT NULL,
    due_date         date    NOT NULL CHECK (due_date >= issue_date),
    currency         text    NOT NULL CHECK (currency IN ('CAD', 'USD')),
    po_number        text    NOT NULL DEFAULT '',
    notes            text    NOT NULL DEFAULT '',
    subtotal_cents   bigint  NOT NULL DEFAULT 0,
    tax_cents        bigint  NOT NULL DEFAULT 0,
    total_cents      bigint  NOT NULL DEFAULT 0,
    paid_cents       bigint  NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
    journal_entry_id bigint,
    void_entry_id    bigint,
    issued_at        timestamptz,
    sent_at          timestamptz,
    created_by       text    NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_customer_idx ON invoices (customer_id);
CREATE INDEX invoices_status_idx ON invoices (status, due_date);

CREATE TABLE invoice_lines (
    id               bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id       bigint  NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    position         int     NOT NULL,
    description      text    NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
    quantity         bigint  NOT NULL CHECK (quantity > 0),
    unit_price_cents bigint  NOT NULL,
    tax_rate         int     NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100000),
    amount_cents     bigint  NOT NULL
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id, position);

CREATE TABLE payments (
    id               bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id       bigint  NOT NULL REFERENCES invoices (id),
    payment_date     date    NOT NULL,
    amount_cents     bigint  NOT NULL CHECK (amount_cents > 0),
    method           text    NOT NULL DEFAULT '',
    reference        text    NOT NULL DEFAULT '',
    journal_entry_id bigint,
    created_by       text    NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

CREATE TABLE email_log (
    id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id  bigint  REFERENCES invoices (id) ON DELETE CASCADE,
    recipients  text    NOT NULL,
    subject     text    NOT NULL,
    ok          boolean NOT NULL,
    error       text    NOT NULL DEFAULT '',
    sent_by     text    NOT NULL,
    sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_log_invoice_idx ON email_log (invoice_id);
