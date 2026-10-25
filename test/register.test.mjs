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
		...extra,
	};
	return { ctx, routes, logs };
}

test("loads on a Ledger without ctx.dashboard (before it was added)", async () => {
	const { ctx, routes, logs } = fakeCtx();
	await register(ctx);
	assert.ok(routes.length > 50);
	for (const p of ["/invoices", "/quotes", "/estimates", "/customers", "/categories", "/taxes", "/settings"]) {
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
