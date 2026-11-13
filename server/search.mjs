// Results for Ledger's search bar: customers, and invoices, quotes and
// estimates by number, customer or PO number. Links open the record in the
// module's page (/apps/sales?open=...).

import { formatMoney } from "../lib/money.mjs";
import { KINDS } from "./common.mjs";

export const openLink = (path) => `/apps/sales?open=${encodeURIComponent(path)}`;

export function searchProvider(ctx, h) {
	if (!ctx.search?.provide) return;
	const { T, q, like, CUSTOMERS } = h;
	ctx.search.provide(async (query, { limit }) => {
		const term = String(query ?? "").trim();
		if (term.length < 2) return [];
		const max = Math.max(1, Math.min(Number(limit) || 8, 20));
		const pattern = like(term);
		const [docs, customers] = await Promise.all([
			q(
				`SELECT d.id, d.kind, d.number, d.status, d.currency, d.total_cents, d.issue_date::text, c.name AS customer
				   FROM ${T("documents")} d JOIN ${CUSTOMERS} c ON c.id = d.customer_id
				  WHERE d.number ILIKE $1 OR c.name ILIKE $1 OR c.company ILIKE $1 OR d.po_number ILIKE $1
				  ORDER BY (d.number ILIKE $1) DESC, d.issue_date DESC, d.id DESC
				  LIMIT $2`,
				[pattern, max],
			),
			q(
				`SELECT id, name, company, email FROM ${CUSTOMERS} c
				  WHERE name ILIKE $1 OR company ILIKE $1 OR email ILIKE $1
				  ORDER BY archived, lower(name) LIMIT $2`,
				[pattern, max],
			),
		]);
		const results = [
			...customers.rows.map((c) => ({
				title: c.name,
				subtitle: ["Customer", c.company, c.email].filter(Boolean).join(" · "),
				href: openLink(`customers/${c.id}`),
			})),
			...docs.rows.map((d) => ({
				title: `${KINDS[d.kind].label} ${d.number}`,
				subtitle: `${d.customer} · ${formatMoney(d.total_cents, d.currency)} · ${d.status} · ${d.issue_date}`,
				href: openLink(`${KINDS[d.kind].plural}/${d.id}`),
			})),
		];
		return results.slice(0, max);
	});
}
