// Receiving payments from a customer: spread one payment over their open
// invoices, or match bank deposits that are already in the books (imported
// from a statement, say) to open invoices, with simple rules and, when an
// admin allows it, Ledger's AI (ctx.llm).

import { addDays, formatDecimal, formatMoney, today } from "../lib/money.mjs";

const MAX_DEPOSITS = 40;
const MAX_INVOICES = 80;

export function paymentRoutes(ctx, h, docs) {
	const { T, q, bad, notFound, conflict, body, text, dateField, decimal, id, isId, loadSettings } = h;

	async function openInvoices(customerId = null) {
		const { rows } = await q(
			`SELECT d.id, d.number, d.currency, d.total_cents - d.paid_cents AS balance_cents, d.issue_date::text, d.due_date::text,
			        d.po_number, d.journal_entry_id, d.customer_id, c.name AS customer, c.company
			   FROM ${T("documents")} d JOIN ${T("customers")} c ON c.id = d.customer_id
			  WHERE d.kind = 'invoice' AND d.status = 'open' AND ($1::bigint IS NULL OR d.customer_id = $1::bigint)
			  ORDER BY d.due_date, d.issue_date, d.id
			  LIMIT 500`,
			[customerId],
		);
		return rows;
	}

	/** Validates [{invoice_id, amount}] against the invoices; returns [{invoice, cents}]. */
	function allocations(raw, invoices) {
		if (!Array.isArray(raw) || raw.length === 0) throw bad("allocations: choose at least one invoice");
		if (raw.length > 100) throw bad("allocations: at most 100 invoices");
		const byId = new Map(invoices.map((i) => [String(i.id), i]));
		const seen = new Set();
		const out = [];
		raw.forEach((a, n) => {
			const f = `allocations[${n + 1}]`;
			if (!a || typeof a !== "object" || !isId(a.invoice_id)) throw bad(`${f}.invoice_id is required`);
			const inv = byId.get(String(a.invoice_id));
			if (!inv) throw bad(`${f}: that invoice isn't open for this customer`);
			if (seen.has(String(inv.id))) throw bad(`${f}: ${inv.number} is listed twice`);
			seen.add(String(inv.id));
			const cents = decimal(a.amount, 2, `${f}.amount`);
			if (cents === 0n) return;
			if (cents < 0n) throw bad(`${f}.amount can't be negative`);
			if (cents > BigInt(inv.balance_cents)) throw bad(`${f}: more than the ${formatMoney(inv.balance_cents, inv.currency)} due on ${inv.number}`);
			out.push({ invoice: inv, cents });
		});
		if (out.length === 0) throw bad("allocations: enter an amount for at least one invoice");
		if (new Set(out.map((a) => a.invoice.currency)).size > 1) throw bad("allocations: a payment is in one currency; pay invoices in each currency separately");
		return out;
	}

	/** Records one payment per allocation; if one fails, the ones before it are undone. */
	async function recordAll(allocs, details, user) {
		const done = [];
		try {
			for (const a of allocs) {
				const pid = await docs.recordPayment(a.invoice.id, { ...details, amount: a.cents }, user);
				done.push({ did: a.invoice.id, pid });
			}
		} catch (e) {
			for (const d of done.reverse()) await docs.deletePayment(d.did, d.pid, user).catch((err) => ctx.log.error("could not undo a payment", { err: err.message }));
			throw e;
		}
		return done;
	}

	// Receive a payment from a customer and apply it to their open invoices.
	// Without allocations it pays the oldest first.
	ctx.route("POST", "/customers/:id/payments", async (req) => {
		const cid = id(req, "id", "customer");
		const o = body(req);
		const { rows } = await q(`SELECT id, currency FROM ${T("customers")} WHERE id = $1`, [cid]);
		if (!rows[0]) throw notFound("customer");
		const date = o.payment_date === undefined || o.payment_date === "" ? today() : dateField(o.payment_date, "payment_date");
		const method = text(o, "method", 50);
		const reference = text(o, "reference", 100);
		const invoices = await openInvoices(cid);
		if (invoices.length === 0) throw conflict("this customer has no open invoices");
		let allocs;
		if (o.allocations === undefined) {
			const amount = decimal(o.amount, 2, "amount");
			if (amount <= 0n) throw bad("amount must be more than zero");
			const currency = typeof o.currency === "string" ? o.currency.toUpperCase() : rows[0].currency;
			const candidates = invoices.filter((i) => i.currency === currency);
			const owed = candidates.reduce((s, i) => s + BigInt(i.balance_cents), 0n);
			if (amount > owed) throw bad(`that's more than the ${formatMoney(owed, currency)} this customer owes in ${currency}`);
			allocs = [];
			let left = amount;
			for (const inv of candidates) {
				if (left === 0n) break;
				const cents = left < BigInt(inv.balance_cents) ? left : BigInt(inv.balance_cents);
				allocs.push({ invoice: inv, cents });
				left -= cents;
			}
		} else {
			allocs = allocations(o.allocations, invoices);
			if (o.amount !== undefined && o.amount !== "") {
				const amount = decimal(o.amount, 2, "amount");
				const sum = allocs.reduce((s, a) => s + a.cents, 0n);
				if (sum !== amount) throw bad(`the amounts applied (${formatMoney(sum, "")}) don't add up to the payment (${formatMoney(amount, "")})`);
			}
		}
		const done = await recordAll(allocs, { date, method, reference }, req.user);
		return ctx.response(201, { recorded: done.length, invoices: allocs.map((a) => ({ id: a.invoice.id, number: a.invoice.number, amount_cents: a.cents })) });
	});

	// ---- matching bank deposits ------------------------------------------------------------

	/** Deposits on the bank accounts in Settings that aren't fully accounted for yet. */
	async function deposits(s, days) {
		const from = addDays(today(), -days);
		const ours = await q(`SELECT journal_entry_id FROM ${T("payments")} WHERE journal_entry_id IS NOT NULL`);
		const posted = new Set(ours.rows.map((r) => String(r.journal_entry_id)));
		const matched = await q(`SELECT matched_line_id, sum(amount_cents)::bigint AS cents FROM ${T("payments")} WHERE matched_line_id IS NOT NULL GROUP BY matched_line_id`);
		const used = new Map(matched.rows.map((r) => [String(r.matched_line_id), BigInt(r.cents)]));
		// Someone said a suggestion for this deposit was wrong: don't suggest it again.
		const rejected = await q(`SELECT DISTINCT line_id FROM ${T("payment_suggestions")} WHERE status = 'rejected'`);
		const skip = new Set(rejected.rows.map((r) => String(r.line_id)));
		const out = [];
		for (const [currency, a] of Object.entries(s.accounts)) {
			if (!a.bank) continue;
			let ledger;
			try {
				ledger = await ctx.ledger.accountLedger(a.bank, { from });
			} catch {
				continue; // the account in Settings doesn't exist
			}
			for (const l of ledger.lines) {
				const debit = BigInt(l.debit_cents ?? 0);
				if (debit <= 0n || posted.has(String(l.journal_entry_id)) || skip.has(String(l.line_id))) continue;
				const remaining = debit - (used.get(String(l.line_id)) ?? 0n);
				if (remaining <= 0n) continue;
				out.push({
					entry_id: Number(l.journal_entry_id),
					line_id: Number(l.line_id),
					date: l.entry_date,
					description: [l.description, l.memo].filter(Boolean).join(" – "),
					reference: l.reference ?? "",
					currency,
					deposit_cents: debit,
					remaining_cents: remaining,
				});
			}
		}
		out.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
		return out.slice(0, MAX_DEPOSITS);
	}

	const norm = (s) => String(s ?? "").toLowerCase();

	/** Sure-footed matches without AI: the invoice number in the text, or the exact balance of one invoice. */
	function ruleMatches(deps, invoices) {
		const out = [];
		for (const d of deps) {
			const txt = norm(`${d.description} ${d.reference}`);
			const same = invoices.filter((i) => i.currency === d.currency);
			const named = same.filter((i) => txt.includes(norm(i.number)));
			let pick = null;
			let reason = "";
			if (named.length) {
				let left = d.remaining_cents;
				pick = [];
				for (const inv of named) {
					if (left === 0n) break;
					const cents = left < BigInt(inv.balance_cents) ? left : BigInt(inv.balance_cents);
					pick.push({ inv, cents });
					left -= cents;
				}
				reason = `The deposit mentions ${named.map((i) => i.number).join(", ")}.`;
			} else {
				const exact = same.filter((i) => BigInt(i.balance_cents) === d.remaining_cents);
				const byName = exact.filter((i) => txt.includes(norm(i.customer)) || (i.company && txt.includes(norm(i.company))));
				const one = byName.length === 1 ? byName : exact.length === 1 ? exact : [];
				if (one.length) {
					pick = [{ inv: one[0], cents: d.remaining_cents }];
					reason = `Same amount as the balance on ${one[0].number}${byName.length === 1 ? ", and the deposit names the customer" : ""}.`;
				}
			}
			if (pick?.length) out.push({ deposit: d, allocations: pick, confidence: named.length || pick.length === 1 ? "high" : "medium", source: "rule", reason });
		}
		return out;
	}

	async function aiStatus() {
		if (!ctx.llm) return { available: false, problem: "This Ledger has no AI support." };
		try {
			const st = await ctx.llm.status();
			if (!st.configured) return { available: false, problem: "No LLM connection is set up. An admin can set one under Settings → LLM API." };
			if (!st.allowed) return { available: false, problem: "Sales isn't allowed to use AI yet. An admin can allow it under Settings → LLM API." };
			return { available: true, problem: "" };
		} catch (e) {
			return { available: false, problem: e.message };
		}
	}

	/** Asks the AI to match what the rules couldn't; validates every answer against the real numbers. */
	async function aiMatches(deps, invoices) {
		if (!deps.length || !invoices.length) return [];
		const dep = new Map(deps.map((d, i) => [`D${i + 1}`, d]));
		const inv = new Map(invoices.slice(0, MAX_INVOICES).map((i) => [i.number, i]));
		const fmt = (c) => formatDecimal(c, 2, 2);
		const prompt = [
			"Bank deposits not yet matched to an invoice:",
			...[...dep].map(([k, d]) => `${k} | ${d.date} | ${d.currency} ${fmt(d.remaining_cents)} | ${d.description} | ref: ${d.reference}`),
			"",
			"Open invoices:",
			...[...inv.values()].map((i) => `${i.number} | ${i.customer}${i.company ? ` (${i.company})` : ""} | ${i.currency} ${fmt(i.balance_cents)} due | issued ${i.issue_date} | due ${i.due_date}${i.po_number ? ` | PO ${i.po_number}` : ""}`),
		].join("\n");
		const { data } = await ctx.llm.json({
			system:
				"You match customer payments received in a bank account to the open invoices they pay. Only match when the evidence is reasonable: amounts that equal one invoice or a sum of invoices from the same customer, a customer or company name, an invoice or PO number in the description, dates after the invoice was issued. A deposit may pay several invoices, or part of one. Never match across currencies. Leave a deposit out when unsure. Amounts are decimal strings like \"125.50\".",
			prompt,
			maxTokens: 2000,
			schema: {
				type: "object",
				properties: {
					matches: {
						type: "array",
						items: {
							type: "object",
							properties: {
								deposit: { type: "string" },
								allocations: {
									type: "array",
									items: { type: "object", properties: { invoice: { type: "string" }, amount: { type: "string" } }, required: ["invoice", "amount"] },
								},
								confidence: { type: "string", enum: ["high", "medium", "low"] },
								reason: { type: "string" },
							},
							required: ["deposit", "allocations", "confidence", "reason"],
						},
					},
				},
				required: ["matches"],
			},
		});
		const out = [];
		for (const m of Array.isArray(data?.matches) ? data.matches : []) {
			const d = dep.get(String(m.deposit));
			if (!d || !Array.isArray(m.allocations)) continue;
			let left = d.remaining_cents;
			const picks = [];
			let ok = true;
			for (const a of m.allocations) {
				const i = inv.get(String(a?.invoice));
				let cents;
				try {
					cents = decimal(String(a?.amount ?? ""), 2, "amount");
				} catch {
					ok = false;
					break;
				}
				if (!i || i.currency !== d.currency || cents <= 0n || cents > BigInt(i.balance_cents) || cents > left || picks.some((p) => p.inv === i)) {
					ok = false;
					break;
				}
				picks.push({ inv: i, cents });
				left -= cents;
			}
			if (ok && picks.length) out.push({ deposit: d, allocations: picks, confidence: ["high", "medium", "low"].includes(m.confidence) ? m.confidence : "low", source: "ai", reason: String(m.reason ?? "").slice(0, 500) });
		}
		return out;
	}

	/** Pending suggestions with the invoices they'd pay; optionally only those touching one customer. */
	async function listSuggestions(customerId = null) {
		const { rows } = await q(
			`SELECT id, entry_id, line_id, currency, deposit_date::text AS date, description, reference, deposit_cents, allocations,
			        confidence, source, reason, created_by, created_at
			   FROM ${T("payment_suggestions")} WHERE status = 'pending' ORDER BY deposit_date DESC, id DESC LIMIT 200`,
		);
		const ids = [...new Set(rows.flatMap((r) => r.allocations.map((a) => String(a.invoice_id))))];
		const invs = ids.length
			? (
					await q(
						`SELECT d.id, d.number, d.status, d.customer_id, d.total_cents - d.paid_cents AS balance_cents, c.name AS customer
						   FROM ${T("documents")} d JOIN ${T("customers")} c ON c.id = d.customer_id WHERE d.id = ANY($1::bigint[])`,
						[ids],
					)
				).rows
			: [];
		const byId = new Map(invs.map((i) => [String(i.id), i]));
		return rows
			.map((r) => ({
				...r,
				remaining_cents: r.deposit_cents,
				allocations: r.allocations.map((a) => {
					const i = byId.get(String(a.invoice_id));
					return {
						invoice_id: Number(a.invoice_id),
						amount_cents: a.amount_cents,
						number: i?.number ?? "?",
						customer: i?.customer ?? "",
						customer_id: i?.customer_id ?? null,
						status: i?.status ?? "gone",
						balance_cents: i?.balance_cents ?? 0,
					};
				}),
			}))
			.filter((r) => customerId === null || r.allocations.some((a) => String(a.customer_id) === String(customerId)));
	}

	// Looks for deposits that pay open invoices (rules, then Ledger's AI when an
	// admin allows it) and saves them as pending suggestions. Nothing is
	// applied: a person reviews each one.
	ctx.route("POST", "/payments/match", async (req) => {
		const o = body(req);
		const cid = o.customer_id === undefined || o.customer_id === null || o.customer_id === "" ? null : isId(o.customer_id) ? String(o.customer_id) : null;
		if (o.customer_id && cid === null) throw bad("customer_id is not valid");
		const days = o.days === undefined ? 90 : h.intIn(o.days, "days", 1, 366);
		const s = await loadSettings();
		if (!Object.values(s.accounts).some((a) => a.bank)) throw conflict("Set the bank account for payments under Settings → Sales first; deposits are looked for there.");
		const [deps, invoices, ai] = await Promise.all([deposits(s, days), openInvoices(cid), aiStatus()]);
		const rules = ruleMatches(deps, invoices);
		let aiUsed = false;
		let aiProblem = ai.problem;
		let fromAi = [];
		if (o.use_ai !== false && ai.available) {
			const taken = new Set(rules.map((r) => `${r.deposit.line_id}`));
			try {
				fromAi = await aiMatches(deps.filter((d) => !taken.has(`${d.line_id}`)), invoices);
				aiUsed = true;
			} catch (e) {
				aiProblem = `The AI couldn't be asked: ${e.message}`;
			}
		}
		// Replace the open suggestions for the deposits looked at with the new ones.
		const found = [...rules, ...fromAi];
		const looked = deps.map((d) => String(d.line_id));
		if (looked.length) await q(`DELETE FROM ${T("payment_suggestions")} WHERE status = 'pending' AND line_id = ANY($1::bigint[])`, [looked]);
		for (const m of found) {
			const d = m.deposit;
			await q(
				`INSERT INTO ${T("payment_suggestions")} (entry_id, line_id, currency, deposit_date, description, reference, deposit_cents, allocations, confidence, source, reason, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
				 ON CONFLICT DO NOTHING`,
				[
					String(d.entry_id),
					String(d.line_id),
					d.currency,
					d.date,
					d.description.slice(0, 1000),
					d.reference.slice(0, 200),
					d.remaining_cents.toString(),
					JSON.stringify(m.allocations.map((a) => ({ invoice_id: Number(a.inv.id), amount_cents: Number(a.cents) }))),
					m.confidence,
					m.source,
					m.reason.slice(0, 500),
					req.user.username,
				],
			);
		}
		return {
			deposits_checked: deps.length,
			open_invoices: invoices.length,
			found: found.length,
			ai: { available: ai.available, used: aiUsed, problem: aiProblem },
			suggestions: await listSuggestions(cid),
		};
	});

	ctx.route("GET", "/payments/suggestions", async (req) => {
		const cid = req.query.get("customer_id") || null;
		if (cid !== null && !isId(cid)) throw bad("customer_id is not valid");
		return { data: await listSuggestions(cid) };
	});

	/**
	 * What to post when a deposit already in the books pays an invoice. The
	 * deposit debited the bank and credited some account. If that was the
	 * receivable account, or the invoice was never posted, nothing more is
	 * needed; otherwise move the amount from that account to receivable.
	 */
	function postingFor(entry, lineId, invoice, s) {
		const line = entry.lines.find((l) => String(l.id) === String(lineId));
		const receivable = s.accounts?.[invoice.currency]?.receivable;
		if (invoice.journal_entry_id === null || !s.post_to_ledger) return "none";
		if (!receivable) throw bad(`Set the ${invoice.currency} receivable account under Settings → Sales first`);
		const credits = entry.lines.filter((l) => l.currency === line.currency && BigInt(l.credit_cents ?? 0) > 0n);
		if (credits.some((l) => l.account_code === receivable)) return "none";
		const accounts = [...new Set(credits.map((l) => l.account_code))];
		if (accounts.length !== 1) throw conflict("That deposit was split across several accounts; record the payment on the invoice by hand.");
		return { from: accounts[0], receivable };
	}

	/** Applies a deposit that's already in the books to open invoices; returns what's left of it. */
	async function applyDeposit(entryId, lineId, rawAllocations, method, user) {
		if (!isId(entryId) || !isId(lineId)) throw bad("entry_id and line_id are required");
		const s = await loadSettings();
		let entry;
		try {
			entry = await ctx.ledger.getJournalEntry(entryId);
		} catch {
			throw notFound("journal entry");
		}
		if (entry.reverses_id !== null || entry.reversed_by_id !== null) throw conflict("That entry was reversed; it can't pay an invoice.");
		const line = entry.lines.find((l) => String(l.id) === String(lineId));
		if (!line || BigInt(line.debit_cents ?? 0) <= 0n) throw bad("line_id must be the deposit (a debit) in that entry");
		const ours = await q(`SELECT 1 FROM ${T("payments")} WHERE journal_entry_id = $1 LIMIT 1`, [String(entry.id)]);
		if (ours.rowCount) throw conflict("That entry is a payment Sales already posted.");
		const used = await q(`SELECT coalesce(sum(amount_cents), 0)::bigint AS cents FROM ${T("payments")} WHERE matched_line_id = $1`, [String(line.id)]);
		const remaining = BigInt(line.debit_cents) - BigInt(used.rows[0].cents);

		const allocs = allocations(rawAllocations, await openInvoices(null));
		if (allocs[0].invoice.currency !== line.currency) throw bad(`the deposit is in ${line.currency}, the invoices in ${allocs[0].invoice.currency}`);
		const sum = allocs.reduce((t, a) => t + a.cents, 0n);
		if (sum > remaining) throw bad(`that's more than the ${formatMoney(remaining, line.currency)} of this deposit not yet applied`);

		const details = {
			date: entry.entry_date,
			method: method || "Bank deposit",
			reference: (entry.reference || `Entry #${entry.id}`).slice(0, 100),
			matched: { entry_id: entry.id, line_id: line.id },
		};
		const done = [];
		try {
			for (const a of allocs) {
				const p = postingFor(entry, line.id, a.invoice, s);
				const posting =
					p === "none"
						? "none"
						: {
								lines: [
									{ account_code: p.from, debit_cents: a.cents, memo: `Deposit (entry #${entry.id}) applied to invoice ${a.invoice.number}` },
									{ account_code: p.receivable, credit_cents: a.cents, memo: `Payment on invoice ${a.invoice.number}` },
								],
							};
				done.push({ did: a.invoice.id, pid: await docs.recordPayment(a.invoice.id, { ...details, amount: a.cents, posting }, user) });
			}
		} catch (e) {
			for (const d of done.reverse()) await docs.deletePayment(d.did, d.pid, user).catch((err) => ctx.log.error("could not undo a payment", { err: err.message }));
			throw e;
		}
		return { recorded: done.length, remaining_cents: remaining - sum };
	}

	// Applies a deposit the user picked to open invoices.
	ctx.route("POST", "/payments/apply", async (req) => {
		const o = body(req);
		return ctx.response(201, await applyDeposit(o.entry_id, o.line_id, o.allocations, text(o, "method", 50), req.user));
	});

	// A person approves a suggestion, as suggested or with changed amounts.
	ctx.route("POST", "/payments/suggestions/:id/apply", async (req) => {
		const sid = id(req, "id", "suggestion");
		const o = body(req);
		const { rows } = await q(`UPDATE ${T("payment_suggestions")} SET status = 'applying' WHERE id = $1 AND status = 'pending' RETURNING *`, [sid]);
		const sug = rows[0];
		if (!sug) {
			const { rowCount } = await q(`SELECT 1 FROM ${T("payment_suggestions")} WHERE id = $1`, [sid]);
			throw rowCount ? conflict("this suggestion was already applied or rejected") : notFound("suggestion");
		}
		try {
			const raw = o.allocations === undefined ? sug.allocations.map((a) => ({ invoice_id: a.invoice_id, amount: formatDecimal(a.amount_cents, 2, 2) })) : o.allocations;
			const r = await applyDeposit(sug.entry_id, sug.line_id, raw, text(o, "method", 50), req.user);
			await q(`UPDATE ${T("payment_suggestions")} SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [sid, req.user.username]);
			ctx.log.info("payment suggestion applied", { suggestion: sid, source: sug.source, user: req.user.username, edited: o.allocations !== undefined });
			return ctx.response(201, r);
		} catch (e) {
			await q(`UPDATE ${T("payment_suggestions")} SET status = 'pending' WHERE id = $1 AND status = 'applying'`, [sid]);
			throw e;
		}
	});

	// A person says a suggestion is wrong; that deposit isn't suggested again.
	ctx.route("POST", "/payments/suggestions/:id/reject", async (req) => {
		const sid = id(req, "id", "suggestion");
		const { rowCount } = await q(
			`UPDATE ${T("payment_suggestions")} SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending'`,
			[sid, req.user.username],
		);
		if (!rowCount) throw conflict("this suggestion was already applied or rejected, or doesn't exist");
	});
}
