-- Suggested matches between bank deposits and open invoices, found by rules
-- or by Ledger's AI. Nothing happens on a suggestion alone: a person reviews
-- it, may change the amounts, and applies or rejects it.
CREATE TABLE payment_suggestions (
    id            bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id      bigint  NOT NULL,              -- Ledger journal entry of the deposit
    line_id       bigint  NOT NULL,              -- the deposit's line on the bank account
    currency      text    NOT NULL CHECK (currency IN ('CAD', 'USD')),
    deposit_date  date    NOT NULL,
    description   text    NOT NULL DEFAULT '',
    reference     text    NOT NULL DEFAULT '',
    deposit_cents bigint  NOT NULL,              -- not yet applied when suggested
    -- [{"invoice_id": 7, "amount_cents": 12500}]
    allocations   jsonb   NOT NULL,
    confidence    text    NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    source        text    NOT NULL CHECK (source IN ('rule', 'ai')),
    reason        text    NOT NULL DEFAULT '',
    status        text    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'applied', 'rejected')),
    created_by    text    NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    decided_by    text,
    decided_at    timestamptz
);
-- One open suggestion per deposit line.
CREATE UNIQUE INDEX payment_suggestions_open_idx ON payment_suggestions (line_id) WHERE status IN ('pending', 'applying');
CREATE INDEX payment_suggestions_status_idx ON payment_suggestions (status, created_at);
