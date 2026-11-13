// Customer lists that Ledger hands to Sales (Ledger ≥ 0.12.0): when someone
// migrates from other bookkeeping software under Settings → Import & export →
// Migrate, Ledger sends the customer list here as a "customer" file. Nothing
// is added until a person looks at the list and approves it: the Customers
// tab shows each list with who's new and who's already a customer, they
// choose who to add, and the file is marked done (or rejected).

import { decodeText, parseDelimited } from "../lib/csv.mjs";
import { isEmail } from "../lib/mail.mjs";

const OPEN = ["new", "accepted"];

export function importRoutes(ctx, h, dashboard) {
	const { T, q, bad, notFound, conflict, body, loadSettings } = h;

	/** A customer file in this organization's inbox, or 404. */
	async function getFile(id) {
		if (!/^\d{1,18}$/.test(String(id))) throw notFound("customer list");
		let f;
		try {
			f = await ctx.files.get(id);
		} catch {
			throw notFound("customer list");
		}
		if (!f || f.kind !== "customer" || f.recipient !== "sales") throw notFound("customer list");
		return f;
	}

	const clip = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

	/**
	 * The people in a file, with what adding them would do: "add", or "exists"
	 * (already a customer, by name or email) or "repeat" (earlier in the same
	 * file). Only "add" rows can be added.
	 */
	async function preview(f) {
		const meta = f.meta ?? {};
		let rows;
		try {
			rows = parseDelimited(decodeText(f.data));
		} catch (e) {
			throw bad(`can't read this list: ${e.message}`);
		}
		const headerRow = Number.isInteger(meta.header_row) && meta.header_row >= 0 ? meta.header_row : 0;
		const headers = rows[headerRow] ?? [];
		const col = (field) => {
			const name = meta.columns?.[field];
			return typeof name === "string" ? headers.indexOf(name) : -1;
		};
		const [ni, ei, pi] = [col("name"), col("email"), col("phone")];
		if (ni < 0) throw bad("this list has no column for the customer's name");

		const { rows: existing } = await q(`SELECT id, name, lower(name) AS lname, lower(email) AS lemail FROM ${T("customers")}`);
		const byName = new Map(existing.map((c) => [c.lname, c]));
		const byEmail = new Map(existing.filter((c) => c.lemail).map((c) => [c.lemail, c]));
		const seen = new Map();
		const people = [];
		for (let i = headerRow + 1; i < rows.length; i++) {
			const r = rows[i];
			const name = clip(r[ni], 200);
			if (!name) continue;
			let email = ei >= 0 ? clip(r[ei], 254) : "";
			const note = email && !isEmail(email) ? `"${email}" isn't an email address; left out` : "";
			if (note) email = "";
			const phone = pi >= 0 ? clip(r[pi], 50) : "";
			const match = byName.get(name.toLowerCase()) ?? (email ? byEmail.get(email.toLowerCase()) : undefined);
			const key = name.toLowerCase();
			const action = match ? "exists" : seen.has(key) ? "repeat" : "add";
			if (!seen.has(key)) seen.set(key, people.length);
			people.push({ row: i, name, email, phone, note, action, customer: match ? { id: match.id, name: match.name } : null });
		}
		return { headers, people };
	}

	const summary = (f) => ({
		id: String(f.id),
		filename: f.filename,
		source: f.meta?.source ?? null,
		rows: f.meta?.rows ?? null,
		note: f.note,
		status: f.status,
		result: f.result,
		sent_by: f.sent_by,
		created_at: f.created_at,
	});

	ctx.route("GET", "/imports", async () => {
		const files = await ctx.files.inbox({ kind: "customer", limit: 50 });
		return { data: files.map(summary) };
	});

	ctx.route("GET", "/imports/:id", async (req) => {
		const f = await getFile(req.params.id);
		const p = await preview(f);
		return { ...summary(f), columns: f.meta?.columns ?? {}, people: p.people };
	});

	// Adds the chosen people (rows) as customers and marks the list done.
	ctx.route("POST", "/imports/:id/apply", async (req) => {
		const o = body(req);
		if (!Array.isArray(o.rows) || o.rows.length > 20000 || !o.rows.every((n) => Number.isInteger(n) && n >= 0)) {
			throw bad("rows must be the list of row numbers to add (from the preview)");
		}
		const f = await getFile(req.params.id);
		if (!OPEN.includes(f.status)) throw conflict(`this list was already ${f.status === "done" ? "imported" : "rejected"}`);
		const { people } = await preview(f);
		const want = new Set(o.rows);
		const chosen = people.filter((p) => want.has(p.row));
		if (chosen.length !== want.size) throw bad("some rows aren't in this list; reload it and try again");
		const blocked = chosen.filter((p) => p.action !== "add");
		if (blocked.length) throw conflict(`${blocked[0].name} is already a customer or listed twice; reload the list`);

		const s = await loadSettings();
		const from = [f.meta?.source, f.filename].filter(Boolean).join(", ");
		// One statement, and never a second customer with the same name: a
		// double click or two people approving at once can't add anyone twice.
		const { rows: added } = await q(
			`INSERT INTO ${T("customers")} (name, email, phone, currency, notes)
			 SELECT t.name, t.email, t.phone, $4, $5
			   FROM unnest($1::text[], $2::text[], $3::text[]) AS t(name, email, phone)
			  WHERE NOT EXISTS (SELECT 1 FROM ${T("customers")} c WHERE lower(c.name) = lower(t.name))
			 RETURNING id`,
			[chosen.map((p) => p.name), chosen.map((p) => p.email), chosen.map((p) => p.phone), s.default_currency ?? "CAD", `Imported from ${from}`.slice(0, 5000)],
		);
		const skipped = people.length - added.length;
		const result = `${added.length} customer${added.length === 1 ? "" : "s"} added by ${req.user.username}${skipped ? `; ${skipped} not added` : ""}`;
		await ctx.files.update(f.id, { status: "done", result });
		ctx.log.info("customer list imported", { file: String(f.id), added: added.length, user: req.user.username });
		return { added: added.length, skipped, result };
	});

	ctx.route("POST", "/imports/:id/reject", async (req) => {
		const f = await getFile(req.params.id);
		if (!OPEN.includes(f.status)) throw conflict(`this list was already ${f.status === "done" ? "imported" : "rejected"}`);
		const result = `Not imported (${req.user.username})`;
		await ctx.files.update(f.id, { status: "rejected", result });
		return { result };
	});

	// A new list puts a to-do on the dashboard (in the organization it came to).
	ctx.files?.onReceive(async (f) => {
		if (f.kind !== "customer") return;
		const org = await ctx.orgs.current().catch(() => null);
		dashboard.schedule(org?.id);
	});
}

// "Import customers from CSV" on Sales' page under Settings → Modules
// (ctx.imports, Ledger ≥ 0.13.2). Ledger reads the file, matches its columns
// to these fields and converts the values; the dry run shows the user what
// would happen, and nothing is added until they press Import.
const FIELDS = [
	{ key: "name", label: "Customer name", required: true },
	{ key: "company", label: "Company" },
	{ key: "email", label: "Email" },
	{ key: "phone", label: "Phone" },
	{ key: "address", label: "Billing address" },
	{ key: "tax_id", label: "GST number", help: "The customer's GST/HST or other tax number" },
	{ key: "currency", label: "Currency", help: "CAD or USD; empty uses the default currency" },
	{ key: "terms_days", label: "Payment terms (days)", type: "number", help: "Days until invoices are due; empty uses the default" },
	{ key: "notes", label: "Notes" },
];
const LIMITS = { name: 200, company: 200, email: 254, phone: 50, address: 1000, tax_id: 50, notes: 5000 };

export function csvImport(ctx, h) {
	if (!ctx.imports) return;
	const { T, q, loadSettings } = h;
	const CURRENCIES = ["CAD", "USD"];

	ctx.imports.provide({
		label: "Customers",
		description: "Customer contact details. Anyone already in Sales (same name or email), or listed twice, is skipped.",
		fields: FIELDS,
		async handler(rows, { dryRun, user }) {
			const s = await loadSettings();
			const { rows: existing } = await q(`SELECT lower(name) AS lname, lower(email) AS lemail FROM ${T("customers")}`);
			const names = new Set(existing.map((c) => c.lname));
			const emails = new Set(existing.filter((c) => c.lemail).map((c) => c.lemail));
			const errors = [];
			const add = [];
			let exists = 0;
			let repeats = 0;
			const seen = new Set();
			for (const r of rows) {
				const c = {};
				const problems = [];
				for (const [k, max] of Object.entries(LIMITS)) {
					const v = r[k] == null ? "" : String(r[k]).trim();
					if (v.length > max) problems.push(`${k.replace("_", " ")} is longer than ${max} characters`);
					c[k] = k === "address" || k === "notes" ? v : v.replace(/\s+/g, " ");
				}
				if (c.email && !isEmail(c.email)) problems.push(`"${c.email}" isn't an email address`);
				const cur = r.currency == null || String(r.currency).trim() === "" ? s.default_currency || "CAD" : String(r.currency).trim().toUpperCase();
				if (!CURRENCIES.includes(cur)) problems.push(`currency must be ${CURRENCIES.join(" or ")}`);
				c.currency = cur;
				c.terms_days = r.terms_days == null ? null : Number(r.terms_days);
				if (c.terms_days !== null && !(Number.isInteger(c.terms_days) && c.terms_days >= 0 && c.terms_days <= 365)) problems.push("payment terms must be a whole number of days from 0 to 365");
				if (problems.length) {
					errors.push({ row: r._row, message: `${c.name || "This row"}: ${problems.join("; ")}` });
					continue;
				}
				const key = c.name.toLowerCase();
				if (names.has(key) || (c.email && emails.has(c.email.toLowerCase()))) exists++;
				else if (seen.has(key)) repeats++;
				else add.push(c);
				seen.add(key);
			}
			const skipped = [exists ? `${exists} already in Sales` : "", repeats ? `${repeats} listed twice` : ""].filter(Boolean).join(", ");
			const tail = skipped ? `; skipping ${skipped}` : "";
			const n = (k) => `${k} customer${k === 1 ? "" : "s"}`;
			if (dryRun) return { summary: `Would add ${n(add.length)}${tail}.`, errors };
			if (errors.length) throw new ctx.HttpError(422, `${errors.length} row${errors.length === 1 ? " needs" : "s need"} fixing first`);
			// One statement, so it's all or nothing; a name added meanwhile is skipped, not doubled.
			const col = (k) => add.map((c) => c[k]);
			const { rows: added } = await q(
				`INSERT INTO ${T("customers")} (name, company, email, phone, address, tax_id, currency, terms_days, notes)
				 SELECT t.* FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[])
				        AS t(name, company, email, phone, address, tax_id, currency, terms_days, notes)
				  WHERE NOT EXISTS (SELECT 1 FROM ${T("customers")} c WHERE lower(c.name) = lower(t.name))
				 RETURNING id`,
				["name", "company", "email", "phone", "address", "tax_id", "currency", "terms_days", "notes"].map(col),
			);
			ctx.log.info("customers imported from CSV", { added: added.length, user: user?.username });
			const late = add.length - added.length;
			return { summary: `Added ${n(added.length)}${tail}${late ? `; ${late} were added by someone else meanwhile` : ""}.` };
		},
	});
}
