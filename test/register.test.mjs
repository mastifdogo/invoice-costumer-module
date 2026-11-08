import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";

/** A stand-in for Ledger's ctx with no database rows. */
function fakeCtx(extra = {}) {
	const routes = [];
	const logs = [];
	class HttpError extends Error {
		constructor(status, message) {
			super(message);
			this.status = status;
		}
	}
	const ctx = {
		id: "sales",
		schema: "mod_sales",
		route: (method, path, handler) => routes.push({ method, path, handler }),
		db: { query: async () => ({ rows: [], rowCount: 0 }) },
		HttpError,
		response: (status, body) => ({ status, body }),
		log: { info: (m, a) => logs.push(["info", m, a]), warn: (m, a) => logs.push(["warn", m, a]), error: (m, a) => logs.push(["error", m, a]) },
		ledger: {},
		settings: { get: async () => ({}), set: async () => {}, onChange() {} },
		orgs: { forEach: async (fn) => fn({ id: 1, name: "Main books", kind: "business" }) },
		...extra,
	};
	return { ctx, routes, logs };
}

test("loads without ctx.dashboard or ctx.search", async () => {
	const { ctx, routes, logs } = fakeCtx();
	await register(ctx);
	assert.ok(routes.length > 50);
	for (const p of ["/invoices", "/quotes", "/estimates", "/customers", "/categories", "/taxes", "/settings", "/numbering"]) {
		if (p === "/numbering") {
			assert.ok(routes.some((r) => r.method === "PUT" && r.path === p));
			continue;
		}
		assert.ok(routes.some((r) => r.method === "GET" && r.path === p), p);
	}
	assert.deepEqual(logs.at(-1), ["info", "sales module ready", { dashboard: false }]);
});

test("syncs the dashboard on startup when Ledger has it", async () => {
	const calls = [];
	const dashboard = new Proxy({}, { get: (_, name) => async (...args) => (calls.push(name), name === "list" ? [] : true) });
	const { ctx } = fakeCtx({ dashboard });
	await register(ctx);
	await new Promise((r) => setTimeout(r, 50));
	// No overdue invoices: the notification is removed; to-dos are listed to reconcile.
	assert.deepEqual(calls, ["remove", "list"]);
});

test("only admins change taxes, categories and numbering", async () => {
	const { ctx, routes } = fakeCtx();
	await register(ctx);
	const call = (method, path, role) => routes.find((r) => r.method === method && r.path === path).handler({ params: { id: "1" }, body: {}, query: new URLSearchParams(), user: { username: "bob", role } });
	for (const [m, p] of [["POST", "/taxes"], ["PUT", "/taxes/:id"], ["DELETE", "/taxes/:id"], ["POST", "/categories"], ["PUT", "/categories/:id"], ["DELETE", "/categories/:id"], ["PUT", "/numbering"]]) {
		await assert.rejects(call(m, p, "bookkeeper"), (e) => e.status === 403, `${m} ${p}`);
	}
});

test("search results link into the module page", async () => {
	let provider;
	const { ctx } = fakeCtx({ search: { provide: (fn) => (provider = fn) } });
	ctx.db.query = async (sql) => ({
		rows: sql.includes("FROM mod_sales.documents d JOIN")
			? [{ id: 31n, kind: "invoice", number: "INV-0031", status: "open", currency: "CAD", total_cents: 420000n, issue_date: "2026-11-01", customer: "Acme" }]
			: sql.includes("FROM mod_sales.customers")
				? [{ id: 7n, name: "Acme", company: "Acme Corp", email: "ap@acme.test" }]
				: [],
		rowCount: 0,
	});
	await register(ctx);
	assert.deepEqual(await provider("a", { limit: 8 }), []); // too short to search
	const r = await provider("acme", { limit: 8 });
	assert.deepEqual(r.map((x) => x.href), ["/apps/sales?open=customers%2F7", "/apps/sales?open=invoices%2F31"]);
	assert.equal(r[1].subtitle, "Acme · $4,200.00 CAD · open · 2026-11-01");
});

test("organizations: startup and dashboard syncs run in each organization's books", async () => {
	let current = 1; // the organization Ledger is "in", as ctx.orgs.forEach would set it
	const seen = []; // [what, organization]
	const orgs = [{ id: 1, name: "Main books", kind: "business" }, { id: 2, name: "Side", kind: "business" }];
	const dashboard = new Proxy({}, { get: (_, name) => async () => (seen.push([`dashboard.${String(name)}`, current]), name === "list" ? [] : true) });
	const { ctx, routes } = fakeCtx({
		dashboard,
		orgs: {
			forEach: async (fn) => {
				for (const o of orgs) {
					current = o.id;
					await fn(o);
				}
				current = 1;
			},
		},
	});
	ctx.db.query = async (sql) => {
		if (sql.includes("status = 'posting'")) seen.push(["recover", current]);
		if (sql.includes("NOT moved_to_ledger_settings")) seen.push(["move", current]);
		return { rows: [], rowCount: 0 };
	};
	await register(ctx);
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(seen.filter(([w]) => w === "recover").map(([, o]) => o), [1, 2]);
	// Old settings are copied in each organization (settings are per organization from Ledger 0.11.1).
	assert.deepEqual(seen.filter(([w]) => w === "move").map(([, o]) => o), [1, 2]);
	assert.deepEqual([...new Set(seen.filter(([w]) => w === "dashboard.list").map(([, o]) => o))], [1, 2]);

	// A change in organization 2 syncs organization 2 only.
	seen.length = 0;
	const route = routes.find((r) => r.method === "PUT" && r.path === "/numbering");
	await route.handler({ params: {}, body: {}, query: new URLSearchParams(), user: { username: "a", role: "admin", organization: { id: 2, name: "Side", kind: "business" } } });
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual([...new Set(seen.filter(([w]) => w.startsWith("dashboard.")).map(([, o]) => o))], [2]);
});
