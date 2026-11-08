---
name: ledger-module
description: Work on this Ledger module (a plugin for the Ledger bookkeeping app, installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
---

# Working on this Ledger module

This repository is a **Ledger module**: `ledger-module.json` (manifest),
`server.mjs` (runs inside the Ledger server), `ui/` (its page in Ledger) and
`migrations/` (SQL in its own schema). Ledger installs the latest GitHub
Release of this repository. Ledger itself is
[mastifdogo/Bookeeping](https://github.com/mastifdogo/Bookeeping).

## 1. Get a Ledger checkout and read the module API

The API reference and the full workflow live in the Ledger repository.

- Use `$LEDGER_DIR`, a sibling checkout (`../Accounting`, `../Bookeeping`),
  or clone one: `git clone --depth 1 https://github.com/mastifdogo/Bookeeping /tmp/ledger-for-modules`
  (`scripts/check.sh` does this for you).
- Read **`<ledger>/docs/MODULE_LLM_CONTEXT.md`** in full before changing
  anything: manifest, `ctx` API and return shapes, `ctx.settings`,
  `ctx.dashboard`, `ctx.llm`, `ctx.gmail`, `ctx.search`, roles, migrations,
  UI and security rules.
- Then follow **`<ledger>/.claude/skills/ledger-module/SKILL.md`** (design
  rules, implementation rules, checks, publishing). Treat this repository as
  the module directory it talks about. Where the docs and Ledger's code
  disagree, the code wins (`backend/src/module-host.ts`, `modules.ts`,
  `module-settings.ts`).

Set `"ledger": ">=x.y.z"` in the manifest to the oldest Ledger with every
feature the module uses (the context file says which version added what;
`git -C <ledger> describe --tags --abbrev=0` is the latest release).

## 2. Rules that bite

- No npm packages at runtime: Ledger installs the release as-is. Only
  `node:*` built-ins, global `fetch`, and this repo's own files. (A
  `package.json` here is only for running tests.)
- Never edit a released migration; add the next `NNN_name.sql`.
- Money is integer cents per currency; post to the books only with
  `ctx.ledger.createJournalEntry(entry, req.user)`, with `links` to the
  record it came from (Ledger ≥ 0.11.2).
- AI goes through `ctx.llm` and Gmail through `ctx.gmail` (Ledger ≥ 0.10.0):
  no API keys, OAuth, IMAP or Apps Script bridges of the module's own for
  those. The admin allows the module under Settings → LLM API / Gmail.
- Bad input answers 4xx (`throw new ctx.HttpError(422, "…")`), never 500.

## 3. Check before saying it works

```sh
npm test                      # this repo's own tests, if package.json has them
(pg_isready || service postgresql start) >/dev/null
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  sh .claude/skills/ledger-module/scripts/check.sh
```

`check.sh` runs Ledger's checker on this repo: manifest, files, imports,
migrations, then the module loaded into a real Ledger on a scratch database
(every GET route, POST `{}` must give 4xx, UI, settings). Add `--serve 8098`
to keep it running and test the real flows with `curl` and Playwright (it
prints the session cookie). If PostgreSQL has no password yet:
`runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'postgres'"`.

## 4. Release (only when the user asks)

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on this module.** Push only to this repository. If the module needs
a change in Ledger (a bug fix, a new `ctx` feature, a docs or checker fix),
make it in a local Ledger checkout, tell the user what it is and why, and
leave pushing it to them. The module must work without that change.

1. Bump `version` in `ledger-module.json` (and note the change in the README).
2. Commit, tag `v<version>`, push the tag, and create a GitHub Release from
   it (not a draft or pre-release). If tags or releases can't be created from
   this session, tell the user which commit to release in GitHub's web UI.
3. Ledger installs it on its update schedule or with "Update modules now"
   (Settings → Modules).

## This module: Sales (`id: sales`, schema `mod_sales`)

Invoices, quotes and estimates with GST and other sales taxes, customers,
and sales categories that map to revenue accounts; PDFs; posts invoices and
payments to the books.

- Layout: `server.mjs` registers the route files in `server/` (`catalog`,
  `customers`, `documents`, `email`, `settings`, `search`, `dashboard`,
  `move-settings`, `common`); `lib/` has `money.mjs`, `pdf.mjs` (PDF
  generation, no dependencies) and `mail.mjs` (its own SMTP client). Tests:
  `test/*.test.mjs` (`npm test`).
- Needs Ledger ≥ 0.11.2. Every entry Sales posts carries the link
  `invoice:<id>` ("Invoice INV-1 · Acme", opening `/apps/sales?open=invoices/<id>`);
  reversals and matched bank deposits get it with `linkJournalEntry`
  (`linkEntry()` in `documents.mjs`, which logs instead of failing), and a
  removed matched payment unlinks its deposit.
- Settings are the manifest's `settings.fields`
  (Ledger's form under Settings → Sales), read through `loadSettings()` in
  `server/common.mjs`. What a form can't hold (taxes, next document numbers,
  the email check) is `ui/setup.html`, shown under the form. The module's
  own `settings` table now only keeps the running numbers; values from
  before 0.2.0 are copied into Ledger's form once (`move-settings.mjs`).
- Email: `ctx.gmail.send()` by default (an admin allows Sales under
  Settings → Gmail), the module's own SMTP client when the user chooses it.
- Taxes, categories and numbering are admin-only (`requireAdmin`).
- Payments: `server/payments.mjs` (receive payment over open invoices;
  deposit matching with rules, then `ctx.llm.json` with every answer checked
  against real balances). Matches are stored in `payment_suggestions`
  (pending → applied/rejected, with who decided) and act only when a person
  applies them from the Payments tab, possibly with changed amounts: AI only
  proposes. A rejected deposit isn't suggested again. Both go through `recordPayment` / `deletePayment`
  in `documents.mjs`. A matched deposit is linked (`matched_entry_id`); Sales
  posts only a move from the deposit's credit account to receivable.
- Organizations: documents and `ctx.settings` are per organization (Ledger
  ≥ 0.11.1). Background work (dashboard sync, startup recovery, the one-time
  settings copy) runs through `ctx.orgs.forEach`; a change syncs only its
  own organization.
- Search (`ctx.search.provide`) and dashboard items link to
  `/apps/sales?open=<route>`; the page turns `?open=` into its hash route.
  Ledger forwards the query string to the page (0.10.1 and later).
- Known follow-ups:
  - `nav.icon` is `hammer` because the user asked for it; keep it.
