// Reads the delimited text files Ledger hands over (customer lists from its
// "migrate from other software"). It reads them the way Ledger does, so the
// header_row Ledger found points at the same row here: UTF-8 or
// Windows-1252, comma/semicolon/tab/bar, quoted fields, blank rows skipped.

/** Text from UTF-8 (BOM dropped), or Windows-1252 (what older Windows software exports). */
export function decodeText(buf) {
	let b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(b);
	} catch {
		return new TextDecoder("windows-1252").decode(b);
	}
}

/** The delimiter the first lines use most: comma, semicolon, tab or bar. */
export function detectDelimiter(text) {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 20);
	let best = ",";
	let bestScore = -1;
	for (const d of [",", ";", "\t", "|"]) {
		const counts = lines.map((l) => l.replace(/"[^"]*"/g, "").split(d).length - 1);
		const score = counts.reduce((a, b) => a + b, 0) + (counts.length && counts.every((c) => c === counts[0] && c > 0) ? 50 : 0);
		if (score > bestScore) [best, bestScore] = [d, score];
	}
	return best;
}

/** Rows of trimmed fields; rows with nothing in them are left out. At most `maxRows`. */
export function parseDelimited(text, { delimiter = detectDelimiter(text), maxRows = 20000 } = {}) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	const endField = () => {
		row.push(field.trim());
		field = "";
	};
	const endRow = () => {
		endField();
		if (row.some((c) => c !== "")) rows.push(row);
		row = [];
		if (rows.length > maxRows) throw new Error(`the file has more than ${maxRows} rows`);
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
		} else if (ch === '"' && field.trim() === "") {
			quoted = true;
			field = "";
		} else if (ch === delimiter) endField();
		else if (ch === "\n") endRow();
		else if (ch !== "\r") field += ch;
	}
	if (field !== "" || row.length > 0) endRow();
	return rows;
}
