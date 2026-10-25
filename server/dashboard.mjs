// Keeps this module's notifications and to-dos on Ledger's dashboard in step
// with the documents: one notification for overdue invoices, a to-do for
// each issued invoice that hasn't been emailed, and a to-do to follow up on
// each sent quote or estimate. Needs a Ledger with ctx.dashboard; on older
// versions it does nothing.

import { formatMoney, today } from "../lib/money.mjs";
import { KINDS } from "./common.mjs";

const LINK = "/apps/sales";
const MAX_ITEMS = 50;
const HOURLY = 60 * 60 * 1000;

export function dashboardSync(ctx, h) {
	const d = ctx.dashboard;
	if (!d) return { schedule() {}, start() {} };
	const { T, q } = h;
	let timer = null;
	let running = null;

	/** The to-dos that should be open now, by key. */
	async function wantedTodos() {
		const { rows } = await q(
			`SELECT d.id, d.kind, d.number, d.status, d.issue_date::text, d.due_date::text, d.sent_at, c.name AS customer
			   FROM ${T("documents")} d JOIN ${T("customers")} c ON c.id = d.customer_id
			  WHERE (d.kind = 'invoice' AND d.status = 'open' AND d.sent_at IS NULL)
			     OR (d.kind <> 'invoice' AND d.status = 'sent')
			  ORDER BY d.due_date, d.id
			  LIMIT ${MAX_ITEMS}`,
		);
		const todos = new Map();
		for (const r of rows) {
			const label = KINDS[r.kind].label.toLowerCase();
			if (r.kind === "invoice") {
				todos.set(`send-${r.id}`, { title: `Send invoice ${r.number} to ${r.customer}`.slice(0, 200), body: "Issued but not emailed yet.", due: r.issue_date });
			} else {
				todos.set(`follow-up-${r.id}`, { title: `Follow up on ${label} ${r.number} for ${r.customer}`.slice(0, 200), body: `Valid until ${r.due_date}.`, due: r.due_date });
			}
		}
		return todos;
	}

	async function syncOverdue() {
		const { rows } = await q(
			`SELECT d.number, d.currency, d.total_cents - d.paid_cents AS due_cents, d.due_date::text, c.name AS customer
			   FROM ${T("documents")} d JOIN ${T("customers")} c ON c.id = d.customer_id
			  WHERE d.kind = 'invoice' AND d.status = 'open' AND d.due_date < $1::date
			  ORDER BY d.due_date, d.id`,
			[today()],
		);
		if (rows.length === 0) {
			await d.remove("overdue", "notification");
			return;
		}
		const totals = new Map();
		for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0n) + BigInt(r.due_cents));
		const lines = rows.slice(0, 20).map((r) => `${r.number} – ${r.customer}, ${formatMoney(r.due_cents, r.currency)} (due ${r.due_date})`);
		if (rows.length > 20) lines.push(`…and ${rows.length - 20} more`);
		await d.notify({
			key: "overdue",
			title: `${rows.length} invoice${rows.length === 1 ? " is" : "s are"} overdue: ${[...totals].map(([cur, c]) => formatMoney(c, cur)).join(", ")}`.slice(0, 200),
			body: lines.join("\n").slice(0, 2000),
			level: "warning",
			link: LINK,
		});
	}

	async function syncTodos() {
		const wanted = await wantedTodos();
		const existing = await d.list({ kind: "todo" });
		const byKey = new Map(existing.map((i) => [i.key, i]));
		for (const [key, t] of wanted) {
			const cur = byKey.get(key);
			// Re-post only when something changed, so the dashboard isn't rewritten on every sync.
			if (!cur || cur.closed_at || cur.title !== t.title || cur.body !== t.body || cur.due_date !== t.due) {
				await d.todo({ key, ...t, link: LINK });
				if (cur?.closed_at) await d.reopen(key);
			}
		}
		// A to-do whose document moved on (emailed, decided, deleted) is done.
		for (const i of existing) {
			if (wanted.has(i.key) || i.closed_at) continue;
			if (/^(send|follow-up)-\d+$/.test(i.key)) await d.complete(i.key);
		}
	}

	async function sync() {
		try {
			await syncOverdue();
			await syncTodos();
		} catch (e) {
			ctx.log.warn("dashboard sync failed", { err: e.message });
		}
	}

	/** Runs one sync at a time; a request made during a sync runs once more after it. */
	function run() {
		if (running) {
			running.again = true;
			return;
		}
		running = { again: false };
		sync().finally(() => {
			const again = running.again;
			running = null;
			if (again) run();
		});
	}

	return {
		/** Syncs shortly after a change (several changes in a row sync once). */
		schedule() {
			clearTimeout(timer);
			timer = setTimeout(run, 500);
			timer.unref?.();
		},
		/** First sync now, then hourly, so invoices become overdue without anyone opening the page. */
		start() {
			run();
			setInterval(run, HOURLY).unref();
		},
	};
}
