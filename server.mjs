// Invoices & customers for Ledger. Ledger loads this file at startup and calls
// register(ctx); the API it gets is described in Ledger's docs/MODULES.md.
//
// Invoices go draft → open (issued) → paid, or open → void. Issuing posts
// the invoice to the books (Dr receivable, Cr revenue and tax) when ledger
// posting is on, payments post Dr bank / Cr receivable, and voiding reverses
// the invoice's entry. Every route is under /api/v1/m/invoices.

import { addDays, computeTotals, formatDecimal, formatMoney, isDate, MAX_CENTS, parseDecimal, today } from "./lib/money.mjs";
import { buildMessage, isEmail, parseAddressList, sendMail } from "./lib/mail.mjs";
import { renderInvoicePdf } from "./lib/pdf.mjs";

const CURRENCIES = ["CAD", "USD"];
const ACCOUNT_ROLES = ["receivable", "revenue", "tax", "bank"];
const MAX_LINES = 200;
// Column types for parameters in INSERT ... SELECT, where Postgres can't infer them.
const COLUMN_TYPES = {
	customer_id: "bigint",
	issue_date: "date",
	due_date: "date",
	currency: "text",
	po_number: "text",
	notes: "text",
	subtotal_cents: "bigint",
	tax_cents: "bigint",
	total_cents: "bigint",
};

/** @param {import("../Bookeeping/backend/src/module-host.ts").ModuleContext} ctx */
export default async function register(ctx) {
	const T = (name) => `${ctx.schema}.${name}`;
	const q = (sql, params) => ctx.db.query(sql, params);
	const bad = (msg) => new ctx.HttpError(422, msg);
	const notFound = (what) => new ctx.HttpError(404, `no such ${what}`);
	const conflict = (msg) => new ctx.HttpError(409, msg);

	// ---- input helpers ------------------------------------------------------

	const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

	function text(o, field, max, { required = false, multiline = false } = {}) {
		const v = o[field];
		if (v === undefined || v === null) {
			if (required) throw bad(`${field} is required`);
			return "";
		}
		if (typeof v !== "string") throw bad(`${field} must be text`);
		const s = multiline ? v.replace(/\r\n/g, "\n").trim() : v.replace(/\s+/g, " ").trim();
		if (required && s === "") throw bad(`${field} is required`);
		if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
		return s;
	}

	function intIn(v, field, min, max) {
		const n = typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
		if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number from ${min} to ${max}`);
		return n;
	}

	function dateField(v, field) {
		if (!isDate(v)) throw bad(`${field} must be a date (YYYY-MM-DD)`);
		return v;
	}

	function currency(v, field = "currency") {
		const c = typeof v === "string" ? v.toUpperCase() : "";
		if (!CURRENCIES.includes(c)) throw bad(`${field} must be ${CURRENCIES.join(" or ")}`);
		return c;
	}

	function decimal(v, scale, field) {
		try {
			return parseDecimal(v, scale, field);
		} catch (e) {
			throw bad(e.message);
		}
	}

	function id(req, name = "id") {
		const s = req.params[name];
		if (!/^\d{1,18}$/.test(s)) throw notFound(name === "id" ? "record" : name);
		return s;
	}

	/** "%", "_" and "\" are literal in searches. */
	const like = (s) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

	// ---- settings -------------------------------------------------------------

	async function loadSettings() {
		const { rows } = await q(`SELECT * FROM ${T("settings")} WHERE id = 1`);
		return rows[0];
	}

	function publicSettings(s) {
		const { smtp_password, id: _id, ...rest } = s;
		return { ...rest, smtp_password_set: smtp_password !== "", email_ready: Boolean(s.smtp_host && s.from_email) };
	}

	const SETTINGS_TEXT = {
		business_name: [200],
		business_address: [1000, true],
		business_phone: [50],
		tax_id: [50],
		tax_label: [30],
		footer: [2000, true],
		smtp_host: [255],
		smtp_username: [255],
		from_name: [200],
		email_subject: [300],
		email_body: [5000, true],
	};

	async function checkAccount(code, cur, field) {
		let a;
		try {
			a = await ctx.ledger.getAccount(code);
		} catch {
			throw bad(`${field}: there is no account ${code}`);
		}
		if (a.currency !== cur) throw bad(`${field}: account ${code} is in ${a.currency}, not ${cur}`);
		if (!a.is_active) throw bad(`${field}: account ${code} is inactive`);
	}

	async function updateSettings(o) {
		const sets = [];
		const params = [];
		const set = (col, v) => (params.push(v), sets.push(`${col} = $${params.length}`));
		for (const [k, [max, multiline]] of Object.entries(SETTINGS_TEXT)) if (k in o) set(k, text(o, k, max, { multiline }));
		for (const k of ["business_email", "from_email", "reply_to"]) {
			if (!(k in o)) continue;
			const v = text(o, k, 254);
			if (v && !isEmail(v)) throw bad(`${k} is not a valid email address`);
			set(k, v);
		}
		if ("smtp_password" in o && o.smtp_password !== null) {
			if (typeof o.smtp_password !== "string" || o.smtp_password.length > 500) throw bad("smtp_password must be text");
			set("smtp_password", o.smtp_password);
		}
		if ("invoice_prefix" in o) {
			const p = text(o, "invoice_prefix", 20);
			if (!/^[A-Za-z0-9#/._-]*$/.test(p)) throw bad("invoice_prefix may only contain letters, digits and # / . _ -");
			set("invoice_prefix", p);
		}
		if ("next_number" in o) set("next_number", intIn(o.next_number, "next_number", 1, 999_999_999));
		if ("default_currency" in o) set("default_currency", currency(o.default_currency, "default_currency"));
		if ("default_terms_days" in o) set("default_terms_days", intIn(o.default_terms_days, "default_terms_days", 0, 365));
		if ("default_tax_rate" in o) set("default_tax_rate", rate(o.default_tax_rate, "default_tax_rate"));
		if ("smtp_port" in o) set("smtp_port", intIn(o.smtp_port, "smtp_port", 1, 65535));
		if ("smtp_security" in o) {
			if (!["tls", "starttls", "none"].includes(o.smtp_security)) throw bad("smtp_security must be tls, starttls or none");
			set("smtp_security", o.smtp_security);
		}
		for (const k of ["post_to_ledger", "bcc_self"]) {
			if (!(k in o)) continue;
			if (typeof o[k] !== "boolean") throw bad(`${k} must be true or false`);
			set(k, o[k]);
		}
		if ("accounts" in o) {
			const a = o.accounts && typeof o.accounts === "object" ? o.accounts : {};
			const clean = {};
			for (const cur of CURRENCIES) {
				clean[cur] = {};
				for (const role of ACCOUNT_ROLES) {
					const code = typeof a[cur]?.[role] === "string" ? a[cur][role].trim() : "";
					if (code) await checkAccount(code, cur, `accounts.${cur}.${role}`);
					clean[cur][role] = code;
				}
			}
			set("accounts", JSON.stringify(clean));
		}
		if (sets.length) await q(`UPDATE ${T("settings")} SET ${sets.join(", ")}, updated_at = now() WHERE id = 1`, params);
		return loadSettings();
	}

	/** Percent text ("13", "14.975") → thousandths of a percent. */
	function rate(v, field) {
		const r = decimal(v ?? "0", 3, field);
		if (r < 0n || r > 100000n) throw bad(`${field} must be between 0 and 100`);
		return Number(r);
	}

	/** The ledger accounts for a currency, checking the roles needed are set. */
	function accountsFor(s, cur, roles) {
		const a = s.accounts?.[cur] ?? {};
		const missing = roles.filter((r) => !a[r]);
		if (missing.length) throw bad(`Ledger posting is on, but no ${missing.join(", ")} account is set for ${cur} (Settings → Ledger posting)`);
		return a;
	}

	// ---- customers ------------------------------------------------------------

	function customerInput(o, partial) {
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
		if (has("currency") && (o.currency !== undefined || !partial)) out.currency = o.currency === undefined ? null : currency(o.currency);
		if (has("terms_days")) out.terms_days = o.terms_days === null || o.terms_days === "" || o.terms_days === undefined ? null : intIn(o.terms_days, "terms_days", 0, 365);
		if (has("archived")) {
			if (o.archived !== undefined && typeof o.archived !== "boolean") throw bad("archived must be true or false");
			out.archived = o.archived ?? false;
		}
		return out;
	}

	const OUTSTANDING = (alias) => `(
		SELECT coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'cents', due) ORDER BY currency), '[]')
		  FROM (SELECT currency, sum(total_cents - paid_cents) AS due FROM ${T("invoices")}
		         WHERE customer_id = ${alias}.id AND status = 'open' GROUP BY currency) x) AS outstanding`;

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
			        (SELECT count(*) FROM ${T("invoices")} i WHERE i.customer_id = c.id AND i.status <> 'draft') AS invoice_count
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
		const c = customerInput(body(req), false);
		c.currency ??= s.default_currency;
		const cols = Object.keys(c);
		const { rows } = await q(
			`INSERT INTO ${T("customers")} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
			Object.values(c),
		);
		return ctx.response(201, await getCustomer(rows[0].id));
	});

	ctx.route("GET", "/customers/:id", async (req) => {
		const c = await getCustomer(id(req));
		const { rows } = await q(
			`SELECT id, number, status, issue_date::text, due_date::text, currency, total_cents, paid_cents, sent_at
			   FROM ${T("invoices")} WHERE customer_id = $1 ORDER BY issue_date DESC, id DESC`,
			[c.id],
		);
		const t = today();
		return { ...c, invoices: rows.map((i) => ({ ...i, overdue: i.status === "open" && i.due_date < t })) };
	});

	ctx.route("PUT", "/customers/:id", async (req) => {
		const cid = id(req);
		const c = customerInput(body(req), true);
		if (c.currency === null) delete c.currency;
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
		const cid = id(req);
		const { rows } = await q(`SELECT count(*)::int AS n FROM ${T("invoices")} WHERE customer_id = $1`, [cid]);
		if (rows[0].n > 0) throw conflict("this customer has invoices; archive them instead");
		const { rowCount } = await q(`DELETE FROM ${T("customers")} WHERE id = $1`, [cid]);
		if (rowCount === 0) throw notFound("customer");
	});

	// ---- invoices ---------------------------------------------------------------

	/** Validates an invoice body; returns the columns and the computed lines. */
	async function invoiceInput(o, s, existing) {
		const customerId = o.customer_id ?? existing?.customer_id;
		if (customerId === undefined || customerId === null || !/^\d{1,18}$/.test(String(customerId))) throw bad("customer_id is required");
		const { rows } = await q(`SELECT id, currency, terms_days, archived FROM ${T("customers")} WHERE id = $1`, [String(customerId)]);
		const cust = rows[0];
		if (!cust) throw bad("customer_id: there is no such customer");
		if (cust.archived && String(existing?.customer_id) !== String(cust.id)) throw bad("customer_id: this customer is archived");

		const issue = o.issue_date === undefined ? (existing?.issue_date ?? today()) : dateField(o.issue_date, "issue_date");
		const terms = cust.terms_days ?? s.default_terms_days;
		const due = o.due_date === undefined || o.due_date === "" || o.due_date === null ? (existing && o.issue_date === undefined ? existing.due_date : addDays(issue, terms)) : dateField(o.due_date, "due_date");
		if (due < issue) throw bad("due_date can't be before issue_date");
		const cur = o.currency === undefined ? (existing?.currency ?? cust.currency) : currency(o.currency);

		const rawLines = o.lines === undefined && existing ? null : o.lines;
		let lines = existing?.lines ?? [];
		if (rawLines !== null) {
			if (!Array.isArray(rawLines) || rawLines.length === 0) throw bad("lines: add at least one line");
			if (rawLines.length > MAX_LINES) throw bad(`lines: at most ${MAX_LINES} lines`);
			lines = rawLines.map((l, i) => {
				const f = (k) => `lines[${i + 1}].${k}`;
				if (!l || typeof l !== "object") throw bad(`${f("description")} is required`);
				const description = text(l, "description", 1000, { required: true, multiline: true });
				const quantity = decimal(l.quantity ?? "1", 3, f("quantity"));
				if (quantity <= 0n || quantity > 10n ** 12n) throw bad(`${f("quantity")} must be more than 0`);
				const unit = decimal(l.unit_price ?? "", 2, f("unit_price"));
				if (unit > MAX_CENTS || unit < -MAX_CENTS) throw bad(`${f("unit_price")} is too large`);
				return { position: i + 1, description, quantity, unit_price_cents: unit, tax_rate: rate(l.tax_rate ?? "0", f("tax_rate")) };
			});
		}
		const totals = computeTotals(lines);
		if (totals.total > MAX_CENTS || totals.total < -MAX_CENTS) throw bad("the invoice total is too large");
		return {
			cols: {
				customer_id: String(cust.id),
				issue_date: issue,
				due_date: due,
				currency: cur,
				po_number: o.po_number === undefined ? (existing?.po_number ?? "") : text(o, "po_number", 100),
				notes: o.notes === undefined ? (existing?.notes ?? "") : text(o, "notes", 5000, { multiline: true }),
				subtotal_cents: totals.subtotal.toString(),
				tax_cents: totals.tax.toString(),
				total_cents: totals.total.toString(),
			},
			linesJson: JSON.stringify(
				lines.map((l, i) => ({
					position: i + 1,
					description: l.description,
					quantity: l.quantity.toString(),
					unit_price_cents: l.unit_price_cents.toString(),
					tax_rate: Number(l.tax_rate),
					amount_cents: totals.amounts[i].toString(),
				})),
			),
		};
	}

	const LINES_FROM_JSON = (src) => `
		INSERT INTO ${T("invoice_lines")} (invoice_id, position, description, quantity, unit_price_cents, tax_rate, amount_cents)
		SELECT ${src}.id, x.position, x.description, x.quantity, x.unit_price_cents, x.tax_rate, x.amount_cents
		  FROM ${src}, jsonb_to_recordset($LINES::jsonb)
		       AS x(position int, description text, quantity bigint, unit_price_cents bigint, tax_rate int, amount_cents bigint)`;

	/** Inserts a draft with the next invoice number, skipping numbers already taken. */
	async function insertInvoice(cols, linesJson, user) {
		const names = Object.keys(cols);
		const params = [...Object.values(cols), user.username, linesJson];
		const sql = `
			WITH n AS (
				UPDATE ${T("settings")} SET next_number = next_number + 1 WHERE id = 1
				RETURNING invoice_prefix || lpad((next_number - 1)::text, 4, '0') AS number
			), inv AS (
				INSERT INTO ${T("invoices")} (number, ${names.join(", ")}, created_by)
				SELECT n.number, ${names.map((k, i) => `$${i + 1}::${COLUMN_TYPES[k]}`).join(", ")}, $${names.length + 1}::text FROM n
				RETURNING id
			), lines AS (${LINES_FROM_JSON("inv").replace("$LINES", `$${names.length + 2}`)})
			SELECT id FROM inv`;
		for (let attempt = 0; ; attempt++) {
			try {
				const { rows } = await q(sql, params);
				return rows[0].id;
			} catch (e) {
				if (e?.code !== "23505" || attempt >= 100) throw e;
				// The number is taken (e.g. Next number was set back); the failed
				// statement rolled back, so step past it and try again.
				await q(`UPDATE ${T("settings")} SET next_number = next_number + 1 WHERE id = 1`);
			}
		}
	}

	async function getInvoice(iid) {
		const { rows } = await q(
			`SELECT i.*, i.issue_date::text, i.due_date::text,
			        jsonb_build_object('id', c.id, 'name', c.name, 'company', c.company, 'email', c.email, 'cc_emails', c.cc_emails,
			                           'address', c.address, 'tax_id', c.tax_id, 'phone', c.phone) AS customer
			   FROM ${T("invoices")} i JOIN ${T("customers")} c ON c.id = i.customer_id
			  WHERE i.id = $1`,
			[iid],
		);
		const inv = rows[0];
		if (!inv) throw notFound("invoice");
		const [lines, payments, emails] = await Promise.all([
			q(`SELECT id, position, description, quantity, unit_price_cents, tax_rate, amount_cents FROM ${T("invoice_lines")} WHERE invoice_id = $1 ORDER BY position, id`, [iid]),
			q(`SELECT id, payment_date::text, amount_cents, method, reference, journal_entry_id, created_by, created_at FROM ${T("payments")} WHERE invoice_id = $1 ORDER BY payment_date, id`, [iid]),
			q(`SELECT id, recipients, subject, ok, error, sent_by, sent_at FROM ${T("email_log")} WHERE invoice_id = $1 ORDER BY id DESC LIMIT 50`, [iid]),
		]);
		inv.lines = lines.rows.map((l) => ({ ...l, quantity_text: formatDecimal(l.quantity, 3), tax_rate_text: formatDecimal(l.tax_rate, 3) }));
		inv.payments = payments.rows;
		inv.emails = emails.rows;
		inv.taxes = computeTotals(inv.lines).taxes;
		inv.balance_cents = inv.status === "void" ? 0n : BigInt(inv.total_cents) - BigInt(inv.paid_cents);
		inv.overdue = inv.status === "open" && inv.due_date < today();
		return inv;
	}

	ctx.route("GET", "/invoices", async (req) => {
		const status = req.query.get("status") ?? "";
		const search = (req.query.get("q") ?? "").trim();
		const customer = req.query.get("customer_id") ?? "";
		if (customer && !/^\d{1,18}$/.test(customer)) throw bad("customer_id is not valid");
		const where = {
			"": "true",
			draft: "i.status IN ('draft', 'posting')",
			open: "i.status = 'open'",
			overdue: "i.status = 'open' AND i.due_date < $4::date",
			paid: "i.status = 'paid'",
			void: "i.status = 'void'",
		}[status];
		if (!where) throw bad("status must be draft, open, overdue, paid or void");
		const { rows } = await q(
			`SELECT i.id, i.number, i.status, i.issue_date::text, i.due_date::text, i.currency, i.total_cents, i.paid_cents,
			        i.sent_at, i.customer_id, c.name AS customer_name, c.company AS customer_company
			   FROM ${T("invoices")} i JOIN ${T("customers")} c ON c.id = i.customer_id
			  WHERE ${where}
			    AND ($1 = '' OR i.number ILIKE $2 OR c.name ILIKE $2 OR c.company ILIKE $2 OR i.po_number ILIKE $2)
			    AND ($3 = '' OR i.customer_id = nullif($3, '')::bigint)
			    AND $4::date IS NOT NULL
			  ORDER BY i.issue_date DESC, i.id DESC
			  LIMIT 500`,
			[search, like(search), customer, today()],
		);
		const t = today();
		return { data: rows.map((i) => ({ ...i, overdue: i.status === "open" && i.due_date < t })) };
	});

	ctx.route("POST", "/invoices", async (req) => {
		const s = await loadSettings();
		const { cols, linesJson } = await invoiceInput(body(req), s, null);
		return ctx.response(201, await getInvoice(await insertInvoice(cols, linesJson, req.user)));
	});

	ctx.route("GET", "/invoices/:id", async (req) => getInvoice(id(req)));

	ctx.route("PUT", "/invoices/:id", async (req) => {
		const existing = await getInvoice(id(req));
		if (existing.status !== "draft") throw conflict("only draft invoices can be edited");
		const s = await loadSettings();
		const { cols, linesJson } = await invoiceInput(body(req), s, existing);
		const names = Object.keys(cols);
		// One statement, so the invoice and its lines change together, and only while it's still a draft.
		const { rows } = await q(
			`WITH upd AS (
				UPDATE ${T("invoices")} SET ${names.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now()
				 WHERE id = $1 AND status = 'draft' RETURNING id
			), del AS (
				DELETE FROM ${T("invoice_lines")} WHERE invoice_id IN (SELECT id FROM upd)
			), ins AS (${LINES_FROM_JSON("upd").replace("$LINES", `$${names.length + 2}`)})
			SELECT id FROM upd`,
			[existing.id, ...Object.values(cols), linesJson],
		);
		if (!rows[0]) throw conflict("only draft invoices can be edited");
		return getInvoice(existing.id);
	});

	ctx.route("DELETE", "/invoices/:id", async (req) => {
		const iid = id(req);
		const { rowCount } = await q(`DELETE FROM ${T("invoices")} WHERE id = $1 AND status = 'draft'`, [iid]);
		if (rowCount === 0) {
			await getInvoice(iid); // 404 when missing
			throw conflict("only drafts can be deleted; void an issued invoice instead");
		}
	});

	ctx.route("POST", "/invoices/:id/duplicate", async (req) => {
		const src = await getInvoice(id(req));
		const s = await loadSettings();
		const { cols, linesJson } = await invoiceInput(
			{
				customer_id: src.customer_id,
				issue_date: today(),
				currency: src.currency,
				po_number: "",
				notes: src.notes,
				lines: src.lines.map((l) => ({
					description: l.description,
					quantity: formatDecimal(l.quantity, 3),
					unit_price: formatDecimal(l.unit_price_cents, 2),
					tax_rate: formatDecimal(l.tax_rate, 3),
				})),
			},
			s,
			null,
		);
		return ctx.response(201, await getInvoice(await insertInvoice(cols, linesJson, req.user)));
	});

	/** Issues a draft: locks it, posts it to the books when enabled, and marks it open. */
	async function issueInvoice(iid, user) {
		const s = await loadSettings();
		const claimed = await q(`UPDATE ${T("invoices")} SET status = 'posting', updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id`, [iid]);
		if (claimed.rowCount === 0) {
			const inv = await getInvoice(iid);
			throw conflict(inv.status === "posting" ? "this invoice is being issued right now" : `invoice ${inv.number} is already issued`);
		}
		let entryId = null;
		try {
			const inv = await getInvoice(iid);
			const totals = computeTotals(inv.lines);
			if (totals.total <= 0n) throw bad("the invoice total must be more than zero");
			if (s.post_to_ledger) {
				if (totals.subtotal <= 0n || totals.tax < 0n) throw bad("to post to the books, the subtotal must be positive and the tax not negative");
				const a = accountsFor(s, inv.currency, totals.tax > 0n ? ["receivable", "revenue", "tax"] : ["receivable", "revenue"]);
				const memo = `Invoice ${inv.number}`;
				const lines = [
					{ account_code: a.receivable, debit_cents: totals.total, memo },
					{ account_code: a.revenue, credit_cents: totals.subtotal, memo },
				];
				if (totals.tax > 0n) lines.push({ account_code: a.tax, credit_cents: totals.tax, memo: `${s.tax_label || "Tax"} on ${memo}` });
				const entry = await ctx.ledger.createJournalEntry(
					{ entry_date: inv.issue_date, description: `Invoice ${inv.number} – ${inv.customer.name}`.slice(0, 500), reference: inv.number.slice(0, 100), lines },
					user,
				);
				entryId = String(entry.id);
			}
			await q(
				`UPDATE ${T("invoices")} SET status = 'open', journal_entry_id = $2, issued_at = now(), updated_at = now(),
				        subtotal_cents = $3, tax_cents = $4, total_cents = $5
				  WHERE id = $1`,
				[iid, entryId, totals.subtotal.toString(), totals.tax.toString(), totals.total.toString()],
			);
		} catch (e) {
			if (entryId === null) await q(`UPDATE ${T("invoices")} SET status = 'draft' WHERE id = $1 AND status = 'posting'`, [iid]);
			throw e;
		}
		ctx.log.info("invoice issued", { invoice: iid, entry: entryId, user: user.username });
		return getInvoice(iid);
	}

	ctx.route("POST", "/invoices/:id/issue", async (req) => issueInvoice(id(req), req.user));

	ctx.route("POST", "/invoices/:id/void", async (req) => {
		const iid = id(req);
		const o = body(req);
		const date = o.date === undefined || o.date === "" ? today() : dateField(o.date, "date");
		const { rows } = await q(
			`UPDATE ${T("invoices")} SET status = 'void', updated_at = now()
			  WHERE id = $1 AND status = 'open' AND paid_cents = 0 RETURNING number, journal_entry_id`,
			[iid],
		);
		if (!rows[0]) {
			const inv = await getInvoice(iid);
			if (inv.status === "draft") throw conflict("drafts aren't in the books; delete it instead");
			if (inv.status === "void") throw conflict("this invoice is already void");
			throw conflict("remove this invoice's payments before voiding it");
		}
		const { number, journal_entry_id } = rows[0];
		if (journal_entry_id !== null) {
			try {
				const rev = await ctx.ledger.reverseJournalEntry(journal_entry_id, { entry_date: date, description: `Void invoice ${number}` }, req.user);
				await q(`UPDATE ${T("invoices")} SET void_entry_id = $2 WHERE id = $1`, [iid, String(rev.id)]);
			} catch (e) {
				await q(`UPDATE ${T("invoices")} SET status = 'open' WHERE id = $1 AND status = 'void'`, [iid]);
				throw e;
			}
		}
		return getInvoice(iid);
	});

	// ---- payments ---------------------------------------------------------------

	ctx.route("POST", "/invoices/:id/payments", async (req) => {
		const iid = id(req);
		const o = body(req);
		const s = await loadSettings();
		const date = o.payment_date === undefined || o.payment_date === "" ? today() : dateField(o.payment_date, "payment_date");
		const amount = decimal(o.amount, 2, "amount");
		if (amount <= 0n) throw bad("amount must be more than zero");
		const method = text(o, "method", 50);
		const reference = text(o, "reference", 100);

		const before = await getInvoice(iid);
		if (before.status !== "open") throw conflict(`payments can only be recorded on issued, unpaid invoices (this one is ${before.status})`);
		if (amount > before.balance_cents) throw bad(`amount is more than the balance due (${formatMoney(before.balance_cents, before.currency)})`);
		const post = s.post_to_ledger && before.journal_entry_id !== null;
		const accounts = post ? accountsFor(s, before.currency, ["receivable", "bank"]) : null;

		// Record the payment and raise paid_cents in one statement, only if it still fits the balance.
		const { rows } = await q(
			`WITH inv AS (
				UPDATE ${T("invoices")}
				   SET paid_cents = paid_cents + $2, updated_at = now(),
				       status = CASE WHEN paid_cents + $2 >= total_cents THEN 'paid' ELSE status END
				 WHERE id = $1 AND status = 'open' AND paid_cents + $2 <= total_cents
				RETURNING id
			)
			INSERT INTO ${T("payments")} (invoice_id, payment_date, amount_cents, method, reference, created_by)
			SELECT id, $3::date, $2::bigint, $4::text, $5::text, $6::text FROM inv RETURNING id`,
			[iid, amount.toString(), date, method, reference, req.user.username],
		);
		if (!rows[0]) throw conflict("the invoice changed meanwhile; reload and try again");
		const pid = rows[0].id;
		if (post) {
			try {
				const memo = `Payment on invoice ${before.number}`;
				const entry = await ctx.ledger.createJournalEntry(
					{
						entry_date: date,
						description: `${memo} – ${before.customer.name}`.slice(0, 500),
						reference: (reference || before.number).slice(0, 100),
						lines: [
							{ account_code: accounts.bank, debit_cents: amount, memo },
							{ account_code: accounts.receivable, credit_cents: amount, memo },
						],
					},
					req.user,
				);
				await q(`UPDATE ${T("payments")} SET journal_entry_id = $2 WHERE id = $1`, [pid, String(entry.id)]);
			} catch (e) {
				await removePayment(iid, pid);
				throw e;
			}
		}
		return ctx.response(201, await getInvoice(iid));
	});

	/** Deletes a payment row and takes it off the invoice; returns the deleted payment or null. */
	async function removePayment(iid, pid) {
		const { rows } = await q(
			`WITH p AS (DELETE FROM ${T("payments")} WHERE id = $2 AND invoice_id = $1 RETURNING amount_cents, journal_entry_id),
			      inv AS (UPDATE ${T("invoices")} i
			                 SET paid_cents = i.paid_cents - p.amount_cents, updated_at = now(),
			                     status = CASE WHEN i.status = 'paid' THEN 'open' ELSE i.status END
			                FROM p WHERE i.id = $1)
			 SELECT * FROM p`,
			[iid, pid],
		);
		return rows[0] ?? null;
	}

	ctx.route("DELETE", "/invoices/:id/payments/:pid", async (req) => {
		const iid = id(req);
		const pid = id(req, "pid");
		const inv = await getInvoice(iid);
		const p = inv.payments.find((x) => String(x.id) === pid);
		if (!p) throw notFound("payment");
		// Reverse first: if that fails, nothing has changed. A second concurrent
		// attempt fails here too, since Ledger reverses an entry only once.
		if (p.journal_entry_id !== null) {
			await ctx.ledger.reverseJournalEntry(p.journal_entry_id, { entry_date: today(), description: `Removed payment on invoice ${inv.number}` }, req.user);
		}
		await removePayment(iid, pid);
		return getInvoice(iid);
	});

	// ---- PDF and email ------------------------------------------------------------

	const pdfName = (inv) => `Invoice-${inv.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;

	ctx.route("GET", "/invoices/:id/pdf", async (req) => {
		const inv = await getInvoice(id(req));
		const pdf = renderInvoicePdf(inv, await loadSettings());
		return { filename: pdfName(inv), content_type: "application/pdf", content_base64: pdf.toString("base64") };
	});

	function fill(template, inv, s) {
		const vars = {
			number: inv.number,
			customer: inv.customer.name,
			company: inv.customer.company || inv.customer.name,
			total: formatMoney(inv.total_cents, inv.currency),
			balance: formatMoney(inv.balance_cents, inv.currency),
			due_date: inv.due_date,
			issue_date: inv.issue_date,
			business: s.business_name || s.from_name || "",
		};
		return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
	}

	function emailDefaults(inv, s) {
		return {
			to: inv.customer.email,
			cc: inv.customer.cc_emails,
			subject: fill(s.email_subject, inv, s),
			message: fill(s.email_body, inv, s),
		};
	}

	const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

	function emailHtml(message, inv) {
		const paras = message
			.split(/\n{2,}/)
			.map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
			.join("");
		const row = (k, v, strong) =>
			`<tr><td style="padding:4px 16px 4px 0;color:#5d6875">${esc(k)}</td><td style="padding:4px 0;text-align:right${strong ? ";font-weight:600" : ""}">${esc(v)}</td></tr>`;
		return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:24px;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d232b">
${paras}
<table style="border-collapse:collapse;margin-top:8px;font-size:14px">
${row("Invoice", inv.number)}${row("Issued", inv.issue_date)}${row("Due", inv.due_date)}${row("Amount due", formatMoney(inv.balance_cents, inv.currency), true)}
</table>
<p style="margin:16px 0 0;color:#5d6875;font-size:13px">The invoice is attached as a PDF.</p>
</div></body></html>`;
	}

	function smtpServer(s) {
		return { host: s.smtp_host, port: s.smtp_port, security: s.smtp_security, username: s.smtp_username, password: s.smtp_password };
	}

	async function deliver(s, { to, cc, bcc, subject, text: plain, html, attachments }) {
		if (!s.smtp_host) throw bad("no mail server is set up yet (Settings → Email)");
		if (!s.from_email) throw bad("set the sender address in Settings → Email");
		const msg = buildMessage({ from: s.from_email, fromName: s.from_name || s.business_name, to, cc, bcc, replyTo: s.reply_to, subject, text: plain, html, attachments });
		return sendMail(smtpServer(s), { from: s.from_email, ...msg });
	}

	function addresses(v, field, required) {
		try {
			const list = parseAddressList(v);
			if (required && list.length === 0) throw new RangeError("add at least one recipient");
			if (list.length > 20) throw new RangeError("at most 20 addresses");
			return list;
		} catch (e) {
			throw bad(`${field}: ${e.message}`);
		}
	}

	ctx.route("GET", "/invoices/:id/email", async (req) => {
		const inv = await getInvoice(id(req));
		return emailDefaults(inv, await loadSettings());
	});

	ctx.route("POST", "/invoices/:id/send", async (req) => {
		const iid = id(req);
		const o = body(req);
		const s = await loadSettings();
		let inv = await getInvoice(iid);
		if (inv.status === "void") throw conflict("this invoice is void");
		const d = emailDefaults(inv, s);
		const to = addresses(o.to ?? d.to, "to", true);
		const cc = addresses(o.cc ?? d.cc, "cc", false);
		const subject = o.subject === undefined ? d.subject : text(o, "subject", 300, { required: true });
		const message = o.message === undefined ? d.message : text(o, "message", 10000, { multiline: true });
		if (!s.smtp_host || !s.from_email) throw bad("set up email first (Settings → Email)");
		if (inv.status === "draft") inv = await issueInvoice(iid, req.user);

		const bcc = s.bcc_self ? [s.from_email] : [];
		const recipients = [...to, ...cc].join(", ");
		try {
			const pdf = renderInvoicePdf(inv, s);
			await deliver(s, {
				to,
				cc,
				bcc,
				subject,
				text: message + `\n\nInvoice ${inv.number}\nDue ${inv.due_date}\nAmount due ${formatMoney(inv.balance_cents, inv.currency)}\n`,
				html: emailHtml(message, inv),
				attachments: [{ filename: pdfName(inv), contentType: "application/pdf", content: pdf }],
			});
		} catch (e) {
			const msg = e instanceof ctx.HttpError ? e.message : `sending failed: ${e.message}`;
			await q(`INSERT INTO ${T("email_log")} (invoice_id, recipients, subject, ok, error, sent_by) VALUES ($1, $2, $3, false, $4, $5)`, [iid, recipients, subject, msg.slice(0, 1000), req.user.username]);
			ctx.log.warn("invoice email failed", { invoice: iid, err: e.message });
			throw e instanceof ctx.HttpError ? e : new ctx.HttpError(502, msg);
		}
		await q(`INSERT INTO ${T("email_log")} (invoice_id, recipients, subject, ok, sent_by) VALUES ($1, $2, $3, true, $4)`, [iid, recipients, subject, req.user.username]);
		await q(`UPDATE ${T("invoices")} SET sent_at = now() WHERE id = $1`, [iid]);
		ctx.log.info("invoice emailed", { invoice: iid, to: recipients, user: req.user.username });
		return getInvoice(iid);
	});

	// ---- settings routes, accounts, summary ----------------------------------------------

	ctx.route("GET", "/settings", async () => publicSettings(await loadSettings()));
	ctx.route("PUT", "/settings", async (req) => publicSettings(await updateSettings(body(req))));

	ctx.route("POST", "/settings/test-email", async (req) => {
		const s = await loadSettings();
		const to = addresses(body(req).to || s.from_email, "to", true);
		try {
			const reply = await deliver(s, {
				to,
				cc: [],
				bcc: [],
				subject: "Test email from Ledger invoices",
				text: `This is a test from the Ledger invoices module.\nIf you can read it, invoices can be emailed from ${s.from_email}.\n`,
			});
			return { ok: true, to, server_reply: reply };
		} catch (e) {
			if (e instanceof ctx.HttpError) throw e;
			throw new ctx.HttpError(502, `sending failed: ${e.message}`);
		}
	});

	ctx.route("GET", "/accounts", async () => {
		const accounts = await ctx.ledger.listAccounts();
		return { data: accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency })) };
	});

	ctx.route("GET", "/summary", async () => {
		const t = today();
		const { rows } = await q(
			`SELECT currency,
			        coalesce(sum(total_cents - paid_cents) FILTER (WHERE status = 'open'), 0)::bigint AS outstanding_cents,
			        coalesce(sum(total_cents - paid_cents) FILTER (WHERE status = 'open' AND due_date < $1::date), 0)::bigint AS overdue_cents,
			        count(*) FILTER (WHERE status = 'open') AS open_count,
			        count(*) FILTER (WHERE status = 'open' AND due_date < $1::date) AS overdue_count,
			        coalesce((SELECT sum(p.amount_cents) FROM ${T("payments")} p JOIN ${T("invoices")} pi ON pi.id = p.invoice_id
			                   WHERE pi.currency = i.currency AND p.payment_date > $1::date - 30), 0)::bigint AS paid_30d_cents
			   FROM ${T("invoices")} i GROUP BY currency ORDER BY currency`,
			[t],
		);
		const counts = await q(
			`SELECT (SELECT count(*) FROM ${T("invoices")} WHERE status IN ('draft', 'posting')) AS drafts,
			        (SELECT count(*) FROM ${T("customers")} WHERE NOT archived) AS customers`,
		);
		return { currencies: rows, ...counts.rows[0] };
	});

	// An invoice left in "posting" means Ledger stopped mid-issue. Its entry
	// may or may not have been posted, so put it back to draft and say so.
	const stuck = await q(`UPDATE ${T("invoices")} SET status = 'draft' WHERE status = 'posting' RETURNING number`);
	for (const r of stuck.rows) ctx.log.warn("invoice was being issued when Ledger stopped; it is a draft again. Check the books for a duplicate entry before issuing it.", { number: r.number });

	ctx.log.info("invoices module ready");
}
