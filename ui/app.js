// The Sales module's page. Ledger serves it at /m/sales/ inside a frame, with
// the same login, so API calls just work. Plain JavaScript, no build step.
"use strict";

const API = "/api/v1/m/sales";

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
let flashedAt = 0;
function flash(msg, kind = "ok") {
	const el = document.getElementById("flash");
	clearTimeout(flashTimer);
	flashedAt = msg ? Date.now() : 0;
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
const pct = (rate) => `${fmtDec(rate, 3)}%`;

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

function badge(doc) {
	let s = doc.status;
	if (doc.overdue) s = "overdue";
	else if (doc.expired) s = "expired";
	else if (s === "posting") s = "draft";
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
const table = (heads, rows, attrs = {}) =>
	h("table", attrs, h("thead", {}, h("tr", {}, heads.map((x) => (Array.isArray(x) ? h("th", { class: x[1] }, x[0]) : h("th", {}, x))))), h("tbody", {}, rows));

function openDialog(...content) {
	const d = document.getElementById("dialog");
	d.replaceChildren(...content.flat());
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

/**
 * Toggle buttons for choosing taxes. `taxes` are the tax records; inactive
 * ones show only when already selected. get() returns the selected ids.
 */
function taxPicker(taxes, selected, onchange) {
	let chosen = new Set((selected ?? []).map(String));
	const el = h("span", { class: "chips" });
	const draw = () => {
		el.replaceChildren(
			...taxes
				.filter((t) => t.active || chosen.has(String(t.id)))
				.map((t) =>
					h(
						"button",
						{
							type: "button",
							class: chosen.has(String(t.id)) ? "chip on" : "chip",
							title: `${t.name} ${pct(t.rate)}`,
							"aria-pressed": chosen.has(String(t.id)) ? "true" : "false",
							onclick: () => {
								const k = String(t.id);
								chosen.has(k) ? chosen.delete(k) : chosen.add(k);
								draw();
								onchange?.();
							},
						},
						t.name,
					),
				),
		);
		if (!el.children.length) el.append(h("span", { class: "muted" }, "no taxes set up"));
	};
	draw();
	return {
		el,
		get: () => [...chosen],
		set(ids) {
			chosen = new Set((ids ?? []).map(String));
			draw();
		},
	};
}

// ---- document kinds ------------------------------------------------------------

const KINDS = {
	invoice: {
		label: "Invoice", plural: "invoices", title: "Invoices", date: "Issue date", due: "Due date",
		filters: [["", "All"], ["draft", "Drafts"], ["open", "Open"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]],
	},
	quote: {
		label: "Quote", plural: "quotes", title: "Quotes", date: "Date", due: "Valid until",
		filters: [["", "All"], ["pending", "Pending"], ["draft", "Drafts"], ["sent", "Sent"], ["accepted", "Accepted"], ["declined", "Declined"], ["expired", "Expired"], ["converted", "Invoiced"]],
	},
	estimate: {
		label: "Estimate", plural: "estimates", title: "Estimates", date: "Date", due: "Valid until",
		filters: [["", "All"], ["pending", "Pending"], ["draft", "Drafts"], ["sent", "Sent"], ["accepted", "Accepted"], ["declined", "Declined"], ["expired", "Expired"], ["converted", "Invoiced"]],
	},
};
const kindByPlural = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.plural, k]));
const docHref = (d) => `#/${KINDS[d.kind].plural}/${d.id}`;

// ---- routing ---------------------------------------------------------------------

const routes = [
	[/^\/?$/, () => docList("invoice")],
	[/^\/(invoices|quotes|estimates)$/, (m) => docList(kindByPlural[m[1]])],
	[/^\/(invoices|quotes|estimates)\/new$/, (m, qs) => docForm(kindByPlural[m[1]], null, qs)],
	[/^\/(invoices|quotes|estimates)\/(\d+)$/, (m) => docView(kindByPlural[m[1]], m[2])],
	[/^\/(invoices|quotes|estimates)\/(\d+)\/edit$/, (m) => docForm(kindByPlural[m[1]], m[2])],
	[/^\/customers$/, () => customerList()],
	[/^\/customers\/new$/, () => customerForm(null)],
	[/^\/customers\/(\d+)$/, (m) => customerView(m[1])],
	[/^\/customers\/(\d+)\/edit$/, (m) => customerForm(m[1])],
	[/^\/categories$/, () => categoryList()],
	[/^\/settings$/, () => settingsView()],
];

async function route() {
	const [path, query] = location.hash.slice(1).split("?");
	const qs = new URLSearchParams(query ?? "");
	const tab = (path.split("/")[1] || "invoices").toLowerCase();
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
// A message shown just before navigating (e.g. "Invoice saved") stays; older ones go.
window.addEventListener("hashchange", () => {
	if (Date.now() - flashedAt > 1000) flash(null);
	route();
});

// ---- document lists ----------------------------------------------------------------

const listState = {};

async function docList(kind) {
	const K = KINDS[kind];
	const state = (listState[kind] ??= { status: "", q: "" });
	const isInvoice = kind === "invoice";
	const [summary, settings] = await Promise.all([isInvoice ? api("/summary") : null, api("/settings")]);

	const tbody = h("tbody");
	const load = async () => {
		const { data } = await api(`/${K.plural}?${new URLSearchParams({ status: state.status, q: state.q })}`);
		tbody.replaceChildren(
			...(data.length
				? data.map((d) =>
						h(
							"tr",
							{ class: "click", onclick: () => go(docHref(d)) },
							h("td", {}, h("a", { href: docHref(d) }, d.number)),
							h("td", {}, d.customer_name, d.customer_company ? h("div", { class: "muted" }, d.customer_company) : null),
							h("td", {}, d.issue_date),
							h("td", {}, d.due_date),
							h("td", {}, badge(d), d.sent_at ? h("div", { class: "muted", title: when(d.sent_at) }, "emailed") : null),
							h("td", { class: "num" }, money(d.total_cents, d.currency)),
							isInvoice ? h("td", { class: "num" }, d.status === "void" ? "—" : money(BigInt(d.total_cents) - BigInt(d.paid_cents))) : null,
						),
					)
				: [h("tr", {}, h("td", { colspan: 7, class: "muted" }, state.q || state.status ? `No matching ${K.plural}.` : `No ${K.plural} yet.`))]),
		);
	};

	const seg = h("div", { class: "seg" });
	for (const [v, label] of K.filters) {
		const b = h("button", { class: state.status === v ? "on" : "" }, label);
		b.onclick = () => {
			state.status = v;
			for (const x of seg.children) x.classList.toggle("on", x === b);
			load().catch(fail);
		};
		seg.append(b);
	}
	let t;
	const search = input("q", state.q, { type: "search", placeholder: "Search number, customer, PO" });
	search.oninput = () => {
		clearTimeout(t);
		t = setTimeout(() => ((state.q = search.value.trim()), load().catch(fail)), 250);
	};

	const cards = [];
	for (const c of summary?.currencies ?? []) {
		cards.push(
			h("div", { class: "card" }, h("div", { class: "label" }, `Outstanding ${c.currency} (${c.open_count})`), h("div", { class: "value" }, money(c.outstanding_cents))),
			h("div", { class: "card" }, h("div", { class: "label" }, `Overdue ${c.currency} (${c.overdue_count})`), h("div", { class: "value", style: Number(c.overdue_cents) ? "color:var(--warn)" : "" }, money(c.overdue_cents))),
			h("div", { class: "card" }, h("div", { class: "label" }, `Received ${c.currency}, last 30 days`), h("div", { class: "value" }, money(c.paid_30d_cents))),
		);
	}
	const hints = [];
	if (isInvoice) {
		if (!settings.business_name) hints.push(h("li", {}, h("a", { href: "#/settings" }, "Add your business details"), " (and GST number) so they appear on invoices."));
		if (!settings.email_ready) hints.push(h("li", {}, h("a", { href: "#/settings" }, "Connect an email account"), " to send invoices, quotes and estimates."));
		if (Number(summary.customers) === 0) hints.push(h("li", {}, h("a", { href: "#/customers/new" }, "Add your first customer"), "."));
	}

	render(
		h("h1", {}, K.title, h("span", { class: "spacer" }), h("a", { class: "button primary", href: `#/${K.plural}/new` }, `+ New ${K.label.toLowerCase()}`)),
		hints.length ? h("ul", { class: "muted" }, hints) : null,
		cards.length ? h("div", { class: "cards" }, cards) : null,
		h("div", { class: "filters" }, seg, search),
		h(
			"table",
			{},
			h(
				"thead",
				{},
				h("tr", {}, ["Number", "Customer", K.date, K.due, "Status"].map((x) => h("th", {}, x)), h("th", { class: "right" }, "Total"), isInvoice ? h("th", { class: "right" }, "Balance") : null),
			),
			tbody,
		),
	);
	await load();
}

// ---- document editor --------------------------------------------------------------

async function docForm(kind, idOrNull, qs = new URLSearchParams()) {
	const K = KINDS[kind];
	const [settings, customers, taxes, cats, existing] = await Promise.all([
		api("/settings"),
		api("/customers"),
		api("/taxes"),
		api("/categories"),
		idOrNull ? api(`/${K.plural}/${idOrNull}`) : null,
	]);
	const editable = kind === "invoice" ? ["draft"] : ["draft", "sent"];
	if (existing && !editable.includes(existing.status)) return go(docHref(existing));
	if (customers.data.length === 0) {
		return render(h("h1", {}, `New ${K.label.toLowerCase()}`), h("p", {}, "Add a customer first. ", h("a", { class: "button primary", href: "#/customers/new" }, "+ New customer")));
	}
	const custById = new Map(customers.data.map((c) => [String(c.id), c]));
	const catById = new Map(cats.data.map((c) => [String(c.id), c]));
	const doc = existing ?? { customer_id: qs.get("customer") ?? "", issue_date: todayStr(), due_date: "", currency: "", po_number: "", notes: "", lines: [] };

	const form = h("form", { autocomplete: "off" });
	const customerSel = select("customer_id", doc.customer_id, [["", "Choose a customer…"], ...customers.data.map((c) => [c.id, c.company ? `${c.name} (${c.company})` : c.name])], { required: true });
	const issue = input("issue_date", doc.issue_date, { type: "date", required: true });
	const due = input("due_date", doc.due_date, { type: "date" });
	const cur = select("currency", doc.currency || custById.get(String(doc.customer_id))?.currency || settings.default_currency, CURRENCY_OPTIONS);
	let dueTouched = Boolean(existing);
	due.oninput = () => (dueTouched = true);
	const days = () => {
		const c = custById.get(customerSel.value);
		return kind === "invoice" ? (c?.terms_days ?? settings.default_terms_days) : settings[`${kind}_valid_days`];
	};
	const syncDue = () => {
		if (!dueTouched && issue.value) due.value = addDays(issue.value, days());
	};
	/** Taxes a line gets by default: its category's, else the customer's, else the defaults. */
	const defaultTaxes = (catId) => {
		const cat = catById.get(String(catId ?? ""));
		const c = custById.get(customerSel.value);
		return cat?.tax_ids ?? c?.tax_ids ?? settings.default_tax_ids;
	};
	customerSel.onchange = () => {
		const c = custById.get(customerSel.value);
		if (c && !existing) cur.value = c.currency;
		syncDue();
		for (const row of linesBody.children) if (!row._touched) row._taxes.set(defaultTaxes(row.querySelector("[name=category_id]").value));
		recalc();
	};
	issue.oninput = syncDue;
	cur.onchange = () => recalc();
	syncDue();

	const catOptions = (selected) => [["", "— none —"], ...cats.data.filter((c) => c.active || String(c.id) === String(selected ?? "")).map((c) => [c.id, c.name])];
	const linesBody = h("tbody");
	const totals = h("tbody");
	const addLine = (l = {}) => {
		const catSel = select("category_id", l.category_id ?? "", catOptions(l.category_id));
		const picker = taxPicker(taxes.data, l.tax_ids ?? defaultTaxes(l.category_id), () => ((row._touched = true), recalc()));
		const row = h(
			"tr",
			{},
			h("td", { class: "cat" }, catSel),
			h("td", {}, textarea("description", l.description ?? "", { rows: 1, placeholder: "Description", required: true })),
			h("td", { class: "qty" }, input("quantity", l.quantity_text ?? "1", { inputmode: "decimal" })),
			h("td", { class: "price" }, input("unit_price", l.unit_price_cents !== undefined ? fmtDec(l.unit_price_cents, 2) : "", { inputmode: "decimal", placeholder: "0.00" })),
			h("td", { class: "tax" }, picker.el),
			h("td", { class: "amount num" }, ""),
			h("td", {}, h("button", { type: "button", class: "link", title: "Remove line", onclick: () => (row.remove(), recalc()) }, "✕")),
		);
		row._taxes = picker;
		row._touched = Boolean(existing && l.description !== undefined);
		catSel.onchange = () => {
			if (!row._touched || catById.get(catSel.value)?.tax_ids) picker.set(defaultTaxes(catSel.value));
			recalc();
		};
		row.oninput = recalc;
		linesBody.append(row);
	};
	function readLines() {
		return [...linesBody.children].map((tr) => {
			const get = (n) => tr.querySelector(`[name="${n}"]`).value;
			return { category_id: get("category_id") || null, description: get("description"), quantity: get("quantity"), unit_price: get("unit_price"), tax_ids: tr._taxes.get() };
		});
	}
	function recalc() {
		let subtotal = 0n;
		const byTax = new Map();
		for (const [i, l] of readLines().entries()) {
			const q = parseDec(l.quantity, 3), p = parseDec(l.unit_price, 2);
			const amount = q !== null && p !== null ? divRound(q * p, 1000n) : null;
			linesBody.children[i].querySelector(".amount").textContent = amount === null ? "—" : money(amount);
			if (amount === null) continue;
			subtotal += amount;
			for (const tid of l.tax_ids) byTax.set(tid, (byTax.get(tid) ?? 0n) + amount);
		}
		let tax = 0n;
		const rows = [h("tr", {}, h("td", {}, "Subtotal"), h("td", { class: "num" }, money(subtotal)))];
		for (const t of taxes.data) {
			const base = byTax.get(String(t.id));
			if (base === undefined) continue;
			const amount = divRound(base * BigInt(t.rate), 100000n);
			tax += amount;
			rows.push(h("tr", {}, h("td", {}, `${t.name} ${pct(t.rate)}`), h("td", { class: "num" }, money(amount))));
		}
		rows.push(h("tr", { class: "total" }, h("td", {}, "Total"), h("td", { class: "num" }, money(subtotal + tax, cur.value))));
		totals.replaceChildren(...rows);
	}
	(doc.lines.length ? doc.lines : [{}]).forEach(addLine);
	recalc();

	const save = async (btn, then) =>
		busy(btn, async () => {
			if (!form.reportValidity()) return;
			const body = { customer_id: customerSel.value, issue_date: issue.value, due_date: due.value, currency: cur.value, po_number: form.po_number.value, notes: form.notes.value, lines: readLines() };
			let saved = existing ? await api(`/${K.plural}/${existing.id}`, { method: "PUT", body }) : await api(`/${K.plural}`, { method: "POST", body });
			if (then === "issue") saved = await api(`/invoices/${saved.id}/issue`, { method: "POST" });
			go(docHref(saved));
			flash(then === "issue" ? `Invoice ${saved.number} issued.` : `${K.label} ${saved.number} saved.`);
		});

	form.onsubmit = (e) => (e.preventDefault(), save(e.submitter, null));
	form.append(
		h(
			"div",
			{ class: "grid" },
			field("Customer", customerSel),
			field(K.date, issue),
			field(K.due, due),
			field("Currency", cur),
			field("PO number", input("po_number", doc.po_number, { maxlength: 100 })),
		),
		h("h2", {}, "Lines"),
		h(
			"div",
			{ class: "scroll" },
			h(
				"table",
				{ class: "lines" },
				h("thead", {}, h("tr", {}, h("th", {}, "Category"), h("th", {}, "Description"), h("th", {}, "Qty"), h("th", {}, "Unit price"), h("th", {}, "Taxes"), h("th", { class: "right" }, "Amount"), h("th"))),
				linesBody,
			),
		),
		h(
			"div",
			{ class: "actions" },
			h("button", { type: "button", onclick: () => (addLine(), recalc()) }, "+ Add line"),
			cats.data.length ? null : h("span", { class: "hint" }, h("a", { href: "#/categories" }, "Add categories"), " to track sales to revenue accounts."),
		),
		h("table", { class: "totals" }, totals),
		field(`Notes (shown on the ${K.label.toLowerCase()})`, textarea("notes", doc.notes, { rows: 3, maxlength: 5000 })),
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, kind === "invoice" ? "Save draft" : "Save"),
			kind === "invoice" ? h("button", { type: "button", onclick: (e) => save(e.currentTarget, "issue") }, "Save & issue") : null,
			h("a", { class: "button", href: existing ? docHref(existing) : `#/${K.plural}` }, "Cancel"),
		),
	);
	render(h("h1", {}, existing ? `Edit ${existing.number}` : `New ${K.label.toLowerCase()}`), form);
}

// ---- document view -----------------------------------------------------------------

async function docView(kind, id) {
	const K = KINDS[kind];
	const isInvoice = kind === "invoice";
	const [doc, settings] = await Promise.all([api(`/${K.plural}/${id}`), api("/settings")]);
	const path = `/${K.plural}/${id}`;
	const reload = () => docView(kind, id).catch(fail);
	const act = (label, fn, attrs = {}) => h("button", { ...attrs, onclick: (e) => busy(e.currentTarget, fn) }, label);
	const post = async (action, msg) => {
		await api(`${path}/${action}`, { method: "POST", body: {} });
		flash(msg);
		reload();
	};

	const actions = [];
	const editable = isInvoice ? doc.status === "draft" : ["draft", "sent"].includes(doc.status);
	if (editable) actions.push(h("a", { class: "button", href: `#${path}/edit` }, "Edit"));
	if (isInvoice) {
		if (doc.status === "draft") actions.push(act("Issue", () => post("issue", `Invoice ${doc.number} issued.`), { class: "primary" }));
		if (doc.status !== "void") actions.push(act(doc.status === "draft" ? "Issue & email" : doc.sent_at ? "Email again" : "Email", () => sendDialog(doc, settings, reload), { class: doc.status === "draft" ? "" : "primary" }));
	} else {
		if (["draft", "sent", "accepted"].includes(doc.status)) actions.push(act(doc.sent_at ? "Email again" : "Email", () => sendDialog(doc, settings, reload), { class: "primary" }));
		if (doc.status === "draft") actions.push(act("Mark as sent", () => post("mark-sent", `${K.label} ${doc.number} marked as sent.`)));
		if (["draft", "sent"].includes(doc.status)) {
			actions.push(act("Accepted", () => post("accept", `${K.label} ${doc.number} accepted.`)));
			actions.push(act("Declined", () => post("decline", `${K.label} ${doc.number} declined.`)));
		}
		if (["accepted", "declined"].includes(doc.status)) actions.push(act("Reopen", () => post("reopen", `${K.label} ${doc.number} reopened.`)));
		if (["draft", "sent", "accepted"].includes(doc.status)) {
			actions.push(
				act("Convert to invoice", async () => {
					const inv = await api(`${path}/convert`, { method: "POST", body: {} });
					go(`#/invoices/${inv.id}`);
					flash(`Draft invoice ${inv.number} created from ${doc.number}.`);
				}, { class: doc.status === "accepted" ? "primary" : "" }),
			);
		}
	}
	actions.push(act("Download PDF", async () => {
		const f = await api(`${path}/pdf`);
		saveBase64(f.filename, f.content_type, f.content_base64);
	}));
	if (isInvoice && doc.status === "open") actions.push(act("Record payment", () => paymentDialog(doc, reload)));
	actions.push(h("span", { class: "spacer" }));
	actions.push(act("Duplicate", async () => {
		const copy = await api(`${path}/duplicate`, { method: "POST" });
		go(`#/${K.plural}/${copy.id}/edit`);
		flash(`${K.label} ${copy.number} created from ${doc.number}.`);
	}));
	if (isInvoice && doc.status === "open") {
		actions.push(act("Void", async () => {
			if (!confirm(`Void invoice ${doc.number}?${doc.journal_entry_id ? " Its entry in the books will be reversed." : ""}`)) return;
			await post("void", `Invoice ${doc.number} voided.`);
		}, { class: "danger" }));
	}
	if ((isInvoice && doc.status === "draft") || (!isInvoice && doc.status !== "converted")) {
		actions.push(act("Delete", async () => {
			if (!confirm(`Delete ${K.label.toLowerCase()} ${doc.number}?`)) return;
			await api(path, { method: "DELETE" });
			flash(`${K.label} ${doc.number} deleted.`);
			go(`#/${K.plural}`);
		}, { class: "danger" }));
	}

	const c = doc.customer;
	const ledgerLink = (entryId, label) => h("a", { href: `/journal/${entryId}`, target: "_top" }, label);
	const showTax = doc.lines.some((l) => l.taxes.length);
	const showCat = doc.lines.some((l) => l.category_name);
	const totalRows = [h("tr", {}, h("td", {}, "Subtotal"), h("td", { class: "num" }, money(doc.subtotal_cents)))];
	for (const t of doc.taxes) totalRows.push(h("tr", {}, h("td", {}, `${t.name} ${pct(t.rate)}`), h("td", { class: "num" }, money(t.tax_cents))));
	totalRows.push(h("tr", { class: "total" }, h("td", {}, "Total"), h("td", { class: "num" }, money(doc.total_cents, doc.currency))));
	if (isInvoice && Number(doc.paid_cents)) totalRows.push(h("tr", {}, h("td", {}, "Paid"), h("td", { class: "num" }, "-" + money(doc.paid_cents))));
	if (isInvoice && doc.status !== "void") totalRows.push(h("tr", { class: "total" }, h("td", {}, "Balance due"), h("td", { class: "num" }, money(doc.balance_cents, doc.currency))));

	const details = [
		[K.date, doc.issue_date],
		[K.due, doc.due_date],
		["Currency", doc.currency],
		doc.po_number ? ["PO number", doc.po_number] : null,
		doc.source ? ["Created from", h("a", { href: docHref(doc.source) }, `${KINDS[doc.source.kind].label} ${doc.source.number}`)] : null,
		doc.converted ? ["Invoiced as", h("a", { href: docHref(doc.converted) }, `Invoice ${doc.converted.number}`)] : null,
		doc.sent_at ? ["Last emailed", when(doc.sent_at)] : null,
		doc.decided_at && !isInvoice ? ["Decided", when(doc.decided_at)] : null,
		doc.journal_entry_id ? ["In the books", ledgerLink(doc.journal_entry_id, `Journal entry #${doc.journal_entry_id}`)] : null,
		doc.void_entry_id ? ["Voided by", ledgerLink(doc.void_entry_id, `Journal entry #${doc.void_entry_id}`)] : null,
		["Created by", doc.created_by],
	].filter(Boolean);

	render(
		h("p", {}, h("a", { href: `#/${K.plural}` }, `← ${K.title}`)),
		h("h1", {}, `${K.label} ${doc.number}`, badge(doc)),
		h("div", { class: "actions" }, actions),
		h(
			"div",
			{ class: "two" },
			h(
				"div",
				{},
				h("h2", {}, isInvoice ? "Bill to" : "Prepared for"),
				h("div", {}, h("a", { href: `#/customers/${c.id}` }, h("strong", {}, c.name))),
				c.company ? h("div", {}, c.company) : null,
				c.address ? h("div", { class: "box muted" }, c.address) : null,
				c.email ? h("div", { class: "muted" }, c.email) : h("div", { class: "muted" }, "No email address on file."),
			),
			h("div", {}, h("h2", {}, "Details"), h("table", {}, h("tbody", {}, details.map(([k, v]) => h("tr", {}, h("td", { class: "muted" }, k), h("td", {}, v)))))),
		),
		h("h2", {}, "Lines"),
		table(
			[showCat ? "Category" : null, "Description", ["Qty", "right"], ["Unit price", "right"], showTax ? ["Taxes", "right"] : null, ["Amount", "right"]].filter(Boolean),
			doc.lines.map((l) =>
				h(
					"tr",
					{},
					showCat ? h("td", { class: "muted" }, l.category_name ?? "—") : null,
					h("td", { class: "box" }, l.description),
					h("td", { class: "num" }, l.quantity_text),
					h("td", { class: "num" }, money(l.unit_price_cents)),
					showTax ? h("td", { class: "num" }, l.taxes.map((t) => t.name).join(" + ") || "—") : null,
					h("td", { class: "num" }, money(l.amount_cents)),
				),
			),
		),
		h("table", { class: "totals", style: "margin-top:0.75rem" }, h("tbody", {}, totalRows)),
		doc.notes ? [h("h2", {}, "Notes"), h("p", { class: "box" }, doc.notes)] : null,
		doc.payments.length
			? [
					h("h2", {}, "Payments"),
					table(
						["Date", "Method", "Reference", "Books", ["Amount", "right"], ""],
						doc.payments.map((p) =>
							h(
								"tr",
								{},
								h("td", {}, p.payment_date),
								h("td", {}, p.method),
								h("td", {}, p.reference),
								h("td", {}, p.journal_entry_id ? ledgerLink(p.journal_entry_id, `#${p.journal_entry_id}`) : h("span", { class: "muted" }, "not posted")),
								h("td", { class: "num" }, money(p.amount_cents, doc.currency)),
								h(
									"td",
									{ class: "right" },
									doc.status !== "void"
										? act("Remove", async () => {
												if (!confirm(`Remove the payment of ${money(p.amount_cents, doc.currency)}?${p.journal_entry_id ? " Its entry in the books will be reversed." : ""}`)) return;
												await api(`${path}/payments/${p.id}`, { method: "DELETE" });
												flash("Payment removed.");
												reload();
											}, { class: "link" })
										: null,
								),
							),
						),
					),
				]
			: null,
		doc.emails.length
			? [
					h("h2", {}, "Email history"),
					table(
						["When", "To", "Subject", "Result"],
						doc.emails.map((m) =>
							h("tr", {}, h("td", {}, when(m.sent_at)), h("td", {}, m.recipients), h("td", {}, m.subject), h("td", { style: `color:var(${m.ok ? "--ok" : "--danger"})` }, m.ok ? `Sent by ${m.sent_by}` : m.error)),
						),
					),
				]
			: null,
	);
}

async function sendDialog(doc, settings, done) {
	const K = KINDS[doc.kind];
	if (!settings.email_ready) {
		flash("Set up email first: Settings → Email.", "error");
		return;
	}
	const d = await api(`/${K.plural}/${doc.id}/email`);
	const draftInvoice = doc.kind === "invoice" && doc.status === "draft";
	const form = h(
		"form",
		{ method: "dialog" },
		h("h2", {}, draftInvoice ? `Issue and email ${doc.number}` : `Email ${K.label.toLowerCase()} ${doc.number}`),
		field("To", input("to", d.to, { required: true, placeholder: "name@example.com" })),
		field("Cc", input("cc", d.cc)),
		field("Subject", input("subject", d.subject, { required: true, maxlength: 300 })),
		field("Message", textarea("message", d.message, { rows: 8 })),
		h(
			"p",
			{ class: "hint" },
			`The ${K.label.toLowerCase()} PDF is attached. Sent from ${settings.from_email}${settings.bcc_self ? ", with a copy to you" : ""}.`,
			draftInvoice ? " Sending issues the draft first." : doc.status === "draft" ? " It will be marked as sent." : "",
		),
		h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Send"), h("button", { type: "button", onclick: closeDialog }, "Cancel")),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const r = await api(`/${K.plural}/${doc.id}/send`, { method: "POST", body: formData(form) });
			closeDialog();
			flash(`${K.label} ${r.number} sent to ${form.to.value}.`);
			done();
		});
	};
	openDialog(form);
}

function paymentDialog(doc, done) {
	const form = h(
		"form",
		{ method: "dialog" },
		h("h2", {}, `Record a payment on ${doc.number}`),
		h(
			"div",
			{ class: "grid" },
			field("Date", input("payment_date", todayStr(), { type: "date", required: true })),
			field(`Amount (${doc.currency})`, input("amount", fmtDec(doc.balance_cents, 2), { inputmode: "decimal", required: true })),
			field("Method", input("method", "", { list: "methods", placeholder: "e.g. e-Transfer", maxlength: 50 })),
			field("Reference", input("reference", "", { maxlength: 100 })),
		),
		h("datalist", { id: "methods" }, ["e-Transfer", "Cheque", "Cash", "Credit card", "Wire", "ACH", "PayPal"].map((m) => h("option", { value: m }))),
		h("p", { class: "hint" }, `Balance due: ${money(doc.balance_cents, doc.currency)}.`, doc.journal_entry_id ? " This posts the payment to the books (bank / receivable)." : ""),
		h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Record payment"), h("button", { type: "button", onclick: closeDialog }, "Cancel")),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const r = await api(`/invoices/${doc.id}/payments`, { method: "POST", body: formData(form) });
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
		h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Company", "Email", "Phone"].map((x) => h("th", {}, x)), h("th", { class: "right" }, "Invoices"), h("th", { class: "right" }, "Outstanding"))), tbody),
	);
	await load();
}

async function customerForm(idOrNull) {
	const [settings, taxes, c] = await Promise.all([api("/settings"), api("/taxes"), idOrNull ? api(`/customers/${idOrNull}`) : null]);
	const cust = c ?? { currency: settings.default_currency, tax_ids: null };
	const customTaxes = h("input", { type: "checkbox", checked: cust.tax_ids !== null });
	const picker = taxPicker(taxes.data, cust.tax_ids ?? settings.default_tax_ids);
	const pickerWrap = h("div", { class: "wide", hidden: cust.tax_ids === null }, picker.el, h("p", { class: "hint" }, "Choose none for a tax-exempt or foreign customer."));
	customTaxes.onchange = () => (pickerWrap.hidden = !customTaxes.checked);
	const form = h(
		"form",
		{ autocomplete: "off" },
		h(
			"div",
			{ class: "grid" },
			field("Name", input("name", cust.name, { required: true, maxlength: 200 })),
			field("Company", input("company", cust.company, { maxlength: 200 })),
			field("Email (documents go here)", input("email", cust.email, { type: "email", maxlength: 254 })),
			field("Cc emails", input("cc_emails", cust.cc_emails, { placeholder: "comma-separated", maxlength: 1000 })),
			field("Phone", input("phone", cust.phone, { maxlength: 50 })),
			field("Tax number", input("tax_id", cust.tax_id, { maxlength: 50 })),
			field("Currency", select("currency", cust.currency, CURRENCY_OPTIONS)),
			field("Payment terms (days)", input("terms_days", cust.terms_days ?? "", { type: "number", min: 0, max: 365, placeholder: `default (${settings.default_terms_days})` })),
			h("label", { class: "check wide" }, customTaxes, h("span", {}, "Use different taxes for this customer")),
			pickerWrap,
			field("Billing address", textarea("address", cust.address, { rows: 4, maxlength: 1000 }), "wide"),
			field("Private notes", textarea("notes", cust.notes, { rows: 3, maxlength: 5000 }), "wide"),
			c ? h("label", { class: "check wide" }, h("input", { type: "checkbox", name: "archived", checked: c.archived }), h("span", {}, "Archived (hidden from lists and new documents)")) : null,
		),
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, c ? "Save" : "Add customer"),
			h("a", { class: "button", href: c ? `#/customers/${c.id}` : "#/customers" }, "Cancel"),
			h("span", { class: "spacer" }),
			c && c.documents.length === 0
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
			const body = { ...formData(form), tax_ids: customTaxes.checked ? picker.get() : null };
			const saved = c ? await api(`/customers/${c.id}`, { method: "PUT", body }) : await api("/customers", { method: "POST", body });
			flash(c ? "Customer saved." : `Added ${saved.name}.`);
			go(`#/customers/${saved.id}`);
		});
	};
	render(h("h1", {}, c ? `Edit ${c.name}` : "New customer"), form);
}

async function customerView(id) {
	const [c, taxes] = await Promise.all([api(`/customers/${id}`), api("/taxes")]);
	const taxNames = c.tax_ids === null ? "default" : c.tax_ids.map((t) => taxes.data.find((x) => String(x.id) === String(t))?.name ?? "?").join(" + ") || "none (exempt)";
	const info = [
		["Company", c.company],
		["Email", c.email],
		["Cc", c.cc_emails],
		["Phone", c.phone],
		["Tax number", c.tax_id],
		["Currency", c.currency],
		["Terms", c.terms_days !== null ? `${c.terms_days} days` : "default"],
		["Taxes", taxNames],
		["Outstanding", outstandingText(c.outstanding)],
	].filter(([, v]) => v);
	render(
		h("p", {}, h("a", { href: "#/customers" }, "← Customers")),
		h("h1", {}, c.name, c.archived ? h("span", { class: "badge void" }, "archived") : null),
		h(
			"div",
			{ class: "actions" },
			h("a", { class: "button primary", href: `#/invoices/new?customer=${c.id}` }, "+ Invoice"),
			h("a", { class: "button", href: `#/quotes/new?customer=${c.id}` }, "+ Quote"),
			h("a", { class: "button", href: `#/estimates/new?customer=${c.id}` }, "+ Estimate"),
			h("a", { class: "button", href: `#/customers/${c.id}/edit` }, "Edit"),
		),
		h(
			"div",
			{ class: "two" },
			h("table", {}, h("tbody", {}, info.map(([k, v]) => h("tr", {}, h("td", { class: "muted" }, k), h("td", {}, v))))),
			h("div", {}, c.address ? [h("div", { class: "muted" }, "Billing address"), h("div", { class: "box" }, c.address)] : null, c.notes ? [h("div", { class: "muted", style: "margin-top:0.75rem" }, "Notes"), h("div", { class: "box" }, c.notes)] : null),
		),
		h("h2", {}, "Invoices, quotes and estimates"),
		c.documents.length
			? table(
					["Type", "Number", "Date", "Due / valid until", "Status", ["Total", "right"]],
					c.documents.map((d) =>
						h(
							"tr",
							{ class: "click", onclick: () => go(docHref(d)) },
							h("td", {}, KINDS[d.kind].label),
							h("td", {}, h("a", { href: docHref(d) }, d.number)),
							h("td", {}, d.issue_date),
							h("td", {}, d.due_date),
							h("td", {}, badge(d)),
							h("td", { class: "num" }, money(d.total_cents, d.currency)),
						),
					),
				)
			: h("p", { class: "muted" }, "Nothing yet."),
	);
}

// ---- categories ----------------------------------------------------------------------------------

async function loadAccounts() {
	return (await api("/accounts").catch(() => ({ data: [] }))).data;
}

/** A <select> of ledger accounts in one currency, preferring the given types. */
function accountSelect(name, accounts, cur, types, value) {
	let list = accounts.filter((a) => a.currency === cur && types.includes(a.type));
	if (!list.length) list = accounts.filter((a) => a.currency === cur);
	const opts = [["", "— none —"], ...list.map((a) => [a.code, `${a.code} ${a.name}`])];
	if (value && !opts.some(([v]) => v === value)) opts.push([value, value]);
	return select(name, value ?? "", opts);
}

async function categoryList(range = {}) {
	const [cats, taxes, accounts, settings] = await Promise.all([api(`/categories?${new URLSearchParams(range)}`), api("/taxes"), loadAccounts(), api("/settings")]);
	const taxName = (ids) => (ids === null ? "default" : ids.map((t) => taxes.data.find((x) => String(x.id) === String(t))?.name ?? "?").join(" + ") || "none");
	const sales = (list) => (list.length ? list.map((s) => money(s.cents, s.currency)).join(", ") : "—");
	const from = input("from", cats.from, { type: "date" });
	const to = input("to", cats.to, { type: "date" });
	const reload = () => categoryList({ from: from.value, to: to.value }).catch(fail);
	from.onchange = to.onchange = reload;
	render(
		h("h1", {}, "Categories", h("span", { class: "spacer" }), h("button", { class: "primary", onclick: () => categoryDialog(null, taxes.data, accounts, settings, reload) }, "+ New category")),
		h("p", { class: "muted" }, "Each category tracks its sales to a revenue account. When an invoice is issued (with ledger posting on), each line's amount is credited to its category's account."),
		h("div", { class: "filters" }, h("span", { class: "muted" }, "Sales from"), from, h("span", { class: "muted" }, "to"), to),
		table(
			["Category", "Revenue account (CAD)", "Revenue account (USD)", "Taxes", ["Sales (issued invoices)", "right"], ""],
			[
				...cats.data.map((c) =>
					h(
						"tr",
						{},
						h("td", {}, h("strong", {}, c.name), c.active ? null : h("span", { class: "muted" }, " (off)"), c.description ? h("div", { class: "muted" }, c.description) : null),
						h("td", {}, c.accounts.CAD ?? h("span", { class: "muted" }, settings.accounts?.CAD?.revenue ? `default (${settings.accounts.CAD.revenue})` : "—")),
						h("td", {}, c.accounts.USD ?? h("span", { class: "muted" }, settings.accounts?.USD?.revenue ? `default (${settings.accounts.USD.revenue})` : "—")),
						h("td", {}, taxName(c.tax_ids)),
						h("td", { class: "num" }, sales(c.sales)),
						h("td", { class: "right" }, h("button", { class: "link", onclick: () => categoryDialog(c, taxes.data, accounts, settings, reload) }, "Edit")),
					),
				),
				cats.uncategorized.length ? h("tr", {}, h("td", { class: "muted" }, "No category"), h("td"), h("td"), h("td"), h("td", { class: "num" }, sales(cats.uncategorized)), h("td")) : null,
				cats.data.length ? null : h("tr", {}, h("td", { colspan: 6, class: "muted" }, "No categories yet. Add some, e.g. Labour, Materials, Consulting.")),
			],
		),
	);
}

function categoryDialog(cat, taxes, accounts, settings, done) {
	const c = cat ?? { name: "", description: "", accounts: {}, tax_ids: null, active: true };
	const customTaxes = h("input", { type: "checkbox", checked: c.tax_ids !== null });
	const picker = taxPicker(taxes, c.tax_ids ?? settings.default_tax_ids);
	const pickerWrap = h("div", { hidden: c.tax_ids === null }, picker.el, h("p", { class: "hint" }, "Choose none for zero-rated or exempt sales."));
	customTaxes.onchange = () => (pickerWrap.hidden = !customTaxes.checked);
	const form = h(
		"form",
		{ method: "dialog" },
		h("h2", {}, cat ? `Edit ${cat.name}` : "New category"),
		field("Name", input("name", c.name, { required: true, maxlength: 100 })),
		field("Description", input("description", c.description, { maxlength: 500 })),
		h(
			"div",
			{ class: "grid" },
			field("Revenue account (CAD)", accountSelect("acct_CAD", accounts, "CAD", ["revenue"], c.accounts.CAD)),
			field("Revenue account (USD)", accountSelect("acct_USD", accounts, "USD", ["revenue"], c.accounts.USD)),
		),
		h("p", { class: "hint" }, "Left empty, the default revenue account from Settings is used."),
		h("label", { class: "check" }, customTaxes, h("span", {}, "Lines in this category get specific taxes")),
		pickerWrap,
		cat ? h("label", { class: "check" }, h("input", { type: "checkbox", name: "active", checked: c.active }), h("span", {}, "Active (offered on new lines)")) : null,
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, "Save"),
			h("button", { type: "button", onclick: closeDialog }, "Cancel"),
			h("span", { class: "spacer" }),
			cat
				? h("button", {
						type: "button",
						class: "danger",
						onclick: (e) =>
							busy(e.currentTarget, async () => {
								if (!confirm(`Delete category ${cat.name}?`)) return;
								await api(`/categories/${cat.id}`, { method: "DELETE" });
								closeDialog();
								flash(`Deleted ${cat.name}.`);
								done();
							}),
					}, "Delete")
				: null,
		),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const o = formData(form);
			const body = { name: o.name, description: o.description, accounts: { CAD: o.acct_CAD, USD: o.acct_USD }, tax_ids: customTaxes.checked ? picker.get() : null };
			if (cat) body.active = o.active;
			await (cat ? api(`/categories/${cat.id}`, { method: "PUT", body }) : api("/categories", { method: "POST", body }));
			closeDialog();
			flash(`Category ${o.name} saved.`);
			done();
		});
	};
	openDialog(form);
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

function taxDialog(tax, accounts, done) {
	const t = tax ?? { name: "", rate: 0, accounts: {}, active: true };
	const form = h(
		"form",
		{ method: "dialog" },
		h("h2", {}, tax ? `Edit ${tax.name}` : "New tax"),
		h("div", { class: "grid" }, field("Name (shown on documents)", input("name", t.name, { required: true, maxlength: 30, placeholder: "e.g. GST" })), field("Rate (%)", input("rate", fmtDec(t.rate, 3), { required: true, inputmode: "decimal" }))),
		h(
			"div",
			{ class: "grid" },
			field("Account it's owed to (CAD)", accountSelect("acct_CAD", accounts, "CAD", ["liability"], t.accounts.CAD)),
			field("Account it's owed to (USD)", accountSelect("acct_USD", accounts, "USD", ["liability"], t.accounts.USD)),
		),
		h("p", { class: "hint" }, "Tax collected is credited to this account when an invoice is posted, e.g. 2200 GST/HST payable. Changing a rate doesn't change documents already saved."),
		h("label", { class: "check" }, h("input", { type: "checkbox", name: "active", checked: t.active }), h("span", {}, "On (offered on lines)")),
		h(
			"div",
			{ class: "actions" },
			h("button", { class: "primary", type: "submit" }, "Save"),
			h("button", { type: "button", onclick: closeDialog }, "Cancel"),
			h("span", { class: "spacer" }),
			tax
				? h("button", {
						type: "button",
						class: "danger",
						onclick: (e) =>
							busy(e.currentTarget, async () => {
								if (!confirm(`Delete tax ${tax.name}?`)) return;
								await api(`/taxes/${tax.id}`, { method: "DELETE" });
								closeDialog();
								flash(`Deleted ${tax.name}.`);
								done();
							}),
					}, "Delete")
				: null,
		),
	);
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			const o = formData(form);
			const body = { name: o.name, rate: o.rate, active: o.active, accounts: { CAD: o.acct_CAD, USD: o.acct_USD } };
			await (tax ? api(`/taxes/${tax.id}`, { method: "PUT", body }) : api("/taxes", { method: "POST", body }));
			closeDialog();
			flash(`Tax ${o.name} saved.`);
			done();
		});
	};
	openDialog(form);
}

async function settingsView() {
	const [s, accounts, taxes] = await Promise.all([api("/settings"), loadAccounts(), api("/taxes")]);
	const reload = () => settingsView().catch(fail);
	const roles = { receivable: ["Accounts receivable", ["asset"]], revenue: ["Default revenue (lines without a category)", ["revenue"]], bank: ["Bank (payments go to)", ["asset"]] };
	const acctFields = ["CAD", "USD"].map((cur) =>
		h(
			"div",
			{},
			h("strong", {}, cur),
			h("div", { class: "grid", style: "margin-top:0.4rem" }, Object.entries(roles).map(([role, [label, types]]) => field(label, accountSelect(`acct.${cur}.${role}`, accounts, cur, types, s.accounts?.[cur]?.[role] ?? "")))),
		),
	);
	const defaultTaxes = taxPicker(taxes.data, s.default_tax_ids);
	const note = h("p", { class: "hint" });
	const preset = select("preset", "", [["", "Fill in for a provider…"], ["gmail", "Gmail / Google Workspace"], ["outlook", "Microsoft 365 / Outlook"], ["fastmail", "Fastmail"], ["icloud", "iCloud Mail"], ["zoho", "Zoho Mail"], ["local", "Local relay (no login)"]]);
	const numbering = (kind, label) => [field(`${label} prefix`, input(`${kind}_prefix`, s[`${kind}_prefix`], { maxlength: 20 })), field(`Next ${label.toLowerCase()} number`, input(`next_${kind}_number`, s[`next_${kind}_number`], { type: "number", min: 1 }))];

	const form = h(
		"form",
		{ autocomplete: "off" },
		h(
			"fieldset",
			{},
			h("legend", {}, "Your business (shown on documents)"),
			h(
				"div",
				{ class: "grid" },
				field("Business name", input("business_name", s.business_name, { maxlength: 200 })),
				field("Email", input("business_email", s.business_email, { type: "email" })),
				field("Phone", input("business_phone", s.business_phone, { maxlength: 50 })),
				field("Tax number label", input("tax_id_label", s.tax_id_label, { maxlength: 30 })),
				field("GST/HST registration number", input("tax_id", s.tax_id, { maxlength: 50, placeholder: "e.g. 123456789RT0001" })),
				field("Address", textarea("business_address", s.business_address, { rows: 3 }), "wide"),
				field("Footer (payment instructions, thanks…)", textarea("footer", s.footer, { rows: 3 }), "wide"),
			),
		),
		h(
			"fieldset",
			{},
			h("legend", {}, "Taxes"),
			h("p", { class: "hint" }, "GST is set up and on. Turn on the others you collect (HST, PST, QST) and set the account each is owed to. A line can carry several, e.g. GST + PST."),
			table(
				["Tax", ["Rate", "right"], "CAD account", "USD account", "Status", ""],
				taxes.data.map((t) =>
					h(
						"tr",
						{},
						h("td", {}, h("strong", {}, t.name)),
						h("td", { class: "num" }, pct(t.rate)),
						h("td", {}, t.accounts.CAD ?? h("span", { class: "muted" }, "—")),
						h("td", {}, t.accounts.USD ?? h("span", { class: "muted" }, "—")),
						h("td", {}, t.active ? "on" : h("span", { class: "muted" }, "off")),
						h("td", { class: "right" }, h("button", { type: "button", class: "link", onclick: () => taxDialog(t, accounts, reload) }, "Edit")),
					),
				),
			),
			h("div", { class: "actions" }, h("button", { type: "button", onclick: () => taxDialog(null, accounts, reload) }, "+ Add tax")),
			h("div", {}, h("span", { class: "muted" }, "Taxes on new lines by default: "), defaultTaxes.el),
		),
		h(
			"fieldset",
			{},
			h("legend", {}, "Numbering and defaults"),
			h(
				"div",
				{ class: "grid" },
				numbering("invoice", "Invoice"),
				numbering("quote", "Quote"),
				numbering("estimate", "Estimate"),
				field("Default currency", select("default_currency", s.default_currency, CURRENCY_OPTIONS)),
				field("Invoice payment terms (days)", input("default_terms_days", s.default_terms_days, { type: "number", min: 0, max: 365 })),
				field("Quotes valid for (days)", input("quote_valid_days", s.quote_valid_days, { type: "number", min: 0, max: 365 })),
				field("Estimates valid for (days)", input("estimate_valid_days", s.estimate_valid_days, { type: "number", min: 0, max: 365 })),
				field("Terms printed on quotes", textarea("quote_terms", s.quote_terms, { rows: 2 }), "wide"),
				field("Terms printed on estimates", textarea("estimate_terms", s.estimate_terms, { rows: 2 }), "wide"),
			),
		),
		h(
			"fieldset",
			{},
			h("legend", {}, "Ledger posting"),
			h("label", { class: "check" }, h("input", { type: "checkbox", name: "post_to_ledger", checked: s.post_to_ledger }), h("span", {}, "Post invoices and payments to the books")),
			h(
				"p",
				{ class: "hint" },
				"Issuing an invoice posts Dr receivable / Cr each line's category revenue account and each tax's account. A payment posts Dr bank / Cr receivable. Voiding reverses the invoice's entry. Quotes and estimates are never posted.",
			),
			accounts.length ? acctFields : h("p", { class: "muted" }, "No accounts in Ledger yet."),
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
			h("div", { class: "grid" }, field("Subject", input("email_subject", s.email_subject, { maxlength: 300 }), "wide"), field("Message", textarea("email_body", s.email_body, { rows: 6 }), "wide")),
			h("h2", {}, "Quote and estimate email"),
			h("div", { class: "grid" }, field("Subject", input("quote_email_subject", s.quote_email_subject, { maxlength: 300 }), "wide"), field("Message", textarea("quote_email_body", s.quote_email_body, { rows: 6 }), "wide")),
			h("p", { class: "hint" }, "Placeholders: {{type}} {{type_lower}} {{number}} {{customer}} {{company}} {{total}} {{balance}} {{issue_date}} {{due_date}} {{valid_until}} {{business}}"),
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
		const out = { accounts: { CAD: {}, USD: {} }, default_tax_ids: defaultTaxes.get() };
		for (const [k, v] of Object.entries(o)) {
			if (k === "preset") continue;
			if (k.startsWith("acct.")) {
				const [, cur, role] = k.split(".");
				out.accounts[cur][role] = v;
			} else out[k] = v;
		}
		if (!accounts.length) delete out.accounts;
		if (out.smtp_password === "") delete out.smtp_password; // keep the saved one
		return out;
	}
	const saveAll = () => api("/settings", { method: "PUT", body: collect() });
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
		reload();
	}
	form.onsubmit = (e) => {
		e.preventDefault();
		busy(e.submitter, async () => {
			await saveAll();
			flash("Settings saved.");
			reload();
		});
	};
	render(h("h1", {}, "Settings"), form);
}

route();
