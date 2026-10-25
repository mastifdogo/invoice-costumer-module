// Invoices, quotes and estimates. They share one table and most of their
// code (lines, categories, taxes, PDF, email), but each kind has its own
// routes (/invoices, /quotes, /estimates), numbering and statuses:
//
//   invoice:          draft → open → paid, or open → void. Issuing posts it to
//                     the books when ledger posting is on (Dr receivable,
//                     Cr revenue per category and each tax); payments post
//                     Dr bank / Cr receivable; voiding reverses.
//   quote, estimate:  draft → sent → accepted or declined; "convert" turns
//                     one into a draft invoice. Never posted to the books.

import { addDays, computeTotals, formatDecimal, formatMoney, MAX_CENTS, today } from "../lib/money.mjs";
import { renderDocumentPdf } from "../lib/pdf.mjs";
import { KINDS } from "./common.mjs";

const MAX_LINES = 200;
// Column types for parameters in INSERT ... SELECT, where Postgres can't infer them.
const COLUMN_TYPES = {
	customer_id: "bigint",
	issue_date: "date",
	due_date: "date",
	currency: "text",
	po_number: "text",
	notes: "text",
	subtotal_cents: "bigint",
	tax_cents: "bigint",
	total_cents: "bigint",
	source_id: "bigint",
};
const OPEN_QUOTE = ["draft", "sent"];

export function documentRoutes(ctx, h, mail) {
	const { T, q, bad, notFound, conflict, body, text, dateField, currency, decimal, id, isId, idList, like, loadSettings } = h;

	const byId = (rows) => new Map(rows.map((r) => [String(r.id), r]));
	const loadTaxes = async () => byId((await q(`SELECT * FROM ${T("taxes")}`)).rows);
	const loadCategories = async () => byId((await q(`SELECT * FROM ${T("categories")}`)).rows);
	const validDays = (kind, s, cust) => (kind === "invoice" ? (cust.terms_days ?? s.default_terms_days) : s[KINDS[kind].validDays]);

	// ---- input --------------------------------------------------------------------

	/** Validates a document body; returns its columns and lines (as JSON for jsonb_to_recordset). */
	async function documentInput(kind, o, s, existing) {
		const customerId = o.customer_id ?? existing?.customer_id;
		if (!isId(customerId)) throw bad("customer_id is required");
		const { rows } = await q(`SELECT id, currency, terms_days, tax_ids, archived FROM ${T("customers")} WHERE id = $1`, [String(customerId)]);
		const cust = rows[0];
		if (!cust) throw bad("customer_id: there is no such customer");
		if (cust.archived && String(existing?.customer_id) !== String(cust.id)) throw bad("customer_id: this customer is archived");

		const issue = o.issue_date === undefined ? (existing?.issue_date ?? today()) : dateField(o.issue_date, "issue_date");
		const keepDue = existing && o.issue_date === undefined;
		const due = o.due_date === undefined || o.due_date === "" || o.due_date === null ? (keepDue ? existing.due_date : addDays(issue, validDays(kind, s, cust))) : dateField(o.due_date, "due_date");
		if (due < issue) throw bad(`${kind === "invoice" ? "due_date" : "valid until"} can't be before the date`);
		const cur = o.currency === undefined ? (existing?.currency ?? cust.currency) : currency(o.currency);

		let lines = existing?.lines ?? [];
		if (!(o.lines === undefined && existing)) {
			if (!Array.isArray(o.lines) || o.lines.length === 0) throw bad("lines: add at least one line");
			if (o.lines.length > MAX_LINES) throw bad(`lines: at most ${MAX_LINES} lines`);
			const [taxes, categories] = await Promise.all([loadTaxes(), loadCategories()]);
			lines = o.lines.map((l, i) => {
				const f = (k) => `lines[${i + 1}].${k}`;
				if (!l || typeof l !== "object") throw bad(`${f("description")} is required`);
				let category = null;
				if (l.category_id !== undefined && l.category_id !== null && l.category_id !== "") {
					category = isId(l.category_id) ? categories.get(String(l.category_id)) : undefined;
					if (!category) throw bad(`${f("category_id")}: there is no such category`);
				}
				const description = text(l, "description", 1000, { required: true, multiline: true });
				const quantity = decimal(l.quantity ?? "1", 3, f("quantity"));
				if (quantity <= 0n || quantity > 10n ** 12n) throw bad(`${f("quantity")} must be more than 0`);
				const unit = decimal(l.unit_price ?? "", 2, f("unit_price"));
				if (unit > MAX_CENTS || unit < -MAX_CENTS) throw bad(`${f("unit_price")} is too large`);
				// Taxes: as given, else the category's, the customer's, or the defaults.
				const taxIds = l.tax_ids === undefined || l.tax_ids === null ? (category?.tax_ids ?? cust.tax_ids ?? s.default_tax_ids ?? []).map(String) : idList(l.tax_ids, f("tax_ids"));
				const lineTaxes = taxIds.map((tid) => {
					const t = taxes.get(String(tid));
					if (!t) throw bad(`${f("tax_ids")}: there is no such tax`);
					return { id: Number(t.id), name: t.name, rate: Number(t.rate) };
				});
				return { category_id: category ? String(category.id) : null, description, quantity, unit_price_cents: unit, taxes: lineTaxes };
			});
		}
		const totals = computeTotals(lines);
		if (totals.total > MAX_CENTS || totals.total < -MAX_CENTS) throw bad("the total is too large");
		return {
			cols: {
				customer_id: String(cust.id),
				issue_date: issue,
				due_date: due,
				currency: cur,
				po_number: o.po_number === undefined ? (existing?.po_number ?? "") : text(o, "po_number", 100),
				notes: o.notes === undefined ? (existing?.notes ?? "") : text(o, "notes", 5000, { multiline: true }),
				subtotal_cents: totals.subtotal.toString(),
				tax_cents: totals.tax.toString(),
				total_cents: totals.total.toString(),
			},
			linesJson: JSON.stringify(
				lines.map((l, i) => ({
					position: i + 1,
					category_id: l.category_id === null ? null : String(l.category_id),
					description: l.description,
					quantity: l.quantity.toString(),
					unit_price_cents: l.unit_price_cents.toString(),
					taxes: l.taxes,
					amount_cents: totals.amounts[i].toString(),
				})),
			),
		};
	}

	const LINES_FROM_JSON = (src, param) => `
		INSERT INTO ${T("document_lines")} (document_id, position, category_id, description, quantity, unit_price_cents, taxes, amount_cents)
		SELECT ${src}.id, x.position, x.category_id, x.description, x.quantity, x.unit_price_cents, x.taxes, x.amount_cents
		  FROM ${src}, jsonb_to_recordset(${param}::jsonb)
		       AS x(position int, category_id bigint, description text, quantity bigint, unit_price_cents bigint, taxes jsonb, amount_cents bigint)`;

	/** Inserts a draft with the kind's next number, skipping numbers already taken. */
	async function insertDocument(kind, cols, linesJson, user) {
		const { prefix, next } = KINDS[kind];
		const names = Object.keys(cols);
		const params = [...Object.values(cols), user.username, linesJson, kind];
		const n = names.length;
		const sql = `
			WITH n AS (
				UPDATE ${T("settings")} SET ${next} = ${next} + 1 WHERE id = 1
				RETURNING ${prefix} || lpad((${next} - 1)::text, 4, '0') AS number
			), doc AS (
				INSERT INTO ${T("documents")} (kind, number, ${names.join(", ")}, created_by)
				SELECT $${n + 3}::text, n.number, ${names.map((k, i) => `$${i + 1}::${COLUMN_TYPES[k]}`).join(", ")}, $${n + 1}::text FROM n
				RETURNING id
			), lines AS (${LINES_FROM_JSON("doc", `$${n + 2}`)})
			SELECT id FROM doc`;
		for (let attempt = 0; ; attempt++) {
			try {
				const { rows } = await q(sql, params);
				return rows[0].id;
			} catch (e) {
				if (e?.code !== "23505" || attempt >= 100) throw e;
				// The number is taken (e.g. the next number was set back); the failed
				// statement rolled back, so step past it and try again.
				await q(`UPDATE ${T("settings")} SET ${next} = ${next} + 1 WHERE id = 1`);
			}
		}
	}

	// ---- reading ------------------------------------------------------------------------

	async function getDocument(did, kind) {
		const { rows } = await q(
			`SELECT d.*, d.issue_date::text, d.due_date::text,
			        jsonb_build_object('id', c.id, 'name', c.name, 'company', c.company, 'email', c.email, 'cc_emails', c.cc_emails,
			                           'address', c.address, 'tax_id', c.tax_id, 'phone', c.phone) AS customer,
			        (SELECT jsonb_build_object('id', s.id, 'kind', s.kind, 'number', s.number) FROM ${T("documents")} s WHERE s.id = d.source_id) AS source,
			        (SELECT jsonb_build_object('id', v.id, 'kind', v.kind, 'number', v.number) FROM ${T("documents")} v WHERE v.id = d.converted_id) AS converted
			   FROM ${T("documents")} d JOIN ${T("customers")} c ON c.id = d.customer_id
			  WHERE d.id = $1`,
			[did],
		);
		const doc = rows[0];
		if (!doc || (kind && doc.kind !== kind)) throw notFound(kind ?? "document");
		const [lines, payments, emails] = await Promise.all([
			q(
				`SELECT l.id, l.position, l.category_id, cat.name AS category_name, l.description, l.quantity, l.unit_price_cents, l.taxes, l.amount_cents
				   FROM ${T("document_lines")} l LEFT JOIN ${T("categories")} cat ON cat.id = l.category_id
				  WHERE l.document_id = $1 ORDER BY l.position, l.id`,
				[did],
			),
			q(`SELECT id, payment_date::text, amount_cents, method, reference, journal_entry_id, created_by, created_at FROM ${T("payments")} WHERE document_id = $1 ORDER BY payment_date, id`, [did]),
			q(`SELECT id, recipients, subject, ok, error, sent_by, sent_at FROM ${T("email_log")} WHERE document_id = $1 ORDER BY id DESC LIMIT 50`, [did]),
		]);
		doc.lines = lines.rows.map((l) => ({ ...l, quantity_text: formatDecimal(l.quantity, 3), tax_ids: l.taxes.map((t) => t.id) }));
		doc.payments = payments.rows;
		doc.emails = emails.rows;
		doc.taxes = computeTotals(doc.lines).taxes;
		doc.balance_cents = doc.kind !== "invoice" || doc.status === "void" ? 0n : BigInt(doc.total_cents) - BigInt(doc.paid_cents);
		const t = today();
		doc.overdue = doc.kind === "invoice" && doc.status === "open" && doc.due_date < t;
		doc.expired = doc.kind !== "invoice" && OPEN_QUOTE.includes(doc.status) && doc.due_date < t;
		return doc;
	}

	const LIST_FILTERS = {
		invoice: {
			"": "true",
			draft: "d.status IN ('draft', 'posting')",
			open: "d.status = 'open'",
			overdue: "d.status = 'open' AND d.due_date < $4::date",
			paid: "d.status = 'paid'",
			void: "d.status = 'void'",
		},
		quote: {
			"": "true",
			pending: "d.status IN ('draft', 'sent') AND d.due_date >= $4::date",
			draft: "d.status = 'draft'",
			sent: "d.status = 'sent'",
			accepted: "d.status = 'accepted'",
			declined: "d.status = 'declined'",
			expired: "d.status IN ('draft', 'sent') AND d.due_date < $4::date",
			converted: "d.status = 'converted'",
		},
	};
	LIST_FILTERS.estimate = LIST_FILTERS.quote;

	// ---- invoice posting --------------------------------------------------------------

	/** The ledger lines for an invoice: Dr receivable; Cr revenue per category account and each tax's account. */
	async function postingLines(doc, totals, s) {
		const cur = doc.currency;
		const receivable = s.accounts?.[cur]?.receivable;
		if (!receivable) throw bad(`Ledger posting is on, but no receivable account is set for ${cur} (Settings → Ledger posting)`);
		const [categories, taxes] = await Promise.all([loadCategories(), loadTaxes()]);
		const credits = new Map(); // account → cents
		const add = (acct, cents, memo) => credits.set(acct, { cents: (credits.get(acct)?.cents ?? 0n) + cents, memo });
		doc.lines.forEach((l, i) => {
			const cat = l.category_id === null ? null : categories.get(String(l.category_id));
			const acct = cat?.accounts?.[cur] || s.accounts?.[cur]?.revenue;
			if (!acct) {
				throw bad(
					cat
						? `category "${cat.name}" has no ${cur} revenue account, and no default revenue account is set (Settings → Ledger posting)`
						: `line ${i + 1} has no category, and no default ${cur} revenue account is set (Settings → Ledger posting)`,
				);
			}
			add(acct, totals.amounts[i], cat ? cat.name : "Sales");
		});
		for (const t of totals.taxes) {
			if (t.tax_cents === 0n) continue;
			const acct = taxes.get(String(t.id))?.accounts?.[cur];
			if (!acct) throw bad(`set the ${cur} account for ${t.name} first (Settings → Taxes)`);
			add(acct, t.tax_cents, t.name);
		}
		const memo = `Invoice ${doc.number}`;
		const lines = [{ account_code: receivable, debit_cents: totals.total, memo }];
		for (const [acct, { cents, memo: what }] of credits) {
			if (cents > 0n) lines.push({ account_code: acct, credit_cents: cents, memo: `${what} – ${memo}` });
			else if (cents < 0n) lines.push({ account_code: acct, debit_cents: -cents, memo: `${what} – ${memo}` });
		}
		return lines;
	}

	/** Issues a draft invoice: locks it, posts it to the books when enabled, and marks it open. */
	async function issueInvoice(did, user) {
		const s = await loadSettings();
		const claimed = await q(`UPDATE ${T("documents")} SET status = 'posting', updated_at = now() WHERE id = $1 AND kind = 'invoice' AND status = 'draft' RETURNING id`, [did]);
		if (claimed.rowCount === 0) {
			const doc = await getDocument(did, "invoice");
			throw conflict(doc.status === "posting" ? "this invoice is being issued right now" : `invoice ${doc.number} is already issued`);
		}
		let entryId = null;
		try {
			const doc = await getDocument(did, "invoice");
			const totals = computeTotals(doc.lines);
			if (totals.total <= 0n) throw bad("the invoice total must be more than zero");
			if (s.post_to_ledger) {
				const entry = await ctx.ledger.createJournalEntry(
					{
						entry_date: doc.issue_date,
						description: `Invoice ${doc.number} – ${doc.customer.name}`.slice(0, 500),
						reference: doc.number.slice(0, 100),
						lines: await postingLines(doc, totals, s),
					},
					user,
				);
				entryId = String(entry.id);
			}
			await q(
				`UPDATE ${T("documents")} SET status = 'open', journal_entry_id = $2, issued_at = now(), updated_at = now(),
				        subtotal_cents = $3, tax_cents = $4, total_cents = $5
				  WHERE id = $1`,
				[did, entryId, totals.subtotal.toString(), totals.tax.toString(), totals.total.toString()],
			);
		} catch (e) {
			if (entryId === null) await q(`UPDATE ${T("documents")} SET status = 'draft' WHERE id = $1 AND status = 'posting'`, [did]);
			throw e;
		}
		ctx.log.info("invoice issued", { document: did, entry: entryId, user: user.username });
		return getDocument(did);
	}

	/** Deletes a payment row and takes it off the invoice; returns the deleted payment or null. */
	async function removePayment(did, pid) {
		const { rows } = await q(
			`WITH p AS (DELETE FROM ${T("payments")} WHERE id = $2 AND document_id = $1 RETURNING amount_cents, journal_entry_id),
			      doc AS (UPDATE ${T("documents")} d
			                 SET paid_cents = d.paid_cents - p.amount_cents, updated_at = now(),
			                     status = CASE WHEN d.status = 'paid' THEN 'open' ELSE d.status END
			                FROM p WHERE d.id = $1)
			 SELECT * FROM p`,
			[did, pid],
		);
		return rows[0] ?? null;
	}

	// ---- PDF and email ----------------------------------------------------------------------

	const pdfName = (doc) => `${KINDS[doc.kind].label}-${doc.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;

	function fill(template, doc, s) {
		const label = KINDS[doc.kind].label;
		const vars = {
			type: label,
			type_lower: label.toLowerCase(),
			number: doc.number,
			customer: doc.customer.name,
			company: doc.customer.company || doc.customer.name,
			total: formatMoney(doc.total_cents, doc.currency),
			balance: formatMoney(doc.balance_cents, doc.currency),
			due_date: doc.due_date,
			valid_until: doc.due_date,
			issue_date: doc.issue_date,
			business: s.business_name || s.from_name || "",
		};
		return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
	}

	function emailDefaults(doc, s) {
		const inv = doc.kind === "invoice";
		return {
			to: doc.customer.email,
			cc: doc.customer.cc_emails,
			subject: fill(inv ? s.email_subject : s.quote_email_subject, doc, s),
			message: fill(inv ? s.email_body : s.quote_email_body, doc, s),
		};
	}

	const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

	function summaryRows(doc) {
		const label = KINDS[doc.kind].label;
		return doc.kind === "invoice"
			? [[label, doc.number], ["Issued", doc.issue_date], ["Due", doc.due_date], ["Amount due", formatMoney(doc.balance_cents, doc.currency)]]
			: [[label, doc.number], ["Date", doc.issue_date], ["Valid until", doc.due_date], ["Total", formatMoney(doc.total_cents, doc.currency)]];
	}

	function emailHtml(message, doc) {
		const paras = message
			.split(/\n{2,}/)
			.map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
			.join("");
		const rows = summaryRows(doc);
		const row = ([k, v], i) =>
			`<tr><td style="padding:4px 16px 4px 0;color:#5d6875">${esc(k)}</td><td style="padding:4px 0;text-align:right${i === rows.length - 1 ? ";font-weight:600" : ""}">${esc(v)}</td></tr>`;
		return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:24px;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d232b">
${paras}
<table style="border-collapse:collapse;margin-top:8px;font-size:14px">${rows.map(row).join("")}</table>
<p style="margin:16px 0 0;color:#5d6875;font-size:13px">The ${esc(KINDS[doc.kind].label.toLowerCase())} is attached as a PDF.</p>
</div></body></html>`;
	}

	// ---- routes, per kind ----------------------------------------------------------------------

	for (const [kind, K] of Object.entries(KINDS)) {
		const base = `/${K.plural}`;
		const docId = (req) => id(req, "id", kind);
		const isInvoice = kind === "invoice";
		const editable = (doc) => (isInvoice ? doc.status === "draft" : OPEN_QUOTE.includes(doc.status));

		ctx.route("GET", base, async (req) => {
			const status = req.query.get("status") ?? "";
			const search = (req.query.get("q") ?? "").trim();
			const customer = req.query.get("customer_id") ?? "";
			if (customer && !/^\d{1,18}$/.test(customer)) throw bad("customer_id is not valid");
			const where = LIST_FILTERS[kind][status];
			if (!where) throw bad(`status must be one of: ${Object.keys(LIST_FILTERS[kind]).filter(Boolean).join(", ")}`);
			const { rows } = await q(
				`SELECT d.id, d.kind, d.number, d.status, d.issue_date::text, d.due_date::text, d.currency, d.total_cents, d.paid_cents,
				        d.sent_at, d.customer_id, c.name AS customer_name, c.company AS customer_company
				   FROM ${T("documents")} d JOIN ${T("customers")} c ON c.id = d.customer_id
				  WHERE d.kind = $5 AND ${where}
				    AND ($1 = '' OR d.number ILIKE $2 OR c.name ILIKE $2 OR c.company ILIKE $2 OR d.po_number ILIKE $2)
				    AND ($3 = '' OR d.customer_id = nullif($3, '')::bigint)
				    AND $4::date IS NOT NULL
				  ORDER BY d.issue_date DESC, d.id DESC
				  LIMIT 500`,
				[search, like(search), customer, today(), kind],
			);
			const t = today();
			return {
				data: rows.map((d) => ({
					...d,
					overdue: isInvoice && d.status === "open" && d.due_date < t,
					expired: !isInvoice && OPEN_QUOTE.includes(d.status) && d.due_date < t,
				})),
			};
		});

		ctx.route("POST", base, async (req) => {
			const s = await loadSettings();
			const { cols, linesJson } = await documentInput(kind, body(req), s, null);
			return ctx.response(201, await getDocument(await insertDocument(kind, cols, linesJson, req.user)));
		});

		ctx.route("GET", `${base}/:id`, async (req) => getDocument(docId(req), kind));

		ctx.route("PUT", `${base}/:id`, async (req) => {
			const existing = await getDocument(docId(req), kind);
			const why = isInvoice ? "only draft invoices can be edited" : `only draft or sent ${K.plural} can be edited`;
			if (!editable(existing)) throw conflict(why);
			const s = await loadSettings();
			const { cols, linesJson } = await documentInput(kind, body(req), s, existing);
			const names = Object.keys(cols);
			// One statement, so the document and its lines change together, and only while it's still editable.
			const { rows } = await q(
				`WITH upd AS (
					UPDATE ${T("documents")} SET ${names.map((k, i) => `${k} = $${i + 2}::${COLUMN_TYPES[k]}`).join(", ")}, updated_at = now()
					 WHERE id = $1 AND status = ANY($${names.length + 3}::text[]) RETURNING id
				), del AS (
					DELETE FROM ${T("document_lines")} WHERE document_id IN (SELECT id FROM upd)
				), ins AS (${LINES_FROM_JSON("upd", `$${names.length + 2}`)})
				SELECT id FROM upd`,
				[existing.id, ...Object.values(cols), linesJson, isInvoice ? ["draft"] : OPEN_QUOTE],
			);
			if (!rows[0]) throw conflict(why);
			return getDocument(existing.id);
		});

		ctx.route("DELETE", `${base}/:id`, async (req) => {
			const did = docId(req);
			const allowed = isInvoice ? ["draft"] : ["draft", "sent", "accepted", "declined"];
			const { rowCount } = await q(`DELETE FROM ${T("documents")} WHERE id = $1 AND kind = $2 AND status = ANY($3::text[])`, [did, kind, allowed]);
			if (rowCount === 0) {
				await getDocument(did, kind); // 404 when missing
				throw conflict(isInvoice ? "only drafts can be deleted; void an issued invoice instead" : `this ${kind} was converted to an invoice and can't be deleted`);
			}
		});

		ctx.route("POST", `${base}/:id/duplicate`, async (req) => {
			const src = await getDocument(docId(req), kind);
			const s = await loadSettings();
			const taxes = await loadTaxes();
			const { cols, linesJson } = await documentInput(
				kind,
				{
					customer_id: src.customer_id,
					issue_date: today(),
					currency: src.currency,
					notes: src.notes,
					lines: src.lines.map((l) => ({
						category_id: l.category_id,
						description: l.description,
						quantity: formatDecimal(l.quantity, 3),
						unit_price: formatDecimal(l.unit_price_cents, 2),
						tax_ids: l.tax_ids.filter((t) => taxes.has(String(t))),
					})),
				},
				s,
				null,
			);
			return ctx.response(201, await getDocument(await insertDocument(kind, cols, linesJson, req.user)));
		});

		ctx.route("GET", `${base}/:id/pdf`, async (req) => {
			const doc = await getDocument(docId(req), kind);
			const pdf = renderDocumentPdf(doc, await loadSettings());
			return { filename: pdfName(doc), content_type: "application/pdf", content_base64: pdf.toString("base64") };
		});

		ctx.route("GET", `${base}/:id/email`, async (req) => emailDefaults(await getDocument(docId(req), kind), await loadSettings()));

		ctx.route("POST", `${base}/:id/send`, async (req) => {
			const did = docId(req);
			const o = body(req);
			const s = await loadSettings();
			let doc = await getDocument(did, kind);
			if (["void", "declined", "converted"].includes(doc.status)) throw conflict(`this ${kind} is ${doc.status}`);
			const d = emailDefaults(doc, s);
			const to = mail.addresses(o.to ?? d.to, "to", true);
			const cc = mail.addresses(o.cc ?? d.cc, "cc", false);
			const subject = o.subject === undefined ? d.subject : text(o, "subject", 300, { required: true });
			const message = o.message === undefined ? d.message : text(o, "message", 10000, { multiline: true });
			if (!s.smtp_host || !s.from_email) throw bad("set up email first (Settings → Email)");
			if (isInvoice && doc.status === "draft") doc = await issueInvoice(did, req.user);

			const recipients = [...to, ...cc].join(", ");
			try {
				await mail.deliver(s, {
					to,
					cc,
					bcc: s.bcc_self ? [s.from_email] : [],
					subject,
					text: message + "\n\n" + summaryRows(doc).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n",
					html: emailHtml(message, doc),
					attachments: [{ filename: pdfName(doc), contentType: "application/pdf", content: renderDocumentPdf(doc, s) }],
				});
			} catch (e) {
				const msg = e instanceof ctx.HttpError ? e.message : `sending failed: ${e.message}`;
				await q(`INSERT INTO ${T("email_log")} (document_id, recipients, subject, ok, error, sent_by) VALUES ($1, $2, $3, false, $4, $5)`, [did, recipients, subject, msg.slice(0, 1000), req.user.username]);
				ctx.log.warn("email failed", { document: did, err: e.message });
				throw e instanceof ctx.HttpError ? e : new ctx.HttpError(502, msg);
			}
			await q(`INSERT INTO ${T("email_log")} (document_id, recipients, subject, ok, sent_by) VALUES ($1, $2, $3, true, $4)`, [did, recipients, subject, req.user.username]);
			await q(`UPDATE ${T("documents")} SET sent_at = now(), status = CASE WHEN kind <> 'invoice' AND status = 'draft' THEN 'sent' ELSE status END WHERE id = $1`, [did]);
			ctx.log.info("document emailed", { document: did, kind, to: recipients, user: req.user.username });
			return getDocument(did);
		});

		if (isInvoice) invoiceRoutes(base, docId);
		else quoteRoutes(kind, base, docId);
	}

	// ---- invoice-only routes ------------------------------------------------------------------

	function invoiceRoutes(base, docId) {
		ctx.route("POST", `${base}/:id/issue`, async (req) => issueInvoice(docId(req), req.user));

		ctx.route("POST", `${base}/:id/void`, async (req) => {
			const did = docId(req);
			const o = body(req);
			const date = o.date === undefined || o.date === "" ? today() : dateField(o.date, "date");
			const { rows } = await q(
				`UPDATE ${T("documents")} SET status = 'void', updated_at = now()
				  WHERE id = $1 AND kind = 'invoice' AND status = 'open' AND paid_cents = 0 RETURNING number, journal_entry_id`,
				[did],
			);
			if (!rows[0]) {
				const doc = await getDocument(did, "invoice");
				if (doc.status === "draft") throw conflict("drafts aren't in the books; delete it instead");
				if (doc.status === "void") throw conflict("this invoice is already void");
				throw conflict("remove this invoice's payments before voiding it");
			}
			const { number, journal_entry_id } = rows[0];
			if (journal_entry_id !== null) {
				try {
					const rev = await ctx.ledger.reverseJournalEntry(journal_entry_id, { entry_date: date, description: `Void invoice ${number}` }, req.user);
					await q(`UPDATE ${T("documents")} SET void_entry_id = $2 WHERE id = $1`, [did, String(rev.id)]);
				} catch (e) {
					await q(`UPDATE ${T("documents")} SET status = 'open' WHERE id = $1 AND status = 'void'`, [did]);
					throw e;
				}
			}
			return getDocument(did);
		});

		ctx.route("POST", `${base}/:id/payments`, async (req) => {
			const did = docId(req);
			const o = body(req);
			const s = await loadSettings();
			const date = o.payment_date === undefined || o.payment_date === "" ? today() : dateField(o.payment_date, "payment_date");
			const amount = decimal(o.amount, 2, "amount");
			if (amount <= 0n) throw bad("amount must be more than zero");
			const method = text(o, "method", 50);
			const reference = text(o, "reference", 100);

			const before = await getDocument(did, "invoice");
			if (before.status !== "open") throw conflict(`payments can only be recorded on issued, unpaid invoices (this one is ${before.status})`);
			if (amount > before.balance_cents) throw bad(`amount is more than the balance due (${formatMoney(before.balance_cents, before.currency)})`);
			const post = s.post_to_ledger && before.journal_entry_id !== null;
			const accounts = s.accounts?.[before.currency] ?? {};
			if (post && (!accounts.receivable || !accounts.bank)) throw bad(`Ledger posting is on, but the ${before.currency} receivable and bank accounts aren't both set (Settings → Ledger posting)`);

			// Record the payment and raise paid_cents in one statement, only if it still fits the balance.
			const { rows } = await q(
				`WITH doc AS (
					UPDATE ${T("documents")}
					   SET paid_cents = paid_cents + $2::bigint, updated_at = now(),
					       status = CASE WHEN paid_cents + $2::bigint >= total_cents THEN 'paid' ELSE status END
					 WHERE id = $1 AND kind = 'invoice' AND status = 'open' AND paid_cents + $2::bigint <= total_cents
					RETURNING id
				)
				INSERT INTO ${T("payments")} (document_id, payment_date, amount_cents, method, reference, created_by)
				SELECT id, $3::date, $2::bigint, $4::text, $5::text, $6::text FROM doc RETURNING id`,
				[did, amount.toString(), date, method, reference, req.user.username],
			);
			if (!rows[0]) throw conflict("the invoice changed meanwhile; reload and try again");
			const pid = rows[0].id;
			if (post) {
				try {
					const memo = `Payment on invoice ${before.number}`;
					const entry = await ctx.ledger.createJournalEntry(
						{
							entry_date: date,
							description: `${memo} – ${before.customer.name}`.slice(0, 500),
							reference: (reference || before.number).slice(0, 100),
							lines: [
								{ account_code: accounts.bank, debit_cents: amount, memo },
								{ account_code: accounts.receivable, credit_cents: amount, memo },
							],
						},
						req.user,
					);
					await q(`UPDATE ${T("payments")} SET journal_entry_id = $2 WHERE id = $1`, [pid, String(entry.id)]);
				} catch (e) {
					await removePayment(did, pid);
					throw e;
				}
			}
			return ctx.response(201, await getDocument(did));
		});

		ctx.route("DELETE", `${base}/:id/payments/:pid`, async (req) => {
			const did = docId(req);
			const pid = id(req, "pid", "payment");
			const doc = await getDocument(did, "invoice");
			const p = doc.payments.find((x) => String(x.id) === pid);
			if (!p) throw notFound("payment");
			// Reverse first: if that fails, nothing has changed. A second concurrent
			// attempt fails here too, since Ledger reverses an entry only once.
			if (p.journal_entry_id !== null) {
				await ctx.ledger.reverseJournalEntry(p.journal_entry_id, { entry_date: today(), description: `Removed payment on invoice ${doc.number}` }, req.user);
			}
			await removePayment(did, pid);
			return getDocument(did);
		});
	}

	// ---- quote and estimate routes ---------------------------------------------------------------

	function quoteRoutes(kind, base, docId) {
		/** Moves a quote/estimate from one of `from` to `to`; explains a refusal. */
		async function transition(req, from, to, extra = "") {
			const did = docId(req);
			const { rowCount } = await q(
				`UPDATE ${T("documents")} SET status = $3, updated_at = now() ${extra} WHERE id = $1 AND kind = $2 AND status = ANY($4::text[])`,
				[did, kind, to, from],
			);
			if (rowCount === 0) {
				const doc = await getDocument(did, kind);
				throw conflict(`this ${kind} is ${doc.status}`);
			}
			return getDocument(did);
		}

		ctx.route("POST", `${base}/:id/mark-sent`, (req) => transition(req, ["draft"], "sent", ", sent_at = coalesce(sent_at, now())"));
		ctx.route("POST", `${base}/:id/accept`, (req) => transition(req, OPEN_QUOTE, "accepted", ", decided_at = now()"));
		ctx.route("POST", `${base}/:id/decline`, (req) => transition(req, OPEN_QUOTE, "declined", ", decided_at = now()"));
		ctx.route("POST", `${base}/:id/reopen`, (req) => transition(req, ["accepted", "declined"], "sent", ", decided_at = NULL"));

		// Turns the quote/estimate into a draft invoice with the same lines.
		ctx.route("POST", `${base}/:id/convert`, async (req) => {
			const did = docId(req);
			const src = await getDocument(did, kind);
			if (!["draft", "sent", "accepted"].includes(src.status)) throw conflict(src.status === "converted" ? `already converted to invoice ${src.converted?.number}` : `this ${kind} is ${src.status}`);
			const claimed = await q(
				`UPDATE ${T("documents")} SET status = 'converted', decided_at = coalesce(decided_at, now()), updated_at = now()
				  WHERE id = $1 AND status = ANY($2::text[]) RETURNING id`,
				[did, ["draft", "sent", "accepted"]],
			);
			if (claimed.rowCount === 0) throw conflict("it changed meanwhile; reload and try again");
			try {
				const s = await loadSettings();
				const { rows } = await q(`SELECT terms_days FROM ${T("customers")} WHERE id = $1`, [src.customer_id]);
				const issue = today();
				const cols = {
					customer_id: String(src.customer_id),
					issue_date: issue,
					due_date: addDays(issue, rows[0].terms_days ?? s.default_terms_days),
					currency: src.currency,
					po_number: src.po_number,
					notes: src.notes,
					subtotal_cents: String(src.subtotal_cents),
					tax_cents: String(src.tax_cents),
					total_cents: String(src.total_cents),
					source_id: String(src.id),
				};
				// The invoice keeps the quoted lines, categories and tax rates as they were.
				const linesJson = JSON.stringify(
					src.lines.map((l) => ({
						position: l.position,
						category_id: l.category_id === null ? null : String(l.category_id),
						description: l.description,
						quantity: String(l.quantity),
						unit_price_cents: String(l.unit_price_cents),
						taxes: l.taxes,
						amount_cents: String(l.amount_cents),
					})),
				);
				const invId = await insertDocument("invoice", cols, linesJson, req.user);
				await q(`UPDATE ${T("documents")} SET converted_id = $2 WHERE id = $1`, [did, invId]);
				ctx.log.info("converted to invoice", { document: did, invoice: String(invId), user: req.user.username });
				return ctx.response(201, await getDocument(invId));
			} catch (e) {
				await q(`UPDATE ${T("documents")} SET status = $2 WHERE id = $1 AND status = 'converted' AND converted_id IS NULL`, [did, src.status]);
				throw e;
			}
		});
	}

	return {
		/** An invoice left in "posting" means Ledger stopped mid-issue; put it back to draft. */
		async recover() {
			const stuck = await q(`UPDATE ${T("documents")} SET status = 'draft' WHERE kind = 'invoice' AND status = 'posting' RETURNING number`);
			for (const r of stuck.rows) {
				ctx.log.warn("invoice was being issued when Ledger stopped; it is a draft again. Check the books for a duplicate entry before issuing it.", { number: r.number });
			}
		},
	};
}
