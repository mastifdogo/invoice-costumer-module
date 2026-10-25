// The invoices module's page. Ledger serves it at /m/invoices/ inside a frame,
// with the same login, so API calls just work. Plain JavaScript, no build step.
"use strict";

const API = "/api/v1/m/invoices";

// ---- helpers -----------------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
	const r = await fetch(API + path, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (r.status === 204) return null;
	const data = await r.json().catch(() => ({}));
	if (!r.ok) {
		const e = data.error ?? {};
		const details = (e.details ?? []).map((d) => (d.field ? `${d.field}: ${d.message}` : d.message));
		throw new Error(details.length ? details.join("\n") : e.message || r.statusText);
	}
	return data;
}

/** h("div", {class: "x", onclick: fn}, "text", child, [more]) — text is always set as text, never HTML. */
function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "value") el.value = v;
		else if (k === "checked") el.checked = Boolean(v);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
	return el;
}

const view = () => document.getElementById("view");
function render(...nodes) {
	view().replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

let flashTimer;
function flash(msg, kind = "ok") {
	const el = document.getElementById("flash");
	clearTimeout(flashTimer);
	if (!msg) return void (el.hidden = true);
	el.textContent = msg;
	el.className = kind;
	el.hidden = false;
	if (kind === "ok") flashTimer = setTimeout(() => (el.hidden = true), 4000);
}
const fail = (e) => flash(e.message || String(e), "error");

/** Runs an async action with the button disabled; reports errors. */
async function busy(btn, fn) {
	if (btn) btn.disabled = true;
	try {
		await fn();
	} catch (e) {
		fail(e);
	} finally {
		if (btn) btn.disabled = false;
	}
}

function money(cents, currency) {
	const n = BigInt(cents ?? 0);
	const neg = n < 0n;
	const s = (neg ? -n : n).toString().padStart(3, "0");
	const int = s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${neg ? "-" : ""}$${int}.${s.slice(-2)}${currency ? " " + currency : ""}`;
}

/** Decimal text → bigint scaled by 10^scale, or null when it isn't a number. */
function parseDec(s, scale) {
	const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(s ?? "").trim().replaceAll(",", ""));
	if (!m || (m[2] === "" && !m[3]) || (m[3] ?? "").length > scale) return null;
	const n = BigInt((m[2] || "0") + (m[3] ?? "").padEnd(scale, "0"));
	return m[1] ? -n : n;
}
function divRound(a, b) {
	const q = a / b, r = a % b;
	return 2n * (r < 0n ? -r : r) >= b ? q + (a < 0n ? -1n : 1n) : q;
}
const fmtDec = (n, scale) => {
	const neg = BigInt(n) < 0n;
	const s = (neg ? -BigInt(n) : BigInt(n)).toString().padStart(scale + 1, "0");
	const frac = s.slice(-scale).replace(/0+$/, "");
	return (neg ? "-" : "") + s.slice(0, -scale) + (frac ? "." + frac : "");
};

function todayStr() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(date, days) {
	const d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + Number(days));
	return d.toISOString().slice(0, 10);
}
const when = (ts) => (ts ? new Date(ts).toLocaleString() : "");

function badge(inv) {
	const s = inv.status === "open" && inv.overdue ? "overdue" : inv.status === "posting" ? "draft" : inv.status;
	return h("span", { class: `badge ${s}` }, s);
}

/** Reads a form's named fields into an object (checkboxes as booleans). */
function formData(form) {
	const o = {};
	for (const el of form.elements) {
		if (!el.name) continue;
		o[el.name] = el.type === "checkbox" ? el.checked : el.value;
	}
	return o;
}

const field = (label, input, cls) => h("label", { class: cls }, h("span", {}, label), input);
const input = (name, value, attrs = {}) => h("input", { name, value: value ?? "", ...attrs });
const textarea = (name, value, attrs = {}) => {
	const t = h("textarea", { name, rows: 3, ...attrs });
	t.value = value ?? "";
	return t;
};
const select = (name, value, options, attrs = {}) =>
	h("select", { name, ...attrs }, options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value ?? "") }, label)));
const CURRENCY_OPTIONS = [["CAD", "CAD"], ["USD", "USD"]];

function openDialog(...content) {
	const d = document.getElementById("dialog");
	d.replaceChildren(...content);
	d.showModal();
	return d;
}
const closeDialog = () => document.getElementById("dialog").close();

/** Opens a file the server sent as base64 (the PDF). */
function saveBase64(filename, type, b64) {
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type }));
	const a = h("a", { href: url, download: filename });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---- routing ---------------------------------------------------------------------

const routes = [
	[/^\/?$/, () => invoiceList()],
	[/^\/invoices$/, () => invoiceList()],
	[/^\/invoices\/new$/, (_, qs) => invoiceForm(null, qs)],
	[/^\/invoices\/(\d+)$/, (m) => invoiceView(m[1])],
	[/^\/invoices\/(\d+)\/edit$/, (m) => invoiceForm(m[1])],
	[/^\/customers$/, () => customerList()],
	[/^\/customers\/new$/, () => customerForm(null)],
	[/^\/customers\/(\d+)$/, (m) => customerView(m[1])],
	[/^\/customers\/(\d+)\/edit$/, (m) => customerForm(m[1])],
	[/^\/settings$/, () => settingsView()],
];

async function route() {
	const [path, query] = location.hash.slice(1).split("?");
	const qs = new URLSearchParams(query ?? "");
	const tab = path.startsWith("/customers") ? "customers" : path.startsWith("/settings") ? "settings" : "invoices";
	for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("active", a.dataset.tab === tab);
	for (const [re, fn] of routes) {
		const m = re.exec(path);
		if (!m) continue;
		try {
			await fn(m, qs);
		} catch (e) {
			render(h("p", { class: "muted" }, "Couldn't load this page."));
			fail(e);
		}
		return;
	}
	render(h("h1", {}, "Not found"), h("p", {}, h("a", { href: "#/invoices" }, "Back to invoices")));
}
const go = (hash) => (location.hash === hash ? route() : (location.hash = hash));
window.addEventListener("hashchange", () => (flash(null), route()));

// ---- invoices ------------------------------------------------------------------------

let listState = { status: "", q: "" };

async function invoiceList() {
	const [summary, settings] = await Promise.all([api("/summary"), api("/settings")]);
	const cards = h("div", { class: "cards" });
	for (const c of summary.currencies) {
		cards.append(
			h("div", { class: "card" }, h("div", { class: "label" }, `Outstanding ${c.currency} (${c.open_count})`), h("div", { class: "value" }, money(c.outstanding_cents))),
			h("div", { class: "card" }, h("div", { class: "label" }, `Overdue ${c.currency} (${c.overdue_count})`), h("div", { class: "value", style: Number(c.overdue_cents) ? "color:var(--warn)" : "" }, money(c.overdue_cents))),
			h("div", { class: "card" }, h("div", { class: "label" }, `Received ${c.currency}, last 30 days`), h("div", { class: "value" }, money(c.paid_30d_cents))),
		);
	}

	const tbody = h("tbody");
	const load = async () => {
		const p = new URLSearchParams({ status: listState.status, q: listState.q });
		const { data } = await api(`/invoices?${p}`);
		tbody.replaceChildren(
			...(data.length
				? data.map((i) =>
						h(
							"tr",
							{ class: "click", onclick: () => go(`#/invoices/${i.id}`) },
							h("td", {}, h("a", { href: `#/invoices/${i.id}` }, i.number)),
							h("td", {}, i.customer_name, i.customer_company ? h("div", { class: "muted" }, i.customer_company) : null),
							h("td", {}, i.issue_date),
							h("td", {}, i.due_date),
							h("td", {}, badge(i), i.sent_at ? h("div", { class: "muted", title: when(i.sent_at) }, "emailed") : null),
							h("td", { class: "num" }, money(i.total_cents, i.currency)),
							h("td", { class: "num" }, i.status === "void" ? "—" : money(BigInt(i.total_cents) - BigInt(i.paid_cents))),
						),
					)
				: [h("tr", {}, h("td", { colspan: 7, class: "muted" }, listState.q || listState.status ? "No matching invoices." : "No invoices yet."))]),
		);
	};

	const seg = h("div", { class: "seg" });
	for (const [v, label] of [["", "All"], ["draft", "Drafts"], ["open", "Open"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]]) {
		const b = h("button", { class: listState.status === v ? "on" : "" }, label);
		b.onclick = () => {
			listState.status = v;
			for (const x of seg.children) x.classList.toggle("on", x === b);
			load().catch(fail);
		};
		seg.append(b);
	}
	let t;
	const search = input("q", listState.q, { type: "search", placeholder: "Search number, customer, PO" });
	search.oninput = () => {
		clearTimeout(t);
		t = setTimeout(() => ((listState.q = search.value.trim()), load().catch(fail)), 250);
	};

	const setupHints = [];
	if (!settings.business_name) setupHints.push(h("li", {}, h("a", { href: "#/settings" }, "Add your business details"), " so they appear on invoices."));
	if (!settings.email_ready) setupHints.push(h("li", {}, h("a", { href: "#/settings" }, "Connect an email account"), " to send invoices."));
	if (Number(summary.customers) === 0) setupHints.push(h("li", {}, h("a", { href: "#/customers/new" }, "Add your first customer"), "."));

	render(
		h("h1", {}, "Invoices", h("span", { class: "spacer" }), h("a", { class: "button primary", href: "#/invoices/new" }, "+ New invoice")),
		setupHints.length ? h("ul", { class: "muted" }, setupHints) : null,
		summary.currencies.length ? cards : null,
		h("div", { class: "filters" }, seg, search),
		h(
			"table",
			{},
			h("thead", {}, h("tr", {}, ["Number", "Customer", "Issued", "Due", "Status"].map((x) => h("th", {}, x)), h("th", { class: "right" }, "Total"), h("th", { class: "right" }, "Balance"))),
			tbody,
		),
	);
	await load();
}

async function invoiceForm(idOrNull, qs = new URLSearchParams()) {
	const [settings, customers, existing] = await Promise.all([
		api("/settings"),
		api("/customers"),
		idOrNull ? api(`/invoices/${idOrNull}`) : null,
	]);
	if (existing && existing.status !== "draft") return go(`#/invoices/${existing.id}`);
	if (customers.data.length === 0) {
		return render(h("h1", {}, "New invoice"), h("p", {}, "Add a customer first. ", h("a", { class: "button primary", href: "#/customers/new" }, "+ New customer")));
	}
	const byId = new Map(customers.data.map((c) => [String(c.id), c]));
	const defaultRate = fmtDec(settings.default_tax_rate, 3);
	const inv = existing ?? {
		customer_id: qs.get("customer") ?? "",
		issue_date: todayStr(),
		due_date: "",
		currency: "",
		po_number: "",
		notes: "",
		lines: [],
	};

	const form = h("form", { autocomplete: "off" });
	const customerSel = select("customer_id", inv.customer_id, [["", "Choose a customer…"], ...customers.data.map((c) => [c.id, c.company ? `${c.name} (${c.company})` : c.name])], { required: true });
	const issue = input("issue_date", inv.issue_date, { type: "date", required: true });
	const due = input("due_date", inv.due_date, { type: "date" });
	const cur = select("currency", inv.currency || byId.get(String(inv.customer_id))?.currency || settings.default_currency, CURRENCY_OPTIONS);
	let dueTouched = Boolean(existing);
	due.oninput = () => (dueTouched = true);
	const syncDue = () => {
		if (dueTouched || !issue.value) return;
		const c = byId.get(customerSel.value);
		due.value = addDays(issue.value, c?.terms_days ?? settings.default_terms_days);
	};
	customerSel.onchange = () => {
		const c = byId.get(customerSel.value);
		if (c && !existing) cur.value = c.currency;
		syncDue();
		recalc();
	};
	issue.oninput = syncDue;
	cur.onchange = () => recalc();
	syncDue();

	const linesBody = h("tbody");
	const totals = h("tbody");
	const addLine = (l = {}) => {
		const row = h(
			"tr",
			{},
			h("td", {}, textarea("description", l.description ?? "", { rows: 1, placeholder: "Description", required: true })),
			h("td", { class: "qty" }, input("quantity", l.quantity_text ?? "1", { inputmode: "decimal" })),
			h("td", { class: "price" }, input("unit_price", l.unit_price_cents !== undefined ? fmtDec(l.unit_price_cents, 2) : "", { inputmode: "decimal", placeholder: "0.00" })),
			h("td", { class: "tax" }, input("tax_rate", l.tax_rate_text ?? defaultRate, { inputmode: "decimal" })),
			h("td", { class: "amount num" }, ""),
			h("td", {}, h("button", { type: "button", class: "link", title: "Remove line", onclick: () => (row.remove(), recalc()) }, "✕")),
		);
		row.oninput = recalc;
		linesBody.append(row);
	};
	function readLines() {
		return [...linesBody.children].map((tr) => {
			const get = (n) => tr.querySelector(`[name="${n}"]`).value;
			return { description: get("description"), quantity: get("quantity"), unit_price: get("unit_price"), tax_rate: get("tax_rate") };
		});
	}
	function recalc() {
		let subtotal = 0n;
		const byRate = new Map();
		for (const [i, l] of readLines().entries()) {
			const q = parseDec(l.quantity, 3), p = parseDec(l.unit_price, 2), r = parseDec(l.tax_rate || "0", 3);
			const amount = q !== null && p !== null ? divRound(q * p, 1000n) : null;
			linesBody.children[i].querySelector(".amount").textContent = amount === null ? "—" : money(amount);
			if (amount === null || r === null) continue;
			subtotal += amount;
			byRate.set(r, (byRate.get(r) ?? 0n) + amount);
		}
		let tax = 0n;
		const rows = [h("tr", {}, h("td", {}, "Subtotal"), h("td", { class: "num" }, money(subtotal)))];
		for (const [r, base] of [...byRate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			if (r === 0n) continue;
			const t = divRound(base * r, 100000n);
			tax += t;
			rows.push(h("tr", {}, h("td", {}, `${settings.tax_label || "Tax"} ${fmtDec(r, 3)}%`), h("td", { class: "num" }, money(t))));
		}
		rows.push(h("tr", { class: "total" }, h("td", {}, "Total"), h("td", { class: "num" }, money(subtotal + tax, cur.value))));
		totals.replaceChildren(...rows);
	}
	(inv.lines.length ? inv.lines : [{}]).forEach(addLine);
	recalc();

	const save = async (btn, thenIssue) =>
		busy(btn, async () => {
			if (!form.reportValidity()) return;
			const body = { customer_id: customerSel.value, issue_date: issue.value, due_date: due.value, currency: cur.value, po_number: form.po_number.value, notes: form.notes.value, lines: readLines() };
			let saved = existing ? await api(`/invoices/${existing.id}`, { method: "PUT", body }) : await api("/invoices", { method: "POST", body });
			if (thenIssue) saved = await api(`/invoices/${saved.id}/issue`, { method: "POST" });
			go(`#/invoices/${saved.id}`);
			flash(thenIssue ? `Invoice ${saved.number} issued.` : `Draft ${saved.number} saved.`);
		});

	form.onsubmit = (e) => (e.preventDefault(), save(e.submitter, false));
	form.append(
		h(
			"div",
			{ class: "grid" },
			field("Customer", customerSel),
			field("Issue date", issue),
			field("Due date", due),
			field("Currency", cur),
			field("PO number", input("po_number", inv.po_number, { maxlength: 100 })),
		),
		h("h2", {}, "Lines"),
		h(
			"table",
			{ class: "lines" },
			h("thead", {}, h("tr", {}, h("th", {}, "Description"), h("th", {}, "Qty"), h("th", {}, "Unit price"), h("th", {}, "Tax %"), h("th", { class: "right" }, "Amount"), h("th"))),
			linesBody,
		),
		h("div", { class: "actions" }, h("button", { type: "button", onclick: () => (addLine(), recalc()) }, "+ Add line")),
		h("table", { class: "totals" }, totals),
		field("Notes (shown on the invoice)", textarea("notes", inv.notes, { rows: 3, maxlength: 5000 })),
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, "Save draft"),
			h("button", { type: "button", onclick: (e) => save(e.currentTarget, true) }, "Save & issue"),
			h("a", { class: "button", href: existing ? `#/invoices/${existing.id}` : "#/invoices" }, "Cancel"),
		),
	);
	render(h("h1", {}, existing ? `Edit ${existing.number}` : "New invoice"), form);
}

async function invoiceView(id) {
	const [inv, settings] = await Promise.all([api(`/invoices/${id}`), api("/settings")]);
	const reload = () => invoiceView(id).catch(fail);
	const act = (label, fn, attrs = {}) => h("button", { ...attrs, onclick: (e) => busy(e.currentTarget, fn) }, label);

	const actions = [];
	if (inv.status === "draft") {
		actions.push(h("a", { class: "button", href: `#/invoices/${id}/edit` }, "Edit"));
		actions.push(act("Issue", async () => (await api(`/invoices/${id}/issue`, { method: "POST" }), flash(`Invoice ${inv.number} issued.`), reload()), { class: "primary" }));
	}
	if (inv.status !== "void") actions.push(act(inv.status === "draft" ? "Issue & email" : inv.sent_at ? "Email again" : "Email", () => sendDialog(inv, settings, reload), { class: inv.status === "draft" ? "" : "primary" }));
	actions.push(act("Download PDF", async () => {
		const f = await api(`/invoices/${id}/pdf`);
		saveBase64(f.filename, f.content_type, f.content_base64);
	}));
	if (inv.status === "open") actions.push(act("Record payment", () => paymentDialog(inv, reload)));
	actions.push(h("span", { class: "spacer" }));
	actions.push(act("Duplicate", async () => {
		const copy = await api(`/invoices/${id}/duplicate`, { method: "POST" });
		go(`#/invoices/${copy.id}/edit`);
		flash(`Draft ${copy.number} created from ${inv.number}.`);
	}));
	if (inv.status === "open") {
		actions.push(act("Void", async () => {
			if (!confirm(`Void invoice ${inv.number}?${inv.journal_entry_id ? " Its entry in the books will be reversed." : ""}`)) return;
			await api(`/invoices/${id}/void`, { method: "POST", body: {} });
			flash(`Invoice ${inv.number} voided.`);
			reload();
		}, { class: "danger" }));
	}
	if (inv.status === "draft") {
		actions.push(act("Delete", async () => {
			if (!confirm(`Delete draft ${inv.number}?`)) return;
			await api(`/invoices/${id}`, { method: "DELETE" });
			flash(`Draft ${inv.number} deleted.`);
			go("#/invoices");
		}, { class: "danger" }));
	}

	const c = inv.customer;
	const ledgerLink = (entryId, label) => h("a", { href: `/journal/${entryId}`, target: "_top" }, label);
	const showTax = inv.lines.some((l) => Number(l.tax_rate) !== 0);
	const totalRows = [h("tr", {}, h("td", {}, "Subtotal"), h("td", { class: "num" }, money(inv.subtotal_cents)))];
	for (const t of inv.taxes) totalRows.push(h("tr", {}, h("td", {}, `${settings.tax_label || "Tax"} ${fmtDec(t.rate, 3)}%`), h("td", { class: "num" }, money(t.tax_cents))));
	totalRows.push(h("tr", { class: "total" }, h("td", {}, "Total"), h("td", { class: "num" }, money(inv.total_cents, inv.currency))));
	if (Number(inv.paid_cents)) totalRows.push(h("tr", {}, h("td", {}, "Paid"), h("td", { class: "num" }, "-" + money(inv.paid_cents))));
	if (inv.status !== "void") totalRows.push(h("tr", { class: "total" }, h("td", {}, "Balance due"), h("td", { class: "num" }, money(inv.balance_cents, inv.currency))));

	render(
		h("p", {}, h("a", { href: "#/invoices" }, "← Invoices")),
		h("h1", {}, `Invoice ${inv.number}`, badge(inv)),
		h("div", { class: "actions" }, actions),
		h(
			"div",
			{ class: "two" },
			h(
				"div",
				{},
				h("h2", {}, "Bill to"),
				h("div", {}, h("a", { href: `#/customers/${c.id}` }, h("strong", {}, c.name))),
				c.company ? h("div", {}, c.company) : null,
				c.address ? h("div", { class: "box muted" }, c.address) : null,
				c.email ? h("div", { class: "muted" }, c.email) : h("div", { class: "muted" }, "No email address on file."),
			),
			h(
				"div",
				{},
				h("h2", {}, "Details"),
				h(
					"table",
					{},
					h(
						"tbody",
						{},
						[
							["Issued", inv.issue_date],
							["Due", inv.due_date],
							["Currency", inv.currency],
							inv.po_number ? ["PO number", inv.po_number] : null,
							inv.sent_at ? ["Last emailed", when(inv.sent_at)] : null,
							inv.journal_entry_id ? ["In the books", ledgerLink(inv.journal_entry_id, `Journal entry #${inv.journal_entry_id}`)] : null,
							inv.void_entry_id ? ["Voided by", ledgerLink(inv.void_entry_id, `Journal entry #${inv.void_entry_id}`)] : null,
							["Created by", inv.created_by],
						]
							.filter(Boolean)
							.map(([k, v]) => h("tr", {}, h("td", { class: "muted" }, k), h("td", {}, v))),
					),
				),
			),
		),
		h("h2", {}, "Lines"),
		h(
			"table",
			{},
			h("thead", {}, h("tr", {}, h("th", {}, "Description"), h("th", { class: "right" }, "Qty"), h("th", { class: "right" }, "Unit price"), showTax ? h("th", { class: "right" }, "Tax") : null, h("th", { class: "right" }, "Amount"))),
			h(
				"tbody",
				{},
				inv.lines.map((l) =>
					h(
						"tr",
						{},
						h("td", { class: "box" }, l.description),
						h("td", { class: "num" }, l.quantity_text),
						h("td", { class: "num" }, money(l.unit_price_cents)),
						showTax ? h("td", { class: "num" }, Number(l.tax_rate) ? `${l.tax_rate_text}%` : "—") : null,
						h("td", { class: "num" }, money(l.amount_cents)),
					),
				),
			),
		),
		h("table", { class: "totals", style: "margin-top:0.75rem" }, h("tbody", {}, totalRows)),
		inv.notes ? [h("h2", {}, "Notes"), h("p", { class: "box" }, inv.notes)] : null,
		inv.payments.length
			? [
					h("h2", {}, "Payments"),
					h(
						"table",
						{},
						h("thead", {}, h("tr", {}, ["Date", "Method", "Reference", "Books"].map((x) => h("th", {}, x)), h("th", { class: "right" }, "Amount"), h("th"))),
						h(
							"tbody",
							{},
							inv.payments.map((p) =>
								h(
									"tr",
									{},
									h("td", {}, p.payment_date),
									h("td", {}, p.method),
									h("td", {}, p.reference),
									h("td", {}, p.journal_entry_id ? ledgerLink(p.journal_entry_id, `#${p.journal_entry_id}`) : h("span", { class: "muted" }, "not posted")),
									h("td", { class: "num" }, money(p.amount_cents, inv.currency)),
									h(
										"td",
										{ class: "right" },
										inv.status !== "void"
											? act("Remove", async () => {
													if (!confirm(`Remove the payment of ${money(p.amount_cents, inv.currency)}?${p.journal_entry_id ? " Its entry in the books will be reversed." : ""}`)) return;
													await api(`/invoices/${id}/payments/${p.id}`, { method: "DELETE" });
													flash("Payment removed.");
													reload();
												}, { class: "link" })
											: null,
									),
								),
							),
						),
					),
				]
			: null,
		inv.emails.length
			? [
					h("h2", {}, "Email history"),
					h(
						"table",
						{},
						h("thead", {}, h("tr", {}, ["When", "To", "Subject", "Result"].map((x) => h("th", {}, x)))),
						h(
							"tbody",
							{},
							inv.emails.map((m) =>
								h(
									"tr",
									{},
									h("td", {}, when(m.sent_at)),
									h("td", {}, m.recipients),
									h("td", {}, m.subject),
									h("td", { style: `color:var(${m.ok ? "--ok" : "--danger"})` }, m.ok ? `Sent by ${m.sent_by}` : m.error),
								),
							),
						),
					),
				]
			: null,
	);
}

async function sendDialog(inv, settings, done) {
	if (!settings.email_ready) {
		flash("Set up email first: Settings → Email.", "error");
		return;
	}
	const d = await api(`/invoices/${inv.id}/email`);
	const form = h(
		"form",
		{ method: "dialog" },
		h("h2", {}, inv.status === "draft" ? `Issue and email ${inv.number}` : `Email ${inv.number}`),
		field("To", input("to", d.to, { required: true, placeholder: "name@example.com" })),
		field("Cc", input("cc", d.cc)),
		field("Subject", input("subject", d.subject, { required: true, maxlength: 300 })),
		field("Message", textarea("message", d.message, { rows: 8 })),
		h("p", { class: "hint" }, `The invoice PDF is attached. Sent from ${settings.from_email}${settings.bcc_self ? ", with a copy to you" : ""}.`, inv.status === "draft" ? " Sending issues the draft first." : ""),
		h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Send"), h("button", { type: "button", onclick: closeDialog }, "Cancel")),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const r = await api(`/invoices/${inv.id}/send`, { method: "POST", body: formData(form) });
			closeDialog();
			flash(`Invoice ${r.number} sent to ${form.to.value}.`);
			done();
		});
	};
	openDialog(form);
}

function paymentDialog(inv, done) {
	const form = h(
		"form",
		{ method: "dialog" },
		h("h2", {}, `Record a payment on ${inv.number}`),
		h(
			"div",
			{ class: "grid" },
			field("Date", input("payment_date", todayStr(), { type: "date", required: true })),
			field(`Amount (${inv.currency})`, input("amount", fmtDec(inv.balance_cents, 2), { inputmode: "decimal", required: true })),
			field("Method", input("method", "", { list: "methods", placeholder: "e.g. e-Transfer", maxlength: 50 })),
			field("Reference", input("reference", "", { maxlength: 100 })),
		),
		h("datalist", { id: "methods" }, ["e-Transfer", "Cheque", "Cash", "Credit card", "Wire", "ACH", "PayPal"].map((m) => h("option", { value: m }))),
		h("p", { class: "hint" }, `Balance due: ${money(inv.balance_cents, inv.currency)}.`, inv.journal_entry_id ? " This posts the payment to the books (bank / receivable)." : ""),
		h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Record payment"), h("button", { type: "button", onclick: closeDialog }, "Cancel")),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const r = await api(`/invoices/${inv.id}/payments`, { method: "POST", body: formData(form) });
			closeDialog();
			flash(r.status === "paid" ? `Invoice ${r.number} is paid in full.` : "Payment recorded.");
			done();
		});
	};
	openDialog(form);
}

// ---- customers -------------------------------------------------------------------------------

const outstandingText = (list) => (list?.length ? list.map((o) => money(o.cents, o.currency)).join(", ") : "—");

async function customerList() {
	const tbody = h("tbody");
	let showArchived = false;
	let q = "";
	const load = async () => {
		const { data } = await api(`/customers?${new URLSearchParams({ q, archived: showArchived ? "1" : "" })}`);
		tbody.replaceChildren(
			...(data.length
				? data.map((c) =>
						h(
							"tr",
							{ class: "click", onclick: () => go(`#/customers/${c.id}`) },
							h("td", {}, h("a", { href: `#/customers/${c.id}` }, c.name), c.archived ? h("span", { class: "muted" }, " (archived)") : null),
							h("td", {}, c.company),
							h("td", {}, c.email),
							h("td", {}, c.phone),
							h("td", { class: "num" }, String(c.invoice_count)),
							h("td", { class: "num" }, outstandingText(c.outstanding)),
						),
					)
				: [h("tr", {}, h("td", { colspan: 6, class: "muted" }, q ? "No matching customers." : "No customers yet."))]),
		);
	};
	let t;
	const search = input("q", "", { type: "search", placeholder: "Search name, company, email" });
	search.oninput = () => {
		clearTimeout(t);
		t = setTimeout(() => ((q = search.value.trim()), load().catch(fail)), 250);
	};
	const arch = h("input", { type: "checkbox", onchange: (e) => ((showArchived = e.target.checked), load().catch(fail)) });
	render(
		h("h1", {}, "Customers", h("span", { class: "spacer" }), h("a", { class: "button primary", href: "#/customers/new" }, "+ New customer")),
		h("div", { class: "filters" }, search, h("label", { class: "check" }, arch, h("span", {}, "Show archived"))),
		h(
			"table",
			{},
			h("thead", {}, h("tr", {}, ["Name", "Company", "Email", "Phone"].map((x) => h("th", {}, x)), h("th", { class: "right" }, "Invoices"), h("th", { class: "right" }, "Outstanding"))),
			tbody,
		),
	);
	await load();
}

async function customerForm(idOrNull) {
	const [settings, c] = await Promise.all([api("/settings"), idOrNull ? api(`/customers/${idOrNull}`) : null]);
	const cust = c ?? { currency: settings.default_currency };
	const form = h(
		"form",
		{ autocomplete: "off" },
		h(
			"div",
			{ class: "grid" },
			field("Name", input("name", cust.name, { required: true, maxlength: 200 })),
			field("Company", input("company", cust.company, { maxlength: 200 })),
			field("Email (invoices go here)", input("email", cust.email, { type: "email", maxlength: 254 })),
			field("Cc emails", input("cc_emails", cust.cc_emails, { placeholder: "comma-separated", maxlength: 1000 })),
			field("Phone", input("phone", cust.phone, { maxlength: 50 })),
			field("Tax number", input("tax_id", cust.tax_id, { maxlength: 50 })),
			field("Currency", select("currency", cust.currency, CURRENCY_OPTIONS)),
			field("Payment terms (days)", input("terms_days", cust.terms_days ?? "", { type: "number", min: 0, max: 365, placeholder: `default (${settings.default_terms_days})` })),
			field("Billing address", textarea("address", cust.address, { rows: 4, maxlength: 1000 }), "wide"),
			field("Private notes", textarea("notes", cust.notes, { rows: 3, maxlength: 5000 }), "wide"),
			c ? h("label", { class: "check wide" }, h("input", { type: "checkbox", name: "archived", checked: c.archived }), h("span", {}, "Archived (hidden from lists and new invoices)")) : null,
		),
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, c ? "Save" : "Add customer"),
			h("a", { class: "button", href: c ? `#/customers/${c.id}` : "#/customers" }, "Cancel"),
			h("span", { class: "spacer" }),
			c && Number(c.invoices?.length ?? 0) === 0
				? h("button", {
						type: "button",
						class: "danger",
						onclick: (e) =>
							busy(e.currentTarget, async () => {
								if (!confirm(`Delete customer ${c.name}?`)) return;
								await api(`/customers/${c.id}`, { method: "DELETE" });
								flash(`Deleted ${c.name}.`);
								go("#/customers");
							}),
					}, "Delete")
				: null,
		),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const body = formData(form);
			const saved = c ? await api(`/customers/${c.id}`, { method: "PUT", body }) : await api("/customers", { method: "POST", body });
			flash(c ? "Customer saved." : `Added ${saved.name}.`);
			go(`#/customers/${saved.id}`);
		});
	};
	render(h("h1", {}, c ? `Edit ${c.name}` : "New customer"), form);
}

async function customerView(id) {
	const c = await api(`/customers/${id}`);
	const info = [
		["Company", c.company],
		["Email", c.email],
		["Cc", c.cc_emails],
		["Phone", c.phone],
		["Tax number", c.tax_id],
		["Currency", c.currency],
		["Terms", c.terms_days !== null ? `${c.terms_days} days` : "default"],
		["Outstanding", outstandingText(c.outstanding)],
	].filter(([, v]) => v);
	render(
		h("p", {}, h("a", { href: "#/customers" }, "← Customers")),
		h("h1", {}, c.name, c.archived ? h("span", { class: "badge void" }, "archived") : null),
		h(
			"div",
			{ class: "actions" },
			h("a", { class: "button primary", href: `#/invoices/new?customer=${c.id}` }, "+ New invoice"),
			h("a", { class: "button", href: `#/customers/${c.id}/edit` }, "Edit"),
		),
		h(
			"div",
			{ class: "two" },
			h("table", {}, h("tbody", {}, info.map(([k, v]) => h("tr", {}, h("td", { class: "muted" }, k), h("td", {}, v))))),
			h("div", {}, c.address ? [h("div", { class: "muted" }, "Billing address"), h("div", { class: "box" }, c.address)] : null, c.notes ? [h("div", { class: "muted", style: "margin-top:0.75rem" }, "Notes"), h("div", { class: "box" }, c.notes)] : null),
		),
		h("h2", {}, "Invoices"),
		c.invoices.length
			? h(
					"table",
					{},
					h("thead", {}, h("tr", {}, ["Number", "Issued", "Due", "Status"].map((x) => h("th", {}, x)), h("th", { class: "right" }, "Total"), h("th", { class: "right" }, "Balance"))),
					h(
						"tbody",
						{},
						c.invoices.map((i) =>
							h(
								"tr",
								{ class: "click", onclick: () => go(`#/invoices/${i.id}`) },
								h("td", {}, h("a", { href: `#/invoices/${i.id}` }, i.number)),
								h("td", {}, i.issue_date),
								h("td", {}, i.due_date),
								h("td", {}, badge(i)),
								h("td", { class: "num" }, money(i.total_cents, i.currency)),
								h("td", { class: "num" }, i.status === "void" ? "—" : money(BigInt(i.total_cents) - BigInt(i.paid_cents))),
							),
						),
					),
				)
			: h("p", { class: "muted" }, "No invoices yet."),
	);
}

// ---- settings ----------------------------------------------------------------------------------

const SMTP_PRESETS = {
	gmail: { smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_security: "tls", note: "Gmail / Google Workspace: turn on 2-Step Verification, then create an App Password (Google Account → Security → App passwords) and use it as the password. Username is your full address." },
	outlook: { smtp_host: "smtp.office365.com", smtp_port: 587, smtp_security: "starttls", note: "Microsoft 365 / Outlook.com: SMTP AUTH must be enabled for the mailbox. Accounts with 2-step verification need an app password." },
	fastmail: { smtp_host: "smtp.fastmail.com", smtp_port: 465, smtp_security: "tls", note: "Fastmail: create an app password under Settings → Privacy & Security → Integrations." },
	icloud: { smtp_host: "smtp.mail.me.com", smtp_port: 587, smtp_security: "starttls", note: "iCloud Mail: use an app-specific password from appleid.apple.com. Username is your iCloud address." },
	zoho: { smtp_host: "smtp.zoho.com", smtp_port: 465, smtp_security: "tls", note: "Zoho Mail: use an app-specific password if 2FA is on." },
	local: { smtp_host: "localhost", smtp_port: 25, smtp_security: "none", note: "A relay on this container or your network (e.g. Postfix). Leave username and password empty if it doesn't need them." },
};

async function settingsView() {
	const [s, accounts] = await Promise.all([api("/settings"), api("/accounts").catch(() => ({ data: [] }))]);
	const acctOptions = (cur, types) => [
		["", "— none —"],
		...accounts.data.filter((a) => a.currency === cur && types.includes(a.type)).map((a) => [a.code, `${a.code} ${a.name}`]),
	];
	const roleTypes = { receivable: ["asset"], revenue: ["revenue", "income"], tax: ["liability"], bank: ["asset"] };
	const roleLabels = { receivable: "Accounts receivable", revenue: "Revenue", tax: "Sales tax payable", bank: "Bank (payments go to)" };
	const acctFields = ["CAD", "USD"].map((cur) =>
		h(
			"div",
			{},
			h("strong", {}, cur),
			h(
				"div",
				{ class: "grid", style: "margin-top:0.4rem" },
				Object.keys(roleLabels).map((role) => {
					let opts = acctOptions(cur, roleTypes[role]);
					if (opts.length <= 1) opts = [["", "— none —"], ...accounts.data.filter((a) => a.currency === cur).map((a) => [a.code, `${a.code} ${a.name}`])];
					const current = s.accounts?.[cur]?.[role] ?? "";
					if (current && !opts.some(([v]) => v === current)) opts.push([current, current]);
					return field(roleLabels[role], select(`acct.${cur}.${role}`, current, opts));
				}),
			),
		),
	);

	const note = h("p", { class: "hint" });
	const preset = select("preset", "", [["", "Fill in for a provider…"], ["gmail", "Gmail / Google Workspace"], ["outlook", "Microsoft 365 / Outlook"], ["fastmail", "Fastmail"], ["icloud", "iCloud Mail"], ["zoho", "Zoho Mail"], ["local", "Local relay (no login)"]]);

	const form = h(
		"form",
		{ autocomplete: "off" },
		h(
			"fieldset",
			{},
			h("legend", {}, "Your business (shown on invoices)"),
			h(
				"div",
				{ class: "grid" },
				field("Business name", input("business_name", s.business_name, { maxlength: 200 })),
				field("Email", input("business_email", s.business_email, { type: "email" })),
				field("Phone", input("business_phone", s.business_phone, { maxlength: 50 })),
				field("Tax number (e.g. GST/HST)", input("tax_id", s.tax_id, { maxlength: 50 })),
				field("Address", textarea("business_address", s.business_address, { rows: 3 }), "wide"),
				field("Footer (payment instructions, thanks…)", textarea("footer", s.footer, { rows: 3 }), "wide"),
			),
		),
		h(
			"fieldset",
			{},
			h("legend", {}, "Invoices"),
			h(
				"div",
				{ class: "grid" },
				field("Number prefix", input("invoice_prefix", s.invoice_prefix, { maxlength: 20 })),
				field("Next number", input("next_number", s.next_number, { type: "number", min: 1 })),
				field("Default currency", select("default_currency", s.default_currency, CURRENCY_OPTIONS)),
				field("Default payment terms (days)", input("default_terms_days", s.default_terms_days, { type: "number", min: 0, max: 365 })),
				field("Default tax rate (%)", input("default_tax_rate", fmtDec(s.default_tax_rate, 3), { inputmode: "decimal" })),
				field("Tax name", input("tax_label", s.tax_label, { maxlength: 30, placeholder: "e.g. GST, HST, Sales tax" })),
			),
			h("p", { class: "hint" }, `The next invoice will be ${s.invoice_prefix}${String(s.next_number).padStart(4, "0")}.`),
		),
		h(
			"fieldset",
			{},
			h("legend", {}, "Ledger posting"),
			h("label", { class: "check" }, h("input", { type: "checkbox", name: "post_to_ledger", checked: s.post_to_ledger }), h("span", {}, "Post invoices and payments to the books")),
			h("p", { class: "hint" }, "Issuing an invoice posts Dr receivable / Cr revenue and tax. A payment posts Dr bank / Cr receivable. Voiding reverses the invoice's entry. Set accounts for each currency you invoice in (create them under Accounts in Ledger first)."),
			accounts.data.length ? acctFields : h("p", { class: "muted" }, "No accounts in Ledger yet."),
		),
		h(
			"fieldset",
			{},
			h("legend", {}, "Email (SMTP)"),
			h("div", { class: "grid" }, field("Provider", preset)),
			note,
			h(
				"div",
				{ class: "grid", style: "margin-top:0.5rem" },
				field("SMTP server", input("smtp_host", s.smtp_host, { placeholder: "smtp.example.com" })),
				field("Port", input("smtp_port", s.smtp_port, { type: "number", min: 1, max: 65535 })),
				field("Security", select("smtp_security", s.smtp_security, [["tls", "TLS (usually port 465)"], ["starttls", "STARTTLS (usually port 587)"], ["none", "None (local relay only)"]])),
				field("Username", input("smtp_username", s.smtp_username, { autocomplete: "off" })),
				field("Password", input("smtp_password", "", { type: "password", autocomplete: "new-password", placeholder: s.smtp_password_set ? "saved — leave empty to keep" : "" })),
				field("Send from (address)", input("from_email", s.from_email, { type: "email", placeholder: "billing@example.com" })),
				field("Sender name", input("from_name", s.from_name, { placeholder: s.business_name })),
				field("Reply-to (optional)", input("reply_to", s.reply_to, { type: "email" })),
				h("label", { class: "check" }, h("input", { type: "checkbox", name: "bcc_self", checked: s.bcc_self }), h("span", {}, "Send me a copy (Bcc)")),
			),
			h("h2", {}, "Invoice email"),
			h(
				"div",
				{ class: "grid" },
				field("Subject", input("email_subject", s.email_subject, { maxlength: 300 }), "wide"),
				field("Message", textarea("email_body", s.email_body, { rows: 7 }), "wide"),
			),
			h("p", { class: "hint" }, "Placeholders: {{number}} {{customer}} {{company}} {{total}} {{balance}} {{issue_date}} {{due_date}} {{business}}"),
		),
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, "Save settings"),
			h("button", { type: "button", onclick: (e) => busy(e.currentTarget, testEmail) }, "Send a test email"),
			s.smtp_password_set ? h("button", { type: "button", class: "link", onclick: (e) => busy(e.currentTarget, clearPassword) }, "Forget saved password") : null,
		),
	);
	preset.onchange = () => {
		const p = SMTP_PRESETS[preset.value];
		note.textContent = p?.note ?? "";
		if (!p) return;
		form.smtp_host.value = p.smtp_host;
		form.smtp_port.value = p.smtp_port;
		form.smtp_security.value = p.smtp_security;
	};

	function collect() {
		const o = formData(form);
		const out = { accounts: { CAD: {}, USD: {} } };
		for (const [k, v] of Object.entries(o)) {
			if (k === "preset") continue;
			if (k.startsWith("acct.")) {
				const [, cur, role] = k.split(".");
				out.accounts[cur][role] = v;
			} else out[k] = v;
		}
		if (!accounts.data.length) delete out.accounts;
		if (out.smtp_password === "") delete out.smtp_password; // keep the saved one
		return out;
	}
	async function saveAll() {
		await api("/settings", { method: "PUT", body: collect() });
	}
	async function testEmail() {
		await saveAll();
		const to = prompt("Send a test email to:", form.from_email.value || form.business_email.value);
		if (!to) return;
		const r = await api("/settings/test-email", { method: "POST", body: { to } });
		flash(`Test email sent to ${r.to.join(", ")}. Server said: ${r.server_reply}`);
	}
	async function clearPassword() {
		if (!confirm("Forget the saved SMTP password?")) return;
		await api("/settings", { method: "PUT", body: { smtp_password: "" } });
		flash("Saved password removed.");
		settingsView().catch(fail);
	}
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			await saveAll();
			flash("Settings saved.");
			settingsView().catch(fail);
		});
	};
	render(h("h1", {}, "Settings"), form);
}

route();
