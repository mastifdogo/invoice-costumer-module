// Sending mail over SMTP with no dependencies: implicit TLS (port 465),
// STARTTLS (587) or plain (25, e.g. a local relay), AUTH PLAIN or LOGIN,
// and a MIME message with a text part, an HTML part and attachments.

import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export const isEmail = (s) => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);

/** "a@x.com, b@y.com; c@z.com" → ["a@x.com", ...]; throws RangeError naming the first bad address. */
export function parseAddressList(s) {
	const list = String(s ?? "")
		.split(/[,;\s]+/)
		.map((x) => x.trim())
		.filter(Boolean);
	for (const a of list) if (!isEmail(a)) throw new RangeError(`"${a}" is not a valid email address`);
	return [...new Set(list)];
}

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** A header value safe to send: RFC 2047 encoded when it isn't plain ASCII. */
export function encodeHeader(s) {
	s = String(s).replace(/[\r\n]+/g, " ");
	if (isAscii(s)) return s;
	// Encode in chunks of whole characters so no encoded word exceeds the line limit.
	const words = [];
	let chunk = "";
	for (const ch of s) {
		if (Buffer.byteLength(chunk + ch) > 45) words.push(chunk), (chunk = "");
		chunk += ch;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

/** "Name <addr>" with the name quoted or encoded as needed. */
export function formatAddress(name, email) {
	if (!name) return `<${email}>`;
	const n = String(name).replace(/[\r\n]+/g, " ");
	if (!isAscii(n)) return `${encodeHeader(n)} <${email}>`;
	return /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(n) ? `${n} <${email}>` : `"${n.replace(/["\\]/g, "\\$&")}" <${email}>`;
}

const base64Lines = (buf) => buf.toString("base64").replace(/.{76}/g, "$&\r\n");

/**
 * Builds a MIME message. Returns the raw message (CRLF line endings) and the
 * envelope recipients (to + cc + bcc; bcc never appears in the headers).
 */
export function buildMessage({ from, fromName, to, cc = [], bcc = [], replyTo, subject, text, html, attachments = [], date = new Date() }) {
	const domain = from.split("@")[1] || "localhost";
	const boundary = (tag) => `=_${tag}_${crypto.randomBytes(12).toString("hex")}`;
	const mixed = boundary("mixed");
	const alt = boundary("alt");
	const headers = [
		`From: ${formatAddress(fromName, from)}`,
		`To: ${to.map((a) => `<${a}>`).join(", ")}`,
		...(cc.length ? [`Cc: ${cc.map((a) => `<${a}>`).join(", ")}`] : []),
		...(replyTo ? [`Reply-To: <${replyTo}>`] : []),
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${date.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${crypto.randomUUID()}@${domain}>`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${mixed}"`,
	];
	const parts = [
		`--${mixed}`,
		`Content-Type: multipart/alternative; boundary="${alt}"`,
		"",
		`--${alt}`,
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(Buffer.from(text)),
	];
	if (html) parts.push(`--${alt}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(html)));
	parts.push(`--${alt}--`);
	for (const a of attachments) {
		const name = String(a.filename).replace(/["\r\n\\]/g, "_");
		parts.push(
			`--${mixed}`,
			`Content-Type: ${a.contentType}; name="${name}"`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: attachment; filename="${name}"`,
			"",
			base64Lines(a.content),
		);
	}
	parts.push(`--${mixed}--`, "");
	return { raw: headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n"), recipients: [...new Set([...to, ...cc, ...bcc])] };
}

export class SmtpError extends Error {}

/** One SMTP conversation. Reads replies as they arrive; works across the STARTTLS upgrade. */
class Connection {
	constructor(socket, timeoutMs) {
		this.timeoutMs = timeoutMs;
		this.buf = "";
		this.lines = [];
		this.waiting = null;
		this.failure = null;
		this.attach(socket);
	}

	attach(socket) {
		if (this.socket) this.socket.removeAllListeners("data").removeAllListeners("error").removeAllListeners("close");
		this.socket = socket;
		// Nothing read before a STARTTLS upgrade may be trusted afterwards.
		this.buf = "";
		this.lines = [];
		socket.setEncoding("utf8");
		socket.on("data", (d) => {
			this.buf += d;
			let i;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				this.lines.push(this.buf.slice(0, i).replace(/\r$/, ""));
				this.buf = this.buf.slice(i + 1);
			}
			this.wake();
		});
		socket.on("error", (e) => this.fail(new SmtpError(e.message)));
		socket.on("close", () => this.fail(new SmtpError("the mail server closed the connection")));
	}

	fail(err) {
		this.failure ??= err;
		this.wake();
	}

	wake() {
		const w = this.waiting;
		this.waiting = null;
		w?.();
	}

	/** The next complete reply: { code, lines }. */
	async reply() {
		const deadline = Date.now() + this.timeoutMs;
		for (;;) {
			const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
			if (end >= 0) {
				const lines = this.lines.splice(0, end + 1);
				return { code: Number(lines[end].slice(0, 3)), lines: lines.map((l) => l.slice(4)) };
			}
			if (this.failure) throw this.failure;
			const left = deadline - Date.now();
			if (left <= 0) throw new SmtpError("the mail server did not answer in time");
			await new Promise((resolve) => {
				const t = setTimeout(resolve, left);
				this.waiting = () => (clearTimeout(t), resolve());
			});
		}
	}

	/** Sends a command (unless null) and checks the reply code. `shown` replaces it in errors (for secrets). */
	async cmd(line, expect, shown = line) {
		if (line !== null) this.socket.write(line + "\r\n");
		const r = await this.reply();
		if (!expect.includes(r.code)) {
			const what = shown === null ? "greeting" : shown === line ? line.split(" ")[0] : shown;
			throw new SmtpError(`${what} failed: ${r.code} ${r.lines.join(" ")}`.trim());
		}
		return r;
	}

	close() {
		this.socket.removeAllListeners("close");
		this.socket.on("error", () => {});
		this.socket.end();
		this.socket.destroy();
	}
}

function connect({ host, port, security, rejectUnauthorized }, timeoutMs) {
	return new Promise((resolve, reject) => {
		const opts = { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized };
		const socket = security === "tls" ? tls.connect(opts) : net.connect({ host, port });
		const timer = setTimeout(() => (socket.destroy(), reject(new SmtpError(`could not connect to ${host}:${port} in time`))), timeoutMs);
		socket.once(security === "tls" ? "secureConnect" : "connect", () => (clearTimeout(timer), socket.removeAllListeners("error"), resolve(socket)));
		socket.once("error", (e) => (clearTimeout(timer), reject(new SmtpError(`could not connect to ${host}:${port}: ${e.message}`))));
	});
}

function upgrade(socket, host, rejectUnauthorized, timeoutMs) {
	return new Promise((resolve, reject) => {
		socket.removeAllListeners("data").removeAllListeners("error").removeAllListeners("close");
		const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized });
		const timer = setTimeout(() => (s.destroy(), reject(new SmtpError("TLS handshake timed out"))), timeoutMs);
		s.once("secureConnect", () => (clearTimeout(timer), s.removeAllListeners("error"), resolve(s)));
		s.once("error", (e) => (clearTimeout(timer), reject(new SmtpError(`TLS failed: ${e.message}`))));
	});
}

/**
 * Sends one message. `server` is { host, port, security: "tls"|"starttls"|"none",
 * username, password }. Resolves with the server's final reply text.
 */
export async function sendMail(server, { from, recipients, raw }, { timeoutMs = 30_000, rejectUnauthorized = true } = {}) {
	if (!server.host) throw new SmtpError("no mail server is configured (Settings → Email)");
	if (recipients.length === 0) throw new SmtpError("no recipients");
	const opts = { ...server, rejectUnauthorized };
	const c = new Connection(await connect(opts, timeoutMs), timeoutMs);
	try {
		await c.cmd(null, [220]);
		const name = os.hostname() || "localhost";
		let ehlo = await c.cmd(`EHLO ${name}`, [250]);
		if (server.security === "starttls") {
			if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError("the mail server does not offer STARTTLS; try security \"TLS\" (port 465)");
			await c.cmd("STARTTLS", [220]);
			c.attach(await upgrade(c.socket, server.host, rejectUnauthorized, timeoutMs));
			ehlo = await c.cmd(`EHLO ${name}`, [250]);
		}
		if (server.username) {
			const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l))?.toUpperCase() ?? "";
			const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
			if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
				await c.cmd(`AUTH PLAIN ${b64(`\0${server.username}\0${server.password}`)}`, [235], "AUTH (login)");
			} else {
				await c.cmd("AUTH LOGIN", [334]);
				await c.cmd(b64(server.username), [334], "AUTH (username)");
				await c.cmd(b64(server.password), [235], "AUTH (password)");
			}
		}
		await c.cmd(`MAIL FROM:<${from}>`, [250]);
		for (const r of recipients) await c.cmd(`RCPT TO:<${r}>`, [250, 251]);
		await c.cmd("DATA", [354]);
		// Dot-stuffing: a line starting with "." gets another one.
		const body = raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
		const done = await c.cmd(body + (body.endsWith("\r\n") ? "" : "\r\n") + ".", [250], "DATA (message)");
		await c.cmd("QUIT", [221]).catch(() => {});
		return done.lines.join(" ");
	} finally {
		c.close();
	}
}
