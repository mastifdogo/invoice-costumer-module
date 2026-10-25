// Sales for Ledger: invoices, quotes, estimates, customers, sales taxes and
// categories. Ledger loads this file at startup and calls register(ctx); the
// API it gets is described in Ledger's docs/MODULES.md. Every route is under
// /api/v1/m/sales.

import { catalogRoutes } from "./server/catalog.mjs";
import { helpers } from "./server/common.mjs";
import { customerRoutes } from "./server/customers.mjs";
import { dashboardSync } from "./server/dashboard.mjs";
import { documentRoutes } from "./server/documents.mjs";
import { mailHelpers } from "./server/email.mjs";
import { settingsRoutes } from "./server/settings.mjs";

export default async function register(ctx) {
	const h = helpers(ctx);
	const dashboard = dashboardSync(ctx, h);
	// Every successful change (anything but GET) refreshes the dashboard items.
	const routes = Object.create(ctx);
	routes.route = (method, path, handler) =>
		ctx.route(method, path, async (req) => {
			const result = await handler(req);
			if (method !== "GET") dashboard.schedule();
			return result;
		});

	const mail = mailHelpers(routes, h);
	settingsRoutes(routes, h, mail);
	catalogRoutes(routes, h);
	customerRoutes(routes, h);
	const docs = documentRoutes(routes, h, mail);
	await docs.recover();
	dashboard.start();
	ctx.log.info("sales module ready", { dashboard: Boolean(ctx.dashboard) });
}
