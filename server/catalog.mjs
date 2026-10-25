// Sales taxes (GST, HST, PST, …) and sales categories, each tracking to
// ledger accounts per currency.

import { today } from "../lib/money.mjs";

export function catalogRoutes(ctx, h) {
	const { T, q, bad, notFound, conflict, body, text, bool, rate, id, accountMap, checkTaxIds } = h;

	// ---- taxes ---------------------------------------------------------------

	async function getTax(tid) {
		const { rows } = await q(`SELECT * FROM ${T("taxes")} WHERE id = $1`, [tid]);
		if (!rows[0]) throw notFound("tax");
		return rows[0];
	}

	async function taxInput(o, partial) {
		const out = {};
		if (!partial || "name" in o) out.name = text(o, "name", 30, { required: true });
		if (!partial || "rate" in o) out.rate = rate(o.rate, "rate");
		if (!partial || "accounts" in o) out.accounts = JSON.stringify(await accountMap(o.accounts, "accounts"));
		if ("active" in o) out.active = bool(o.active, "active");
		if ("position" in o) out.position = h.intIn(o.position, "position", 0, 1000);
		return out;
	}

	const uniqueName = (e, what) => {
		if (e?.code === "23505") throw conflict(`there is already a ${what} with that name`);
		throw e;
	};

	ctx.route("GET", "/taxes", async () => {
		const { rows } = await q(`SELECT * FROM ${T("taxes")} ORDER BY position, id`);
		return { data: rows };
	});

	ctx.route("POST", "/taxes", async (req) => {
		const t = await taxInput(body(req), false);
		const cols = Object.keys(t);
		const { rows } = await q(
			`INSERT INTO ${T("taxes")} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
			Object.values(t),
		).catch((e) => uniqueName(e, "tax"));
		return ctx.response(201, await getTax(rows[0].id));
	});

	ctx.route("PUT", "/taxes/:id", async (req) => {
		const tid = id(req, "id", "tax");
		const t = await taxInput(body(req), true);
		const cols = Object.keys(t);
		if (cols.length) {
			const { rowCount } = await q(`UPDATE ${T("taxes")} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [tid, ...Object.values(t)]).catch((e) =>
				uniqueName(e, "tax"),
			);
			if (rowCount === 0) throw notFound("tax");
		}
		return getTax(tid);
	});

	ctx.route("DELETE", "/taxes/:id", async (req) => {
		const tid = id(req, "id", "tax");
		const used = await q(
			`SELECT 1 FROM ${T("document_lines")} WHERE taxes @> jsonb_build_array(jsonb_build_object('id', $1::bigint)) LIMIT 1`,
			[tid],
		);
		if (used.rowCount) throw conflict("this tax is used on documents; turn it off instead");
		await q(`UPDATE ${T("settings")} SET default_tax_ids = array_remove(default_tax_ids, $1::int) WHERE id = 1`, [tid]);
		await q(`UPDATE ${T("customers")} SET tax_ids = array_remove(tax_ids, $1::int) WHERE $1::int = ANY(tax_ids)`, [tid]);
		await q(`UPDATE ${T("categories")} SET tax_ids = array_remove(tax_ids, $1::int) WHERE $1::int = ANY(tax_ids)`, [tid]);
		const { rowCount } = await q(`DELETE FROM ${T("taxes")} WHERE id = $1`, [tid]);
		if (rowCount === 0) throw notFound("tax");
	});

	// ---- categories ------------------------------------------------------------

	async function categoryInput(o, partial) {
		const out = {};
		if (!partial || "name" in o) out.name = text(o, "name", 100, { required: true });
		if (!partial || "description" in o) out.description = text(o, "description", 500);
		if (!partial || "accounts" in o) out.accounts = JSON.stringify(await accountMap(o.accounts, "accounts"));
		if (!partial || "tax_ids" in o) out.tax_ids = o.tax_ids === null || o.tax_ids === undefined ? null : await checkTaxIds(o.tax_ids, "tax_ids");
		if ("active" in o) out.active = bool(o.active, "active");
		return out;
	}

	/** Sales per category and currency: lines of issued (open or paid) invoices dated from..to. */
	async function categorySales(from, to) {
		const { rows } = await q(
			`SELECT l.category_id, d.currency, sum(l.amount_cents)::bigint AS cents
			   FROM ${T("document_lines")} l JOIN ${T("documents")} d ON d.id = l.document_id
			  WHERE d.kind = 'invoice' AND d.status IN ('open', 'paid') AND d.issue_date BETWEEN $1::date AND $2::date
			  GROUP BY l.category_id, d.currency`,
			[from, to],
		);
		return rows;
	}

	function range(req) {
		const t = today();
		const from = req.query.get("from") || `${t.slice(0, 4)}-01-01`;
		const to = req.query.get("to") || t;
		h.dateField(from, "from");
		h.dateField(to, "to");
		if (to < from) throw bad("to can't be before from");
		return { from, to };
	}

	async function getCategory(cid) {
		const { rows } = await q(`SELECT * FROM ${T("categories")} WHERE id = $1`, [cid]);
		if (!rows[0]) throw notFound("category");
		return rows[0];
	}

	ctx.route("GET", "/categories", async (req) => {
		const { from, to } = range(req);
		const [{ rows }, sales] = await Promise.all([q(`SELECT * FROM ${T("categories")} ORDER BY NOT active, lower(name), id`), categorySales(from, to)]);
		const salesOf = (cid) => sales.filter((s) => String(s.category_id) === String(cid)).map((s) => ({ currency: s.currency, cents: s.cents }));
		return { from, to, data: rows.map((c) => ({ ...c, sales: salesOf(c.id) })), uncategorized: salesOf(null) };
	});

	ctx.route("POST", "/categories", async (req) => {
		const c = await categoryInput(body(req), false);
		const cols = Object.keys(c);
		const { rows } = await q(
			`INSERT INTO ${T("categories")} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
			Object.values(c),
		).catch((e) => uniqueName(e, "category"));
		return ctx.response(201, await getCategory(rows[0].id));
	});

	ctx.route("PUT", "/categories/:id", async (req) => {
		const cid = id(req, "id", "category");
		const c = await categoryInput(body(req), true);
		const cols = Object.keys(c);
		if (cols.length) {
			const { rowCount } = await q(`UPDATE ${T("categories")} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [cid, ...Object.values(c)]).catch((e) =>
				uniqueName(e, "category"),
			);
			if (rowCount === 0) throw notFound("category");
		}
		return getCategory(cid);
	});

	ctx.route("DELETE", "/categories/:id", async (req) => {
		const cid = id(req, "id", "category");
		const used = await q(`SELECT 1 FROM ${T("document_lines")} WHERE category_id = $1 LIMIT 1`, [cid]);
		if (used.rowCount) throw conflict("this category is used on documents; turn it off instead");
		const { rowCount } = await q(`DELETE FROM ${T("categories")} WHERE id = $1`, [cid]);
		if (rowCount === 0) throw notFound("category");
	});
}
