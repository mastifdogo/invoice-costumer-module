// The module's settings as the page needs them, the running document
// numbers, the test email, the account list and the dashboard summary.
// Everything else is configured in Ledger's settings form (Settings → Sales).

import { today } from "../lib/money.mjs";

export function settingsRoutes(ctx, h, mail) {
	const { T, q, body, intIn, loadSettings, requireAdmin } = h;

	/** Settings for the page: never the SMTP password. */
	async function publicSettings(req) {
		const { smtp_password, ...s } = await loadSettings();
		const email = await mail.status(s);
		return { ...s, smtp_password_set: smtp_password !== "", email, email_ready: email.ready, is_admin: req.user.role === "admin" };
	}

	ctx.route("GET", "/settings", (req) => publicSettings(req));

	// The next number for each kind of document (admins only).
	ctx.route("PUT", "/numbering", async (req) => {
		requireAdmin(req);
		const o = body(req);
		const sets = [];
		const params = [];
		for (const kind of ["invoice", "quote", "estimate"]) {
			const k = `next_${kind}_number`;
			if (!(k in o)) continue;
			params.push(intIn(o[k], k, 1, 999_999_999));
			sets.push(`${k} = $${params.length}`);
		}
		if (sets.length) await q(`UPDATE ${T("settings")} SET ${sets.join(", ")}, updated_at = now() WHERE id = 1`, params);
		return publicSettings(req);
	});

	ctx.route("POST", "/settings/test-email", async (req) => {
		const s = await loadSettings();
		const st = await mail.status(s);
		const to = mail.addresses(body(req).to || st.from || s.business_email, "to", true);
		try {
			const reply = await mail.deliver(s, {
				to,
				cc: [],
				bcc: [],
				subject: "Test email from Ledger sales",
				text: `This is a test from the Ledger sales module.\nIf you can read it, invoices, quotes and estimates can be emailed${st.from ? ` from ${st.from}` : ""}.\n`,
			});
			return { ok: true, to, server_reply: reply };
		} catch (e) {
			if (e instanceof ctx.HttpError || typeof e?.status === "number") throw e;
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
