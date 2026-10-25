import assert from "node:assert/strict";
import { test } from "node:test";
import { PdfDocument, renderDocumentPdf, textWidth, wrap } from "../lib/pdf.mjs";

const settings = { business_name: "Maple & Co (Test)", business_address: "1 Main St\nToronto ON", business_email: "billing@example.com", tax_id_label: "GST/HST No.", tax_id: "123456789RT0001", estimate_terms: "This is an estimate, not a fixed price.", footer: "Pay by e-Transfer to billing@example.com" };
const invoice = (lines, kind = "invoice") => ({
	kind,
	number: "INV-0001",
	status: "open",
	issue_date: "2026-10-01",
	due_date: "2026-10-31",
	currency: "CAD",
	po_number: "PO-7",
	notes: "Thanks — à bientôt!",
	customer: { name: "Zoë Example", company: "Example Ltd", address: "2 Side St", email: "zoe@example.com" },
	lines,
	taxes: [{ id: 1, name: "GST", rate: 5000, base_cents: 10000n, tax_cents: 500n }, { id: 4, name: "PST", rate: 7000, base_cents: 10000n, tax_cents: 700n }],
	subtotal_cents: 10000n,
	tax_cents: 1300n,
	total_cents: 11300n,
	paid_cents: 0n,
	balance_cents: 11300n,
});
const line = (i) => ({ description: `Consulting (item ${i}) with a fairly long description that needs to wrap onto a second line in the table`, quantity: 1500n, unit_price_cents: 10000n, taxes: [{ id: 1, name: "GST", rate: 5000 }, { id: 4, name: "PST", rate: 7000 }], amount_cents: 15000n });

/** Checks the cross-reference table points at each object. */
function checkStructure(buf) {
	const s = buf.toString("latin1");
	assert.ok(s.startsWith("%PDF-1.4"));
	assert.ok(s.trimEnd().endsWith("%%EOF"));
	const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
	assert.equal(s.slice(xref, xref + 4), "xref");
	const count = Number(/xref\n0 (\d+)/.exec(s)[1]);
	const entries = s.slice(xref).split("\n").slice(3, 2 + count);
	entries.forEach((e, i) => {
		const off = Number(e.slice(0, 10));
		assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
	});
	for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
		const start = m.index + m[0].length;
		assert.equal(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream");
	}
	return s;
}

test("widths and wrapping", () => {
	assert.equal(textWidth("0000", 10), 22.24);
	const lines = wrap("aaaa bbbb cccc", 10, textWidth("aaaa bbbb", 10));
	assert.deepEqual(lines, ["aaaa bbbb", "cccc"]);
	assert.ok(wrap("x".repeat(500), 10, 100).every((l) => textWidth(l, 10) <= 100));
});

test("escapes text and keeps offsets right", () => {
	const d = new PdfDocument({ title: "t (1)" });
	d.text(10, 10, "a (b) \\ c €");
	const s = checkStructure(d.toBuffer());
	assert.ok(s.includes("(a \\(b\\) \\\\ c \\200) Tj"));
});

test("renders a one-page invoice", () => {
	const s = checkStructure(renderDocumentPdf(invoice([line(1), line(2)]), settings));
	assert.match(s, /\/Count 1 /);
	assert.ok(s.includes("(INV-0001)"));
	assert.ok(s.includes("(Maple & Co \\(Test\\))"));
});

test("long invoices continue on more pages", () => {
	const s = checkStructure(renderDocumentPdf(invoice(Array.from({ length: 60 }, (_, i) => line(i))), settings));
	const pages = Number(/\/Count (\d+)/.exec(s)[1]);
	assert.ok(pages >= 3, `pages: ${pages}`);
	assert.ok(s.includes(`(Page ${pages} of ${pages})`));
});

test("quotes and estimates have their own title, dates and terms", () => {
	const s = checkStructure(renderDocumentPdf(invoice([line(1)], "estimate"), settings));
	assert.ok(s.includes("(ESTIMATE)"));
	assert.ok(s.includes("(Valid until)"));
	assert.ok(s.includes("(This is an estimate, not a fixed price.)"));
	assert.ok(!s.includes("(Balance due)"));
	assert.ok(s.includes("(GST + PST)"));
	assert.ok(s.includes("(GST/HST No. 123456789RT0001)"));
});
