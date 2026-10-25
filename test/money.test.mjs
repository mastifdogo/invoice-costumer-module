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

test("computeTotals: tax per rate, rounded once", () => {
	const t = computeTotals([
		{ quantity: 1500n, unit_price_cents: 3333n, tax_rate: 13000 }, // 1.5 × 33.33 = 49.995 → 50.00
		{ quantity: 1000n, unit_price_cents: 1001n, tax_rate: 13000 },
		{ quantity: 2000n, unit_price_cents: 500n, tax_rate: 0 },
		{ quantity: 1000n, unit_price_cents: 1000n, tax_rate: 5000 },
	]);
	assert.deepEqual(t.amounts, [5000n, 1001n, 1000n, 1000n]);
	assert.equal(t.subtotal, 8001n);
	// 13% of 60.01 = 7.8013 → 7.80; 5% of 10.00 = 0.50
	assert.deepEqual(t.taxes, [
		{ rate: 5000, base_cents: 1000n, tax_cents: 50n },
		{ rate: 13000, base_cents: 6001n, tax_cents: 780n },
	]);
	assert.equal(t.tax, 830n);
	assert.equal(t.total, 8831n);
});

test("dates", () => {
	assert.equal(addDays("2026-01-31", 30), "2026-03-02");
	assert.equal(addDays("2028-02-28", 1), "2028-02-29");
	assert.ok(isDate("2026-10-25"));
	assert.ok(!isDate("2026-02-30"));
	assert.ok(!isDate("26-10-25"));
});
