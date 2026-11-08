// Up to 0.1.0 the module kept its configuration in its own settings table.
// From 0.2.0 it lives in Ledger's settings form (ctx.settings). On the first
// start after upgrading, copy the old values across once. Both are per
// organization (Ledger ≥ 0.11.1): call this inside ctx.orgs.forEach.

const TEXT = [
	"business_name", "business_address", "business_email", "business_phone", "tax_id_label", "tax_id", "footer",
	"invoice_prefix", "quote_prefix", "estimate_prefix", "default_currency", "quote_terms", "estimate_terms",
	"smtp_host", "smtp_security", "smtp_username", "smtp_password", "from_name", "from_email", "reply_to",
	"email_subject", "email_body", "quote_email_subject", "quote_email_body",
];
const NUMBERS = ["default_terms_days", "quote_valid_days", "estimate_valid_days", "smtp_port"];
const BOOLEANS = ["post_to_ledger", "bcc_self"];

export async function moveSettings(ctx, h, org = null) {
	const { rows } = await h.q(`SELECT * FROM ${h.T("settings")} WHERE id = 1 AND NOT moved_to_ledger_settings`);
	const old = rows[0];
	if (!old) return;
	const values = {};
	for (const k of TEXT) if (typeof old[k] === "string" && old[k] !== "") values[k] = old[k];
	for (const k of NUMBERS) if (typeof old[k] === "number") values[k] = old[k];
	for (const k of BOOLEANS) if (typeof old[k] === "boolean") values[k] = old[k];
	for (const [cur, roles] of Object.entries(old.accounts ?? {})) {
		for (const [role, code] of Object.entries(roles ?? {})) {
			if (typeof code === "string" && code) values[`${role}_account_${cur.toLowerCase()}`] = code;
		}
	}
	// Someone who set up SMTP before keeps using it; Gmail is the default for new installs.
	if (old.smtp_host) values.email_via = "smtp";
	// One key at a time, so one value Ledger rejects doesn't lose the rest.
	const failed = [];
	for (const [k, v] of Object.entries(values)) {
		try {
			await ctx.settings.set({ [k]: v });
		} catch (e) {
			failed.push(k);
			ctx.log.warn("could not move a setting to Ledger's settings form", { key: k, err: e.message, ...(org ? { organization: org.name } : {}) });
		}
	}
	await h.q(`UPDATE ${h.T("settings")} SET moved_to_ledger_settings = true WHERE id = 1`);
	ctx.log.info("moved settings to Ledger's settings form", { moved: Object.keys(values).length - failed.length, failed: failed.length, ...(org ? { organization: org.name } : {}) });
}
