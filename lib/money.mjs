// Exact invoice arithmetic. Money is integer cents, quantities are
// thousandths (1.5 = 1500) and tax rates thousandths of a percent
// (13% = 13000). Everything is computed with bigint and rounded half away
// from zero, the way a calculator would.

export const MAX_CENTS = 10n ** 13n; // 100 billion: far beyond any real invoice

/** a / b rounded half away from zero; b > 0. */
export function divRound(a, b) {
	const q = a / b;
	const r = a % b;
	if (2n * (r < 0n ? -r : r) >= b) return q + (a < 0n ? -1n : 1n);
	return q;
}

/** Parses a decimal string or number with at most `scale` decimals into an integer scaled by 10^scale. */
export function parseDecimal(v, scale, field) {
	const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replaceAll(",", "") : "";
	const m = /^(-?)(\d{0,12})(?:\.(\d*))?$/.exec(s);
	if (!m || (m[2] === "" && !m[3]) || (m[3] && m[3].length > scale)) {
		throw new RangeError(`${field} must be a number with at most ${scale} decimals`);
	}
	const frac = (m[3] ?? "").padEnd(scale, "0");
	const n = BigInt((m[2] || "0") + frac);
	return m[1] === "-" ? -n : n;
}

/** Formats an integer scaled by 10^scale as a plain decimal, dropping trailing zeros past `keep` decimals. */
export function formatDecimal(n, scale, keep = 0) {
	n = BigInt(n);
	const neg = n < 0n;
	const s = (neg ? -n : n).toString().padStart(scale + 1, "0");
	let int = s.slice(0, s.length - scale);
	let frac = s.slice(s.length - scale);
	while (frac.length > keep && frac.endsWith("0")) frac = frac.slice(0, -1);
	return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

/** 123456 → "1,234.56"; with currency "CAD" → "$1,234.56 CAD". */
export function formatMoney(cents, currency) {
	cents = BigInt(cents);
	const neg = cents < 0n;
	const [int, frac] = formatDecimal(neg ? -cents : cents, 2, 2).split(".");
	const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const s = `${neg ? "-" : ""}${currency ? "$" : ""}${grouped}.${frac}`;
	return currency ? `${s} ${currency}` : s;
}

/** Line amount in cents: quantity (thousandths) × unit price (cents). */
export function lineAmount(quantity, unitPriceCents) {
	return divRound(BigInt(quantity) * BigInt(unitPriceCents), 1000n);
}

/**
 * Totals for a list of lines ({quantity, unit_price_cents, tax_rate}).
 * Tax is computed once per rate on the sum of the lines at that rate, so it
 * doesn't drift by a cent per line. Returns bigint cents plus the per-rate
 * breakdown (rate in thousandths of a percent).
 */
export function computeTotals(lines) {
	const byRate = new Map();
	let subtotal = 0n;
	const amounts = lines.map((l) => {
		const amount = lineAmount(l.quantity, l.unit_price_cents);
		subtotal += amount;
		const rate = Number(l.tax_rate ?? 0);
		byRate.set(rate, (byRate.get(rate) ?? 0n) + amount);
		return amount;
	});
	let tax = 0n;
	const taxes = [];
	for (const [rate, base] of [...byRate].sort((a, b) => a[0] - b[0])) {
		if (rate === 0) continue;
		const t = divRound(base * BigInt(rate), 100000n);
		tax += t;
		taxes.push({ rate, base_cents: base, tax_cents: t });
	}
	return { amounts, subtotal, tax, total: subtotal + tax, taxes };
}

/** Adds `days` to a YYYY-MM-DD date. */
export function addDays(date, days) {
	const d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isDate(s) {
	if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(s + "T00:00:00Z");
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date (YYYY-MM-DD) in the server's local time zone. */
export function today() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
