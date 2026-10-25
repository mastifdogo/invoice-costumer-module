import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, computeTotals, divRound, formatDecimal, formatMoney, isDate, parseDecimal } from "../lib/money.mjs";

test("divRound rounds half away from zero", () => {
	assert.equal(divRound(5n, 10n), 1n);
	assert.equal(divRound(4n, 10n), 0n);
	assert.equal(divRound(-5n, 10n), -1n);
	assert.equal(divRound(-4n, 10n), 0n);
	assert.equal(divRound(15n, 10n), 2n);
});

test("parseDecimal", () => {
	assert.equal(parseDecimal("12.5", 2, "x"), 1250n);
	assert.equal(parseDecimal("1,234.56", 2, "x"), 123456n);
	assert.equal(parseDecimal(".5", 3, "x"), 500n);
	assert.equal(parseDecimal("-3", 2, "x"), -300n);
	assert.equal(parseDecimal(7, 2, "x"), 700n);
	for (const bad of ["", "abc", "1.234", "1e5", "--1", "."]) assert.throws(() => parseDecimal(bad, 2, "x"), RangeError, bad);
});

test("formatting", () => {
	assert.equal(formatDecimal(1500n, 3), "1.5");
	assert.equal(formatDecimal(13000, 3), "13");
	assert.equal(formatDecimal(14975, 3), "14.975");
	assert.equal(formatDecimal(5n, 2, 2), "0.05");
	assert.equal(formatMoney(123456789n, "CAD"), "$1,234,567.89 CAD");
	assert.equal(formatMoney(-5n, ""), "-0.05");
});

test("computeTotals: each tax once on the lines it applies to", () => {
	const GST = { id: 1, name: "GST", rate: 5000 };
	const PST = { id: 4, name: "PST", rate: 7000 };
	const t = computeTotals([
		{ quantity: 1500n, unit_price_cents: 3333n, taxes: [GST, PST] }, // 1.5 × 33.33 = 49.995 → 50.00
		{ quantity: 1000n, unit_price_cents: 1001n, taxes: [GST] },
		{ quantity: 2000n, unit_price_cents: 500n, taxes: [] },
	]);
	assert.deepEqual(t.amounts, [5000n, 1001n, 1000n]);
	assert.equal(t.subtotal, 7001n);
	// GST 5% of 60.01 = 3.0005 → 3.00; PST 7% of 50.00 = 3.50
	assert.deepEqual(t.taxes, [
		{ id: 1, name: "GST", rate: 5000, base_cents: 6001n, tax_cents: 300n },
		{ id: 4, name: "PST", rate: 7000, base_cents: 5000n, tax_cents: 350n },
	]);
	assert.equal(t.tax, 650n);
	assert.equal(t.total, 7651n);
});

test("computeTotals: a tax whose rate changed is kept apart", () => {
	const t = computeTotals([
		{ quantity: 1000n, unit_price_cents: 10000n, taxes: [{ id: 2, name: "HST", rate: 13000 }] },
		{ quantity: 1000n, unit_price_cents: 10000n, taxes: [{ id: 2, name: "HST", rate: 15000 }] },
	]);
	assert.deepEqual(t.taxes.map((x) => x.tax_cents), [1300n, 1500n]);
});

test("dates", () => {
	assert.equal(addDays("2026-01-31", 30), "2026-03-02");
	assert.equal(addDays("2028-02-28", 1), "2028-02-29");
	assert.ok(isDate("2026-10-25"));
	assert.ok(!isDate("2026-02-30"));
	assert.ok(!isDate("26-10-25"));
});
