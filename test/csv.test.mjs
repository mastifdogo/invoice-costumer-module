import assert from "node:assert/strict";
import test from "node:test";
import { decodeText, detectDelimiter, parseDelimited } from "../lib/csv.mjs";

test("reads quoted fields, doubled quotes and skips blank rows like Ledger", () => {
	const rows = parseDelimited('Name,Email\r\n\r\n"Smith, Jo",jo@x.test\n"Say ""hi""", \n,\n');
	assert.deepEqual(rows, [["Name", "Email"], ["Smith, Jo", "jo@x.test"], ['Say "hi"', ""]]);
});

test("finds semicolons and tabs", () => {
	assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
	assert.equal(detectDelimiter("a\tb\n1\t2"), "\t");
	assert.deepEqual(parseDelimited("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

test("decodes UTF-8 with a BOM, and Windows-1252", () => {
	assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x43, 0x61, 0x66, 0xc3, 0xa9])), "Café");
	assert.equal(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9])), "Café");
});

test("refuses huge files", () => {
	assert.throws(() => parseDelimited("a\nb\nc\n", { maxRows: 2 }), /more than 2 rows/);
});
