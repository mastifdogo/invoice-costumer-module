-- From 0.7.0 customers live in Ledger's shared list of customers and vendors
-- (entities, Ledger 0.16.0), which Ledger and every module use. A Sales
-- customer row keeps what is Sales' own (company, Cc addresses, tax number,
-- currency, payment terms, taxes, archived) and points at its entity, which
-- holds the name, email, phone, address and notes.
--
-- Rows from before 0.7.0 have no entity yet: they keep their own name and
-- contact details until a person approves moving them across (Customers
-- tab). The move links each one to the entity with the same name, or
-- creates it, and then clears the copied columns here.
ALTER TABLE customers ADD COLUMN entity_id bigint;
COMMENT ON COLUMN customers.entity_id IS 'The customer in Ledger''s shared list of customers and vendors (its entities); name, email, phone, address and notes are there';
CREATE INDEX customers_entity_idx ON customers (entity_id);

-- A linked row keeps no name of its own.
ALTER TABLE customers DROP CONSTRAINT customers_name_check;
ALTER TABLE customers ADD CONSTRAINT customers_name_or_entity CHECK (entity_id IS NOT NULL OR length(name) BETWEEN 1 AND 200);
