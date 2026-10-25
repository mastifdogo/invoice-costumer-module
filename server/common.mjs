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

	async function loadSettings() {
		const { rows } = await q(`SELECT * FROM ${T("settings")} WHERE id = 1`);
		return rows[0];
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

	return { T, q, bad, notFound, conflict, body, text, intIn, bool, dateField, currency, decimal, rate, id, isId, idList, like, loadSettings, checkAccount, accountMap, checkTaxIds };
}
