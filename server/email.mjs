// Sending mail with the module's SMTP settings.

import { buildMessage, parseAddressList, sendMail } from "../lib/mail.mjs";

export function mailHelpers(ctx, h) {
	/** Validated recipient list from "a@x, b@y". */
	function addresses(v, field, required) {
		try {
			const list = parseAddressList(v);
			if (required && list.length === 0) throw new RangeError("add at least one recipient");
			if (list.length > 20) throw new RangeError("at most 20 addresses");
			return list;
		} catch (e) {
			throw h.bad(`${field}: ${e.message}`);
		}
	}

	async function deliver(s, { to, cc, bcc, subject, text, html, attachments }) {
		if (!s.smtp_host) throw h.bad("no mail server is set up yet (Settings → Email)");
		if (!s.from_email) throw h.bad("set the sender address in Settings → Email");
		const msg = buildMessage({ from: s.from_email, fromName: s.from_name || s.business_name, to, cc, bcc, replyTo: s.reply_to, subject, text, html, attachments });
		const server = { host: s.smtp_host, port: s.smtp_port, security: s.smtp_security, username: s.smtp_username, password: s.smtp_password };
		return sendMail(server, { from: s.from_email, ...msg });
	}

	return { addresses, deliver };
}
