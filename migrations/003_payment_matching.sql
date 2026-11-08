-- A payment can be matched to a bank deposit that is already in the books
-- (e.g. imported from a statement), instead of posting the money again.
-- matched_entry_id / matched_line_id are Ledger's journal entry and the
-- deposit's line on the bank account; journal_entry_id stays the entry this
-- module posted for the payment, if any (e.g. moving the deposit from a
-- clearing account to receivable).
ALTER TABLE payments ADD COLUMN matched_entry_id bigint;
ALTER TABLE payments ADD COLUMN matched_line_id bigint;
CREATE INDEX payments_matched_idx ON payments (matched_entry_id, matched_line_id) WHERE matched_entry_id IS NOT NULL;
