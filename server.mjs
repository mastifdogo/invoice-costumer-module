// Sales for Ledger: invoices, quotes, estimates, customers, sales taxes and
// categories. Ledger loads this file at startup and calls register(ctx); the
// API it gets is described in Ledger's docs/MODULES.md. Every route is under
// /api/v1/m/sales.

import { catalogRoutes } from "./server/catalog.mjs";
import { helpers } from "./server/common.mjs";
import { customerRoutes } from "./server/customers.mjs";
import { documentRoutes } from "./server/documents.mjs";
import { mailHelpers } from "./server/email.mjs";
import { settingsRoutes } from "./server/settings.mjs";

export default async function register(ctx) {
	const h = helpers(ctx);
	const mail = mailHelpers(ctx, h);
	settingsRoutes(ctx, h, mail);
	catalogRoutes(ctx, h);
	customerRoutes(ctx, h);
	const docs = documentRoutes(ctx, h, mail);
	await docs.recover();
	ctx.log.info("sales module ready");
}
