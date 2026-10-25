// A small PDF writer, just enough for invoices: text in Helvetica and
// Helvetica-Bold (the standard fonts every PDF reader has, so nothing is
// embedded), lines, filled rectangles and several pages. No dependencies.

import { formatDecimal, formatMoney } from "./money.mjs";

// Glyph widths (1/1000 em) for characters 32..126, from the standard AFM files.
// prettier-ignore
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// prettier-ignore
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Unicode characters that WinAnsiEncoding places at 0x80..0x9F.
const WIN_ANSI = new Map([
	[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
	[0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
	[0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
	[0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Unicode text → WinAnsi byte codes; anything the font can't show becomes "?". */
function encode(text) {
	const out = [];
	for (const ch of String(text)) {
		const c = ch.codePointAt(0);
		if (c === 9) out.push(32);
		else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out.push(c);
		else if (WIN_ANSI.has(c)) out.push(WIN_ANSI.get(c));
		else if (c >= 32) out.push(63);
	}
	return out;
}

/** Width of text in points. */
export function textWidth(text, size, bold = false) {
	const table = bold ? HELVETICA_BOLD : HELVETICA;
	let w = 0;
	for (const c of encode(text)) w += c >= 32 && c <= 126 ? table[c - 32] : 556;
	return (w * size) / 1000;
}

/** Splits text into lines no wider than `width`, breaking at spaces (or inside very long words). */
export function wrap(text, size, width, bold = false) {
	const lines = [];
	for (const para of String(text).split(/\r?\n/)) {
		let line = "";
		for (let word of para.split(/ +/)) {
			while (textWidth(word, size, bold) > width) {
				// A word wider than the column: put what fits on its own line.
				if (line) lines.push(line), (line = "");
				let n = word.length;
				while (n > 1 && textWidth(word.slice(0, n), size, bold) > width) n--;
				lines.push(word.slice(0, n));
				word = word.slice(n);
			}
			const candidate = line ? `${line} ${word}` : word;
			if (textWidth(candidate, size, bold) <= width) line = candidate;
			else {
				lines.push(line);
				line = word;
			}
		}
		lines.push(line);
	}
	return lines;
}

function pdfString(text) {
	let s = "(";
	for (const c of encode(text)) {
		if (c === 0x28 || c === 0x29 || c === 0x5c) s += "\\" + String.fromCharCode(c);
		else if (c < 32 || c > 126) s += "\\" + c.toString(8).padStart(3, "0");
		else s += String.fromCharCode(c);
	}
	return s + ")";
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = ([r, g, b]) => `${num(r)} ${num(g)} ${num(b)}`;

/** A document of US Letter pages. Coordinates are points from the top-left corner. */
export class PdfDocument {
	constructor({ width = 612, height = 792, title = "" } = {}) {
		this.width = width;
		this.height = height;
		this.title = title;
		this.pages = [];
		this.addPage();
	}

	addPage() {
		this.ops = [];
		this.pages.push(this.ops);
	}

	text(x, y, text, { size = 10, bold = false, color = [0, 0, 0], align = "left" } = {}) {
		if (text === "" || text == null) return;
		const w = textWidth(text, size, bold);
		const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
		this.ops.push(`BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(this.height - y)} Td ${pdfString(text)} Tj ET`);
	}

	line(x1, y1, x2, y2, { width = 0.5, color = [0.8, 0.8, 0.8] } = {}) {
		this.ops.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
	}

	rect(x, y, w, h, { fill = [0.95, 0.95, 0.95] } = {}) {
		this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`);
	}

	/** The finished file. */
	toBuffer() {
		const objects = []; // object bodies; object n is objects[n - 1]
		const add = (body) => objects.push(body) && objects.length;
		const catalog = add(null);
		const pagesObj = add(null);
		const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
		const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
		const kids = [];
		for (const ops of this.pages) {
			const content = ops.join("\n");
			const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
			kids.push(
				add(
					`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] ` +
						`/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${stream} 0 R >>`,
				),
			);
		}
		objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
		objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
		const info = add(`<< /Title ${pdfString(this.title)} /Producer (Ledger invoices module) >>`);

		let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
		const offsets = [];
		objects.forEach((body, i) => {
			offsets.push(Buffer.byteLength(out, "latin1"));
			out += `${i + 1} 0 obj\n${body}\nendobj\n`;
		});
		const xref = Buffer.byteLength(out, "latin1");
		out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
		for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
		out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		return Buffer.from(out, "latin1");
	}
}

const GREY = [0.4, 0.42, 0.46];
const DARK = [0.11, 0.14, 0.17];
const ACCENT = [0.12, 0.44, 0.92];

/** "13000" → "13%", "9975" → "9.975%". */
export const formatRate = (rate) => `${formatDecimal(rate, 3)}%`;

const TITLES = { invoice: "INVOICE", quote: "QUOTE", estimate: "ESTIMATE" };
const LABELS = { invoice: "Invoice", quote: "Quote", estimate: "Estimate" };

/**
 * Renders an invoice, quote or estimate. `d` is the document as the API
 * returns it (with `lines`, `customer`, `taxes` and totals in cents); `biz`
 * the module settings.
 */
export function renderDocumentPdf(d, biz) {
	const kind = d.kind ?? "invoice";
	const isInvoice = kind === "invoice";
	const label = LABELS[kind];
	const doc = new PdfDocument({ title: `${label} ${d.number}` });
	const L = 50; // left margin
	const R = doc.width - 50; // right edge
	const money = (c) => formatMoney(c, "");
	let y = 60;

	// Header: the business on the left, the document details on the right.
	doc.text(L, y, biz.business_name || label, { size: 18, bold: true, color: DARK });
	doc.text(R, y, (d.status === "draft" && isInvoice ? "DRAFT " : "") + TITLES[kind], { size: 22, bold: true, color: ACCENT, align: "right" });
	let ly = y + 18;
	const from = [...String(biz.business_address || "").split(/\r?\n/), biz.business_email, biz.business_phone];
	if (biz.tax_id) from.push(`${biz.tax_id_label || "Tax No."} ${biz.tax_id}`);
	for (const s of from.filter(Boolean)) {
		for (const w of wrap(s, 9.5, 260)) doc.text(L, ly, w, { size: 9.5, color: GREY }), (ly += 13);
	}
	let ry = y + 22;
	const meta = isInvoice
		? [["Invoice #", d.number], ["Issue date", d.issue_date], ["Due date", d.due_date]]
		: [[`${label} #`, d.number], ["Date", d.issue_date], ["Valid until", d.due_date]];
	if (d.po_number) meta.push(["PO #", d.po_number]);
	for (const [k, v] of meta) {
		doc.text(R - 110, ry, k, { size: 9.5, color: GREY, align: "right" });
		doc.text(R, ry, v, { size: 9.5, bold: true, align: "right" });
		ry += 14;
	}
	y = Math.max(ly, ry) + 18;

	// Customer
	const c = d.customer ?? {};
	doc.text(L, y, isInvoice ? "BILL TO" : "PREPARED FOR", { size: 8.5, bold: true, color: GREY });
	y += 15;
	doc.text(L, y, c.name ?? "", { size: 11, bold: true });
	y += 14;
	for (const s of [c.company, ...String(c.address ?? "").split(/\r?\n/), c.email, c.tax_id ? `Tax No. ${c.tax_id}` : ""].filter(Boolean)) {
		for (const w of wrap(s, 9.5, 300)) doc.text(L, y, w, { size: 9.5, color: GREY }), (y += 13);
	}
	const stamps = { paid: [0.1, 0.55, 0.3], void: [0.8, 0.15, 0.15], accepted: [0.1, 0.55, 0.3], declined: [0.8, 0.15, 0.15] };
	if (stamps[d.status]) doc.text(R, y - 10, d.status.toUpperCase(), { size: 26, bold: true, color: stamps[d.status], align: "right" });
	y += 16;

	// Line items
	const taxText = (l) => (l.taxes ?? []).map((t) => t.name).join(" + ");
	const showTax = d.lines.some((l) => (l.taxes ?? []).length > 0);
	const cols = { qty: R - 230, price: R - 150, tax: R - 85, amount: R };
	const descWidth = (showTax ? cols.qty - 50 : cols.price - 80) - L - 8;
	const header = () => {
		doc.rect(L, y - 12, R - L, 20, { fill: [0.94, 0.95, 0.97] });
		doc.text(L + 6, y + 2, "Description", { size: 9, bold: true, color: GREY });
		doc.text(showTax ? cols.qty : cols.qty + 50, y + 2, "Qty", { size: 9, bold: true, color: GREY, align: "right" });
		doc.text(showTax ? cols.price : cols.price + 50, y + 2, "Unit price", { size: 9, bold: true, color: GREY, align: "right" });
		if (showTax) doc.text(cols.tax, y + 2, "Tax", { size: 9, bold: true, color: GREY, align: "right" });
		doc.text(cols.amount - 6, y + 2, "Amount", { size: 9, bold: true, color: GREY, align: "right" });
		y += 24;
	};
	const newPage = () => {
		doc.addPage();
		y = 60;
		doc.text(L, y, `${label} ${d.number} (continued)`, { size: 9.5, color: GREY });
		y += 24;
	};
	header();
	for (const l of d.lines) {
		const desc = wrap(l.description, 10, descWidth);
		const h = desc.length * 13 + 8;
		if (y + h > doc.height - 90) newPage(), header();
		desc.forEach((t, i) => doc.text(L + 6, y + i * 13, t, { size: 10 }));
		doc.text(showTax ? cols.qty : cols.qty + 50, y, formatDecimal(l.quantity, 3), { size: 10, align: "right" });
		doc.text(showTax ? cols.price : cols.price + 50, y, money(l.unit_price_cents), { size: 10, align: "right" });
		if (showTax) {
			let t = taxText(l) || "—";
			while (textWidth(t, 9) > 62 && t.length > 2) t = t.slice(0, -2) + "…";
			doc.text(cols.tax, y, t, { size: 9, align: "right" });
		}
		doc.text(cols.amount - 6, y, money(l.amount_cents), { size: 10, align: "right" });
		y += h;
		doc.line(L, y - 14, R, y - 14);
	}

	// Totals
	const rows = [["Subtotal", money(d.subtotal_cents)]];
	for (const t of d.taxes ?? []) rows.push([`${t.name} ${formatRate(t.rate)}`, money(t.tax_cents)]);
	const totalsHeight = rows.length * 16 + 70;
	if (y + totalsHeight > doc.height - 60) newPage();
	y += 6;
	for (const [k, v] of rows) {
		doc.text(R - 110, y, k, { size: 10, color: GREY, align: "right" });
		doc.text(R - 6, y, v, { size: 10, align: "right" });
		y += 16;
	}
	doc.line(R - 230, y - 8, R, y - 8, { color: DARK, width: 0.8 });
	y += 6;
	if (isInvoice) {
		doc.text(R - 110, y, `Total (${d.currency})`, { size: 11, bold: true, align: "right" });
		doc.text(R - 6, y, money(d.total_cents), { size: 11, bold: true, align: "right" });
		y += 18;
		if (Number(d.paid_cents) > 0) {
			doc.text(R - 110, y, "Paid", { size: 10, color: GREY, align: "right" });
			doc.text(R - 6, y, `-${money(d.paid_cents)}`, { size: 10, align: "right" });
			y += 16;
		}
	}
	if (!isInvoice || d.status !== "void") {
		doc.rect(R - 230, y - 13, 230, 22, { fill: [0.92, 0.95, 1] });
		doc.text(R - 110, y + 2, isInvoice ? "Balance due" : kind === "estimate" ? "Estimated total" : "Total", { size: 11, bold: true, color: ACCENT, align: "right" });
		doc.text(R - 6, y + 2, formatMoney(isInvoice ? d.balance_cents : d.total_cents, d.currency), { size: 11, bold: true, color: ACCENT, align: "right" });
		y += 30;
	}

	// Notes, quote/estimate terms, footer
	const terms = kind === "quote" ? biz.quote_terms : kind === "estimate" ? biz.estimate_terms : "";
	for (const [title, body] of [["Notes", d.notes], ["Terms", terms], ["", biz.footer]]) {
		if (!body) continue;
		const lines = wrap(body, 9.5, R - L);
		if (y + lines.length * 13 + 30 > doc.height - 40) newPage();
		y += 10;
		if (title) doc.text(L, y, title.toUpperCase(), { size: 8.5, bold: true, color: GREY }), (y += 14);
		for (const w of lines) doc.text(L, y, w, { size: 9.5, color: title ? DARK : GREY }), (y += 13);
	}

	// Page numbers, once there is more than one page.
	if (doc.pages.length > 1) {
		doc.pages.forEach((ops, i) => {
			doc.ops = ops;
			doc.text(R, doc.height - 30, `Page ${i + 1} of ${doc.pages.length}`, { size: 8.5, color: GREY, align: "right" });
		});
	}
	return doc.toBuffer();
}
