// Customer records, with what each owes and their documents.

import { today } from "../lib/money.mjs";
import { isEmail, parseAddressList } from "../lib/mail.mjs";
import { customerStore } from "./customer-store.mjs";

export function customerRoutes(ctx, h) {
	const { T, q, bad, notFound, conflict, body, text, intIn, bool, currency, id, like, loadSettings, checkTaxIds, CUSTOMERS } = h;
	const store = customerStore(ctx, h);

	/** The form's fields split into what's shared in Ledger's list and what's Sales' own. */
	const split = (c) => {
		const contact = {};
		const own = {};
		for (const [k, v] of Object.entries(c)) (store.CONTACT.includes(k) ? contact : own)[k] = v;
		return { contact, own };
	};

	async function customerInput(o, partial) {
		const out = {};
		const has = (k) => !partial || k in o;
		if (has("name")) out.name = text(o, "name", 200, { required: true });
		for (const [k, max, multiline] of [["company", 200], ["phone", 50], ["address", 1000, true], ["tax_id", 50], ["notes", 5000, true]]) {
			if (has(k)) out[k] = text(o, k, max, { multiline });
		}
		if (has("email")) {
			out.email = text(o, "email", 254);
			if (out.email && !isEmail(out.email)) throw bad("email is not a valid email address");
		}
		if (has("cc_emails")) {
			try {
				out.cc_emails = parseAddressList(text(o, "cc_emails", 1000)).join(", ");
			} catch (e) {
				throw bad(`cc_emails: ${e.message}`);
			}
		}
		if ("currency" in o && o.currency !== undefined) out.currency = currency(o.currency);
		if (has("terms_days")) out.terms_days = o.terms_days === null || o.terms_days === "" || o.terms_days === undefined ? null : intIn(o.terms_days, "terms_days", 0, 365);
		// null: use the default taxes; a list (possibly empty): always these.
		if (has("tax_ids")) out.tax_ids = o.tax_ids === null || o.tax_ids === undefined ? null : await checkTaxIds(o.tax_ids, "tax_ids");
		if ("archived" in o) out.archived = bool(o.archived, "archived");
		return out;
	}

	const OUTSTANDING = (alias) => `(
		SELECT coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'cents', due) ORDER BY currency), '[]')
		  FROM (SELECT currency, sum(total_cents - paid_cents) AS due FROM ${T("documents")}
		         WHERE customer_id = ${alias}.id AND kind = 'invoice' AND status = 'open' GROUP BY currency) x) AS outstanding`;

	async function getCustomer(cid) {
		const { rows } = await q(`SELECT c.*, ${OUTSTANDING("c")} FROM ${CUSTOMERS} c WHERE c.id = $1`, [cid]);
		if (!rows[0]) throw notFound("customer");
		return rows[0];
	}

	ctx.route("GET", "/customers", async (req) => {
		await store.adopt();
		const search = (req.query.get("q") ?? "").trim();
		const archived = req.query.get("archived") === "1";
		const { rows } = await q(
			`SELECT c.*, ${OUTSTANDING("c")},
			        (SELECT count(*) FROM ${T("documents")} d WHERE d.customer_id = c.id AND d.kind = 'invoice' AND d.status <> 'draft') AS invoice_count
			   FROM ${CUSTOMERS} c
			  WHERE ($1 = '' OR c.name ILIKE $2 OR c.company ILIKE $2 OR c.email ILIKE $2)
			    AND ($3 OR NOT c.archived)
			  ORDER BY c.archived, lower(c.name), c.id
			  LIMIT 1000`,
			[search, like(search), archived],
		);
		return { data: rows };
	});

	ctx.route("POST", "/customers", async (req) => {
		const { contact, own } = split(await customerInput(body(req), false));
		const cid = await store.add(contact, own);
		return ctx.response(201, await getCustomer(cid));
	});

	// Customers kept only in Sales (from before 0.7.0) and what moving them
	// into Ledger's shared list would do; the move runs only when a person
	// approves it.
	ctx.route("GET", "/customers/move", async () => {
		const rows = await store.movePlan();
		return { pending: rows.length, data: rows };
	});

	ctx.route("POST", "/customers/move", async (req) => {
		const plan = await store.movePlan();
		if (plan.length === 0) throw conflict("every customer is already in Ledger's list");
		return store.move(req.user);
	});

	ctx.route("GET", "/customers/:id", async (req) => {
		const c = await getCustomer(id(req, "id", "customer"));
		const { rows } = await q(
			`SELECT id, kind, number, status, issue_date::text, due_date::text, currency, total_cents, paid_cents, sent_at
			   FROM ${T("documents")} WHERE customer_id = $1 ORDER BY issue_date DESC, id DESC`,
			[c.id],
		);
		const t = today();
		const docs = rows.map((d) => ({ ...d, overdue: d.kind === "invoice" && d.status === "open" && d.due_date < t, expired: d.kind !== "invoice" && ["draft", "sent"].includes(d.status) && d.due_date < t }));
		const payments = await q(
			`SELECT p.id, p.document_id, d.number AS invoice_number, d.currency, p.payment_date::text, p.amount_cents, p.method, p.reference,
			        p.journal_entry_id, p.matched_entry_id
			   FROM ${T("payments")} p JOIN ${T("documents")} d ON d.id = p.document_id
			  WHERE d.customer_id = $1 ORDER BY p.payment_date DESC, p.id DESC`,
			[c.id],
		);
		return { ...c, documents: docs, payments: payments.rows };
	});

	ctx.route("PUT", "/customers/:id", async (req) => {
		const cid = id(req, "id", "customer");
		const { contact, own } = split(await customerInput(body(req), true));
		if (!(await store.update(cid, contact, own))) throw notFound("customer");
		return getCustomer(cid);
	});

	ctx.route("DELETE", "/customers/:id", async (req) => {
		const cid = id(req, "id", "customer");
		const { rows } = await q(`SELECT count(*)::int AS n FROM ${T("documents")} WHERE customer_id = $1`, [cid]);
		if (rows[0].n > 0) throw conflict("this customer has invoices, quotes or estimates; archive them instead");
		const { rowCount } = await q(`DELETE FROM ${T("customers")} WHERE id = $1`, [cid]);
		if (rowCount === 0) throw notFound("customer");
	});

	return store;
}
