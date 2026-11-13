// Helpers shared by the route files: database access, input validation and
// the module settings. Everything here is built from the module's ctx.

import { isDate, parseDecimal } from "../lib/money.mjs";

export const CURRENCIES = ["CAD", "USD"];

/** The three document kinds, each with its own numbering, routes and statuses. */
export const KINDS = {
	invoice: { label: "Invoice", plural: "invoices", prefix: "invoice_prefix", next: "next_invoice_number", validDays: null },
	quote: { label: "Quote", plural: "quotes", prefix: "quote_prefix", next: "next_quote_number", validDays: "quote_valid_days" },
	estimate: { label: "Estimate", plural: "estimates", prefix: "estimate_prefix", next: "next_estimate_number", validDays: "estimate_valid_days" },
};

export function helpers(ctx) {
	const T = (name) => `${ctx.schema}.${name}`;
	const q = (sql, params) => ctx.db.query(sql, params);
	const bad = (msg) => new ctx.HttpError(422, msg);
	const notFound = (what) => new ctx.HttpError(404, `no such ${what}`);
	const conflict = (msg) => new ctx.HttpError(409, msg);

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

	function bool(v, field) {
		if (typeof v !== "boolean") throw bad(`${field} must be true or false`);
		return v;
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

	/** Percent text ("5", "9.975") → thousandths of a percent. */
	function rate(v, field) {
		const r = decimal(v ?? "0", 3, field);
		if (r < 0n || r > 100000n) throw bad(`${field} must be between 0 and 100`);
		return Number(r);
	}

	/** A database id from a route parameter. */
	function id(req, name = "id", what = "record") {
		const s = req.params[name];
		if (!/^\d{1,18}$/.test(s)) throw notFound(what);
		return s;
	}

	const isId = (v) =>
		(typeof v === "number" && Number.isSafeInteger(v) && v > 0) || (typeof v === "bigint" && v > 0n) || (typeof v === "string" && /^\d{1,18}$/.test(v));

	/** A list of ids (array of numbers/digit strings), deduplicated, as strings. */
	function idList(v, field) {
		if (!Array.isArray(v) || v.length > 20 || !v.every(isId)) throw bad(`${field} must be a list of ids`);
		return [...new Set(v.map(String))];
	}

	/** "%", "_" and "\" are literal in searches. */
	const like = (s) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

	/**
	 * The module's configuration: the values from Ledger's settings form
	 * (ctx.settings), plus the running document numbers and default taxes
	 * kept in the module's own tables. Read per request, so a saved form
	 * applies straight away.
	 */
	async function loadSettings() {
		const [v, counters, defaults] = await Promise.all([
			ctx.settings.get(),
			q(`SELECT next_invoice_number, next_quote_number, next_estimate_number FROM ${T("settings")} WHERE id = 1`),
			q(`SELECT id::int AS id FROM ${T("taxes")} WHERE is_default ORDER BY position, id`),
		]);
		const str = (k) => (typeof v[k] === "string" ? v[k].trim() : "");
		const num = (k, d) => (typeof v[k] === "number" ? v[k] : d);
		const accounts = {};
		for (const cur of CURRENCIES) {
			const c = cur.toLowerCase();
			accounts[cur] = { receivable: str(`receivable_account_${c}`), revenue: str(`revenue_account_${c}`), bank: str(`bank_account_${c}`) };
		}
		return {
			...counters.rows[0],
			business_name: str("business_name"),
			business_address: str("business_address"),
			business_email: str("business_email"),
			business_phone: str("business_phone"),
			tax_id_label: str("tax_id_label"),
			tax_id: str("tax_id"),
			footer: str("footer"),
			invoice_prefix: str("invoice_prefix"),
			quote_prefix: str("quote_prefix"),
			estimate_prefix: str("estimate_prefix"),
			default_currency: CURRENCIES.includes(v.default_currency) ? v.default_currency : "CAD",
			default_terms_days: num("default_terms_days", 30),
			quote_valid_days: num("quote_valid_days", 30),
			estimate_valid_days: num("estimate_valid_days", 30),
			quote_terms: str("quote_terms"),
			estimate_terms: str("estimate_terms"),
			default_tax_ids: defaults.rows.map((r) => r.id),
			post_to_ledger: v.post_to_ledger === true,
			accounts,
			email_via: v.email_via === "smtp" ? "smtp" : "gmail",
			smtp_host: str("smtp_host"),
			smtp_port: num("smtp_port", 587),
			smtp_security: ["tls", "starttls", "none"].includes(v.smtp_security) ? v.smtp_security : "starttls",
			smtp_username: str("smtp_username"),
			smtp_password: typeof v.smtp_password === "string" ? v.smtp_password : "",
			from_name: str("from_name"),
			from_email: str("from_email"),
			reply_to: str("reply_to"),
			bcc_self: v.bcc_self === true,
			email_subject: str("email_subject"),
			email_body: str("email_body"),
			quote_email_subject: str("quote_email_subject"),
			quote_email_body: str("quote_email_body"),
		};
	}

	/** Module setup (taxes, categories, numbering) is for admins; bookkeepers do the day-to-day work. */
	function requireAdmin(req) {
		if (req.user?.role !== "admin") throw new ctx.HttpError(403, "only an admin can change this");
	}

	/** Checks that a ledger account exists, is active and is in the currency. */
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

	/** {"CAD": "4000", "USD": ""} → validated map with only the set currencies. */
	async function accountMap(v, field) {
		const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
		const out = {};
		for (const cur of CURRENCIES) {
			const code = typeof o[cur] === "string" ? o[cur].trim() : "";
			if (!code) continue;
			await checkAccount(code, cur, `${field}.${cur}`);
			out[cur] = code;
		}
		return out;
	}

	/** Checks that tax ids exist; returns them as strings. */
	async function checkTaxIds(v, field) {
		const ids = idList(v, field);
		if (ids.length) {
			const { rows } = await q(`SELECT id FROM ${T("taxes")} WHERE id = ANY($1::bigint[])`, [ids]);
			if (rows.length !== ids.length) throw bad(`${field}: there is no such tax`);
		}
		return ids;
	}

	/**
	 * Sales' customers as one table to read from: a row linked to Ledger's
	 * shared list (entities, Ledger ≥ 0.16.0) takes its name, email, phone,
	 * address and notes from there; a row from before the move still has its
	 * own. Use it as `${CUSTOMERS} c` in SELECTs; write to T("customers").
	 */
	const CUSTOMERS = `(SELECT c.id, c.entity_id,
	        coalesce(e.name, nullif(c.name, ''), '(missing customer)') AS name,
	        CASE WHEN c.entity_id IS NULL THEN c.email ELSE coalesce(e.email, '') END AS email,
	        CASE WHEN c.entity_id IS NULL THEN c.phone ELSE coalesce(e.phone, '') END AS phone,
	        CASE WHEN c.entity_id IS NULL THEN c.address ELSE coalesce(e.address, '') END AS address,
	        CASE WHEN c.entity_id IS NULL THEN c.notes ELSE coalesce(e.notes, '') END AS notes,
	        c.company, c.cc_emails, c.tax_id, c.currency, c.terms_days, c.tax_ids,
	        c.archived OR coalesce(NOT e.is_active, false) AS archived,
	        coalesce(e.is_active, false) AS entity_active,
	        c.created_at, c.updated_at
	   FROM ${T("customers")} c LEFT JOIN public.entities e ON e.id = c.entity_id)`;

	return { T, q, bad, notFound, conflict, body, text, intIn, bool, dateField, currency, decimal, rate, id, isId, idList, like, loadSettings, requireAdmin, checkAccount, accountMap, checkTaxIds, CUSTOMERS };
}
