// Sales' customers and Ledger's shared list of customers and vendors
// (ctx.entities, Ledger ≥ 0.16.0). A customer's name, email, phone, address
// and notes live in its entity, shared with Ledger and every other module;
// Sales' own row keeps the rest (company, Cc addresses, tax number,
// currency, payment terms, taxes, archived) and the entity's id.
//
// Rows from before 0.7.0 keep their own name and details until a person
// approves the move (Customers tab): each is linked to the entity with the
// same name, or one is created. Customers added elsewhere in Ledger (under
// Entities) show up in Sales too: adopt() gives each one a Sales row.

// Column types for Sales' row, for INSERT … SELECT (everything else is text).
const CASTS = { entity_id: "bigint", terms_days: "int", tax_ids: "int[]", archived: "boolean" };

const CONTACT = ["name", "email", "phone", "address", "notes"];

export function customerStore(ctx, h) {
	const { T, q, conflict, CUSTOMERS, loadSettings } = h;

	/** Sales' row for an entity, if it has one. */
	async function rowFor(entityId) {
		const { rows } = await q(`SELECT id FROM ${T("customers")} WHERE entity_id = $1`, [String(entityId)]);
		return rows[0]?.id ?? null;
	}

	/** A customer of Sales with this name (linked or not), any capitals. */
	async function byName(name) {
		const { rows } = await q(`SELECT id, name FROM ${CUSTOMERS} c WHERE lower(c.name) = lower($1) LIMIT 1`, [name]);
		return rows[0] ?? null;
	}

	/**
	 * The entity for a new customer: the one with that name (given the
	 * customer role, made active, and with its empty contact details filled
	 * in), or a new one.
	 */
	async function entityFor(contact) {
		const found = await ctx.entities.find(contact.name);
		if (!found) {
			return ctx.entities.create({ name: contact.name, is_customer: true, email: contact.email ?? "", phone: contact.phone ?? "", address: contact.address ?? "", notes: contact.notes ?? "" });
		}
		const change = {};
		if (!found.is_customer) change.is_customer = true;
		if (!found.is_active) change.is_active = true;
		for (const k of ["email", "phone", "address", "notes"]) if (contact[k] && !found[k]) change[k] = contact[k];
		return Object.keys(change).length ? ctx.entities.update(found.id, change) : found;
	}

	/**
	 * Adds a customer: `contact` (name, email, phone, address, notes) goes to
	 * the shared list, `own` (company, cc_emails, tax_id, currency,
	 * terms_days, tax_ids, archived) to Sales. 409 if Sales already has a
	 * customer with that name. Returns Sales' id.
	 */
	async function add(contact, own = {}) {
		if (await byName(contact.name)) throw conflict(`${contact.name} is already a customer`);
		const e = await entityFor(contact);
		const s = await loadSettings();
		const row = { currency: s.default_currency || "CAD", ...own, entity_id: String(e.id), name: "" };
		const cols = Object.keys(row);
		// Never a second row for the same entity, even if two people add it at once.
		const { rows } = await q(
			`INSERT INTO ${T("customers")} (${cols.join(", ")})
			 SELECT ${cols.map((k, i) => `$${i + 1}::${CASTS[k] ?? "text"}`).join(", ")}
			  WHERE NOT EXISTS (SELECT 1 FROM ${T("customers")} WHERE entity_id = $${cols.indexOf("entity_id") + 1}::bigint)
			 RETURNING id`,
			Object.values(row),
		);
		if (!rows[0]) throw conflict(`${contact.name} is already a customer`);
		return rows[0].id;
	}

	/**
	 * Saves changes to a customer: contact details on its entity (or on the
	 * row itself before the move), the rest on Sales' row.
	 */
	async function update(cid, contact, own) {
		const { rows } = await q(`SELECT id, entity_id FROM ${T("customers")} WHERE id = $1`, [String(cid)]);
		const cur = rows[0];
		if (!cur) return false;
		const changes = { ...own };
		if (cur.entity_id === null) Object.assign(changes, contact);
		else {
			const e = { ...contact };
			// Taking a customer out of the archive makes it active in Ledger's list too.
			if (own.archived === false) e.is_active = true;
			if (e.name !== undefined) {
				const other = await byName(e.name);
				if (other && String(other.id) !== String(cid)) throw conflict(`${e.name} is already a customer`);
			}
			if (Object.keys(e).length) await ctx.entities.update(Number(cur.entity_id), e);
		}
		const cols = Object.keys(changes);
		if (cols.length) {
			await q(`UPDATE ${T("customers")} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [String(cid), ...Object.values(changes)]);
		}
		return true;
	}

	/**
	 * Gives every active customer in Ledger's list a Sales row, so customers
	 * added under Entities (or by another module) can be invoiced. Skips names
	 * that a not-yet-moved Sales customer still holds; the move links those.
	 */
	async function adopt() {
		const s = await loadSettings();
		await q(
			`INSERT INTO ${T("customers")} (entity_id, name, currency)
			 SELECT e.id, '', $1 FROM public.entities e
			  WHERE e.is_customer AND e.is_active
			    AND NOT EXISTS (SELECT 1 FROM ${T("customers")} c WHERE c.entity_id = e.id)
			    AND NOT EXISTS (SELECT 1 FROM ${T("customers")} c WHERE c.entity_id IS NULL AND lower(c.name) = lower(e.name))`,
			[s.default_currency || "CAD"],
		);
	}

	/** Customers still kept only in Sales, and what moving each would do. */
	async function movePlan() {
		const { rows } = await q(
			`SELECT c.id, c.name, c.email, c.phone, c.archived, e.id AS entity_id, e.name AS entity_name, e.is_customer, e.is_vendor
			   FROM ${T("customers")} c LEFT JOIN public.entities e ON lower(e.name) = lower(btrim(c.name))
			  WHERE c.entity_id IS NULL
			  ORDER BY lower(c.name), c.id`,
		);
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			email: r.email,
			phone: r.phone,
			archived: r.archived,
			action: r.entity_id === null ? "create" : "link",
			entity: r.entity_id === null ? null : { id: r.entity_id, name: r.entity_name, is_customer: r.is_customer, is_vendor: r.is_vendor },
		}));
	}

	/**
	 * Moves every customer still kept only in Sales into Ledger's list, after
	 * a person approved it: links each to the entity with the same name (or
	 * creates it), then clears the copied details from Sales' row. One that
	 * fails is left as it was and reported; running it again picks it up.
	 */
	async function move(user) {
		const { rows } = await q(`SELECT id, name, email, phone, address, notes, archived FROM ${T("customers")} WHERE entity_id IS NULL ORDER BY id`);
		let linked = 0;
		let created = 0;
		const failed = [];
		for (const c of rows) {
			const name = c.name.replace(/\s+/g, " ").trim();
			try {
				const found = await ctx.entities.find(name);
				let e;
				if (found) {
					const change = {};
					if (!found.is_customer) change.is_customer = true;
					for (const k of ["email", "phone", "address", "notes"]) if (c[k] && !found[k]) change[k] = c[k];
					e = Object.keys(change).length ? await ctx.entities.update(found.id, change) : found;
				} else {
					e = await ctx.entities.create({ name, is_customer: true, email: c.email, phone: c.phone, address: c.address, notes: c.notes });
					// An archived customer stays out of Ledger's pickers too.
					if (c.archived) e = await ctx.entities.update(e.id, { is_active: false });
				}
				const r = await q(
					`UPDATE ${T("customers")} SET entity_id = $2, name = '', email = '', phone = '', address = '', notes = '', updated_at = now()
					  WHERE id = $1 AND entity_id IS NULL`,
					[String(c.id), String(e.id)],
				);
				if (r.rowCount) found ? linked++ : created++;
			} catch (err) {
				failed.push({ id: c.id, name: c.name, error: err.message });
				ctx.log.warn("could not move a customer to Ledger's list", { customer: String(c.id), err: err.message });
			}
		}
		await adopt();
		ctx.log.info("customers moved to Ledger's list", { linked, created, failed: failed.length, user: user?.username });
		return { linked, created, failed };
	}

	/**
	 * Adds several customers ({ contact, own } each); one that's already a
	 * customer (added meanwhile) is skipped. Returns the ids added.
	 */
	async function addMany(list) {
		const ids = [];
		for (const { contact, own } of list) {
			try {
				ids.push(await add(contact, own));
			} catch (e) {
				if (e.status !== 409 && e.statusCode !== 409) throw e;
			}
		}
		return ids;
	}

	return { CONTACT, add, addMany, update, adopt, movePlan, move, byName };
}
