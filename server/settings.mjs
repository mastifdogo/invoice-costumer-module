// Module settings (business details, numbering, defaults, ledger posting,
// email) plus the test email, the account list and the dashboard summary.

import { today } from "../lib/money.mjs";
import { isEmail } from "../lib/mail.mjs";
import { CURRENCIES } from "./common.mjs";

const ACCOUNT_ROLES = ["receivable", "revenue", "bank"];

const TEXT_FIELDS = {
	business_name: [200],
	business_address: [1000, true],
	business_phone: [50],
	tax_id: [50],
	tax_id_label: [30],
	footer: [2000, true],
	quote_terms: [2000, true],
	estimate_terms: [2000, true],
	smtp_host: [255],
	smtp_username: [255],
	from_name: [200],
	email_subject: [300],
	email_body: [5000, true],
	quote_email_subject: [300],
	quote_email_body: [5000, true],
};

export function publicSettings(s) {
	const { smtp_password, id: _id, ...rest } = s;
	return { ...rest, smtp_password_set: smtp_password !== "", email_ready: Boolean(s.smtp_host && s.from_email) };
}

export function settingsRoutes(ctx, h, mail) {
	const { T, q, bad, body, text, intIn, bool, currency, checkAccount, checkTaxIds, loadSettings } = h;

	async function updateSettings(o) {
		const sets = [];
		const params = [];
		const set = (col, v) => (params.push(v), sets.push(`${col} = $${params.length}`));
		for (const [k, [max, multiline]] of Object.entries(TEXT_FIELDS)) if (k in o) set(k, text(o, k, max, { multiline }));
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
		for (const kind of ["invoice", "quote", "estimate"]) {
			const pk = `${kind}_prefix`;
			if (pk in o) {
				const p = text(o, pk, 20);
				if (!/^[A-Za-z0-9#/._-]*$/.test(p)) throw bad(`${pk} may only contain letters, digits and # / . _ -`);
				set(pk, p);
			}
			const nk = `next_${kind}_number`;
			if (nk in o) set(nk, intIn(o[nk], nk, 1, 999_999_999));
		}
		if ("default_currency" in o) set("default_currency", currency(o.default_currency, "default_currency"));
		for (const k of ["default_terms_days", "quote_valid_days", "estimate_valid_days"]) if (k in o) set(k, intIn(o[k], k, 0, 365));
		if ("default_tax_ids" in o) set("default_tax_ids", await checkTaxIds(o.default_tax_ids ?? [], "default_tax_ids"));
		if ("smtp_port" in o) set("smtp_port", intIn(o.smtp_port, "smtp_port", 1, 65535));
		if ("smtp_security" in o) {
			if (!["tls", "starttls", "none"].includes(o.smtp_security)) throw bad("smtp_security must be tls, starttls or none");
			set("smtp_security", o.smtp_security);
		}
		for (const k of ["post_to_ledger", "bcc_self"]) if (k in o) set(k, bool(o[k], k));
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

	ctx.route("GET", "/settings", async () => publicSettings(await loadSettings()));
	ctx.route("PUT", "/settings", async (req) => publicSettings(await updateSettings(body(req))));

	ctx.route("POST", "/settings/test-email", async (req) => {
		const s = await loadSettings();
		const to = mail.addresses(body(req).to || s.from_email, "to", true);
		try {
			const reply = await mail.deliver(s, {
				to,
				cc: [],
				bcc: [],
				subject: "Test email from Ledger sales",
				text: `This is a test from the Ledger sales module.\nIf you can read it, invoices, quotes and estimates can be emailed from ${s.from_email}.\n`,
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
			        coalesce((SELECT sum(p.amount_cents) FROM ${T("payments")} p JOIN ${T("documents")} pd ON pd.id = p.document_id
			                   WHERE pd.currency = d.currency AND p.payment_date > $1::date - 30), 0)::bigint AS paid_30d_cents
			   FROM ${T("documents")} d WHERE kind = 'invoice' GROUP BY currency ORDER BY currency`,
			[t],
		);
		const counts = await q(
			`SELECT (SELECT count(*) FROM ${T("documents")} WHERE kind = 'invoice' AND status IN ('draft', 'posting')) AS drafts,
			        (SELECT count(*) FROM ${T("customers")} WHERE NOT archived) AS customers`,
		);
		return { currencies: rows, ...counts.rows[0] };
	});
}
