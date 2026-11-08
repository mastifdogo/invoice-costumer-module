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
import { moveSettings } from "./server/move-settings.mjs";
import { paymentRoutes } from "./server/payments.mjs";
import { searchProvider } from "./server/search.mjs";
import { settingsRoutes } from "./server/settings.mjs";

export default async function register(ctx) {
	const h = helpers(ctx);
	const dashboard = dashboardSync(ctx, h);
	// Every successful change (anything but GET) refreshes the dashboard items.
	const routes = Object.create(ctx);
	routes.route = (method, path, handler) =>
		ctx.route(method, path, async (req) => {
			const result = await handler(req);
			if (method !== "GET") dashboard.schedule(req.user?.organization?.id);
			return result;
		});

	const mail = mailHelpers(routes, h);
	settingsRoutes(routes, h, mail);
	catalogRoutes(routes, h);
	customerRoutes(routes, h);
	const docs = documentRoutes(routes, h, mail);
	paymentRoutes(routes, h, docs);
	searchProvider(ctx, h);
	// Settings are server-wide, and before organizations there was one set of
	// books: copy the old values from the main books only.
	await moveSettings(ctx, h);
	// Startup runs in the main books; each organization has its own documents.
	if (ctx.orgs) await ctx.orgs.forEach((org) => docs.recover(org));
	else await docs.recover();
	dashboard.start();
	ctx.log.info("sales module ready", { dashboard: Boolean(ctx.dashboard) });
}
