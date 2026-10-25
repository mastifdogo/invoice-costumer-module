// Customer records, with what each owes and their documents.

import { today } from "../lib/money.mjs";
import { isEmail, parseAddressList } from "../lib/mail.mjs";

export function customerRoutes(ctx, h) {
	const { T, q, bad, notFound, conflict, body, text, intIn, bool, currency, id, like, loadSettings, checkTaxIds } = h;

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
		const { rows } = await q(`SELECT c.*, ${OUTSTANDING("c")} FROM ${T("customers")} c WHERE c.id = $1`, [cid]);
		if (!rows[0]) throw notFound("customer");
		return rows[0];
	}

	ctx.route("GET", "/customers", async (req) => {
		const search = (req.query.get("q") ?? "").trim();
		const archived = req.query.get("archived") === "1";
		const { rows } = await q(
			`SELECT c.*, ${OUTSTANDING("c")},
			        (SELECT count(*) FROM ${T("documents")} d WHERE d.customer_id = c.id AND d.kind = 'invoice' AND d.status <> 'draft') AS invoice_count
			   FROM ${T("customers")} c
			  WHERE ($1 = '' OR c.name ILIKE $2 OR c.company ILIKE $2 OR c.email ILIKE $2)
			    AND ($3 OR NOT c.archived)
			  ORDER BY c.archived, lower(c.name), c.id
			  LIMIT 1000`,
			[search, like(search), archived],
		);
		return { data: rows };
	});

	ctx.route("POST", "/customers", async (req) => {
		const s = await loadSettings();
		const c = await customerInput(body(req), false);
		c.currency ??= s.default_currency;
		const cols = Object.keys(c);
		const { rows } = await q(
			`INSERT INTO ${T("customers")} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
			Object.values(c),
		);
		return ctx.response(201, await getCustomer(rows[0].id));
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
		return { ...c, documents: docs };
	});

	ctx.route("PUT", "/customers/:id", async (req) => {
		const cid = id(req, "id", "customer");
		const c = await customerInput(body(req), true);
		const cols = Object.keys(c);
		if (cols.length) {
			const { rowCount } = await q(
				`UPDATE ${T("customers")} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
				[cid, ...Object.values(c)],
			);
			if (rowCount === 0) throw notFound("customer");
		}
		return getCustomer(cid);
	});

	ctx.route("DELETE", "/customers/:id", async (req) => {
		const cid = id(req, "id", "customer");
		const { rows } = await q(`SELECT count(*)::int AS n FROM ${T("documents")} WHERE customer_id = $1`, [cid]);
		if (rows[0].n > 0) throw conflict("this customer has invoices, quotes or estimates; archive them instead");
		const { rowCount } = await q(`DELETE FROM ${T("customers")} WHERE id = $1`, [cid]);
		if (rowCount === 0) throw notFound("customer");
	});
}
