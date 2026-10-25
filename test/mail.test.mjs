import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import tls from "node:tls";
import { buildMessage, encodeHeader, formatAddress, parseAddressList, sendMail } from "../lib/mail.mjs";

/**
 * A tiny SMTP server for tests. Records the conversation; `tlsOpts` enables STARTTLS
 * (or implicit TLS with `implicit`).
 */
function fakeServer({ auth = "PLAIN LOGIN", tlsOpts = null, implicit = false } = {}) {
	const log = { commands: [], data: null, authed: null };
	const handle = (raw) => {
		let sock = raw;
		let buf = "";
		let inData = false;
		let dataBuf = "";
		let loginStep = 0;
		const say = (s) => sock.write(s + "\r\n");
		const onData = (chunk) => {
			buf += chunk;
			let i;
			while ((i = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (inData) {
					if (line === ".") {
						inData = false;
						log.data = dataBuf;
						say("250 2.0.0 queued as TEST123");
					} else dataBuf += line + "\r\n";
					continue;
				}
				log.commands.push(line);
				if (loginStep === 1) (log.authed = { user: Buffer.from(line, "base64").toString() }), (loginStep = 2), say("334 UGFzc3dvcmQ6");
				else if (loginStep === 2) (log.authed.pass = Buffer.from(line, "base64").toString()), (loginStep = 0), say("235 ok");
				else if (/^EHLO/.test(line)) {
					const caps = ["250-test", ...(tlsOpts && !implicit && !sock.encrypted ? ["250-STARTTLS"] : []), `250 AUTH ${auth}`];
					sock.write(caps.join("\r\n") + "\r\n");
				} else if (line === "STARTTLS") {
					say("220 go ahead");
					sock.removeListener("data", onData);
					sock = new tls.TLSSocket(sock, { isServer: true, ...tlsOpts });
					sock.setEncoding("utf8");
					sock.on("data", onData);
				} else if (/^AUTH PLAIN /.test(line)) {
					const [, user, pass] = Buffer.from(line.slice(11), "base64").toString().split("\0");
					log.authed = { user, pass };
					say(pass === "secret" ? "235 ok" : "535 bad credentials");
				} else if (line === "AUTH LOGIN") (loginStep = 1), say("334 VXNlcm5hbWU6");
				else if (/^MAIL FROM:/.test(line) || /^RCPT TO:/.test(line)) say("250 ok");
				else if (line === "DATA") (inData = true), say("354 go");
				else if (line === "QUIT") say("221 bye"), sock.end();
				else say("500 what");
			}
		};
		sock.setEncoding("utf8");
		sock.on("data", onData);
		sock.on("error", () => {});
		say("220 test ESMTP");
	};
	const server = implicit ? tls.createServer(tlsOpts, handle) : net.createServer(handle);
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, log, port: server.address().port })));
}

function selfSignedCert() {
	try {
		const dir = mkdtempSync(path.join(os.tmpdir(), "smtp-test-"));
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`], { stdio: "ignore" });
		return { key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) };
	} catch {
		return null;
	}
}

const message = () =>
	buildMessage({
		from: "billing@example.com",
		fromName: "Maple & Co",
		to: ["zoe@example.com"],
		cc: ["cc@example.com"],
		bcc: ["me@example.com"],
		subject: "Invoice INV-0001 – Zoë",
		text: "Hello\n.leading dot line\n",
		html: "<p>Hello</p>",
		attachments: [{ filename: "Invoice-INV-0001.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 test") }],
	});

test("address lists and headers", () => {
	assert.deepEqual(parseAddressList("a@x.com, b@y.org; a@x.com"), ["a@x.com", "b@y.org"]);
	assert.deepEqual(parseAddressList(""), []);
	assert.throws(() => parseAddressList("a@x.com, nope"), /"nope"/);
	assert.throws(() => parseAddressList("a@x.com\r\nBcc: evil@x.com"), RangeError);
	assert.equal(encodeHeader("Plain"), "Plain");
	assert.match(encodeHeader("Zoë"), /^=\?UTF-8\?B\?/);
	assert.equal(formatAddress("Maple, Inc.", "a@x.com"), '"Maple, Inc." <a@x.com>');
	assert.equal(formatAddress("Bob", "a@x.com"), "Bob <a@x.com>");
});

test("message: bcc only in the envelope, attachment encoded", () => {
	const m = message();
	assert.deepEqual(m.recipients, ["zoe@example.com", "cc@example.com", "me@example.com"]);
	assert.ok(!/^Bcc:/im.test(m.raw));
	assert.ok(!m.raw.includes("me@example.com"));
	assert.match(m.raw, /Content-Disposition: attachment; filename="Invoice-INV-0001.pdf"/);
	assert.ok(m.raw.includes(Buffer.from("%PDF-1.4 test").toString("base64")));
	assert.ok(m.raw.split("\r\n").every((l) => l.length <= 998));
});

test("sends with AUTH PLAIN over a plain connection", async () => {
	const { server, log, port } = await fakeServer();
	try {
		const m = message();
		const reply = await sendMail({ host: "127.0.0.1", port, security: "none", username: "billing@example.com", password: "secret" }, { from: "billing@example.com", ...m });
		assert.match(reply, /queued as TEST123/);
		assert.deepEqual(log.authed, { user: "billing@example.com", pass: "secret" });
		assert.deepEqual(log.commands.filter((c) => c.startsWith("RCPT")), ["RCPT TO:<zoe@example.com>", "RCPT TO:<cc@example.com>", "RCPT TO:<me@example.com>"]);
		assert.ok(log.data.includes("Subject: =?UTF-8?B?"));
	} finally {
		server.close();
	}
});

test("AUTH LOGIN when PLAIN isn't offered; wrong password is reported", async () => {
	const { server, log, port } = await fakeServer({ auth: "LOGIN" });
	try {
		await sendMail({ host: "127.0.0.1", port, security: "none", username: "u", password: "p" }, { from: "a@x.com", ...message() });
		assert.deepEqual(log.authed, { user: "u", pass: "p" });
	} finally {
		server.close();
	}
	const s2 = await fakeServer({ auth: "PLAIN" });
	try {
		await assert.rejects(sendMail({ host: "127.0.0.1", port: s2.port, security: "none", username: "u", password: "wrong" }, { from: "a@x.com", ...message() }), /AUTH \(login\) failed: 535/);
		assert.ok(!s2.log.commands.some((c) => c.includes("wrong")));
	} finally {
		s2.server.close();
	}
});

test("dot-stuffing keeps lines that start with a dot", async () => {
	const { server, log, port } = await fakeServer();
	try {
		const raw = "Subject: x\r\n\r\nline\r\n.hidden\r\n..two\r\n";
		await sendMail({ host: "127.0.0.1", port, security: "none" }, { from: "a@x.com", recipients: ["b@x.com"], raw });
		assert.ok(log.data.includes("\r\n..hidden\r\n...two\r\n"));
	} finally {
		server.close();
	}
});

const cert = selfSignedCert();

test("STARTTLS and implicit TLS", { skip: !cert && "openssl not available" }, async () => {
	for (const implicit of [false, true]) {
		const { server, log, port } = await fakeServer({ tlsOpts: cert, implicit });
		try {
			await sendMail(
				{ host: "localhost", port, security: implicit ? "tls" : "starttls", username: "u", password: "secret" },
				{ from: "a@x.com", ...message() },
				{ rejectUnauthorized: false },
			);
			if (!implicit) assert.ok(log.commands.includes("STARTTLS"));
			assert.equal(log.authed.pass, "secret");
			assert.ok(log.data);
		} finally {
			server.close();
		}
	}
	// The self-signed certificate is refused by default.
	const { server, port } = await fakeServer({ tlsOpts: cert, implicit: true });
	try {
		await assert.rejects(sendMail({ host: "localhost", port, security: "tls" }, { from: "a@x.com", ...message() }), /self-signed|certificate/i);
	} finally {
		server.close();
	}
});

test("connection errors are reported, not thrown raw", async () => {
	await assert.rejects(sendMail({ host: "127.0.0.1", port: 1, security: "none" }, { from: "a@x.com", recipients: ["b@x.com"], raw: "x" }), /could not connect/);
	await assert.rejects(sendMail({ host: "", port: 25 }, { from: "a@x.com", recipients: ["b@x.com"], raw: "x" }), /no mail server/);
});
