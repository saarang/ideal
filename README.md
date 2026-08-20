# Ideal Uniforms — stock register

A cloud inventory and stock-control system for a school-uniform shop in New Panvel.
Photos of papers — supplier challans, GST bills, the aavak vahi (inward register),
your own delivery challans — are sent to a Telegram group. The system reads them,
checks the arithmetic, asks a person whenever it is unsure, and keeps an
append-only stock ledger that can always be traced back to the paper it came from.

It is built for a shop that runs on handwriting. Nothing is ever guessed silently:
where the reading is uncertain, the raw text is kept, a proposal is recorded with a
confidence, and a task is raised for someone to confirm.

---

## The one rule that matters most

On these papers **"28/5" means size 28, quantity 5** — never twenty-eight divided by
five. But **"12/14" and "28/32" are single composite sizes**. The system decides
between the two using the item's own size list, a configurable list of composite
sizes, the column layout, and whether the value was written stacked like a fraction.
When it still cannot tell, it says so and asks.

See `docs/BUSINESS_RULES.md` for the full set of rules, and
`tests/sizeNotation.test.ts` for the behaviour as executable examples.

---

## Quickstart (local)

Requires Node 20+ and PostgreSQL 14+.

```bash
# 1. Database
createdb ideal_uniforms
createdb ideal_uniforms_test        # only needed to run the tests

# 2. Configuration
cp .env.example .env                # then edit DATABASE_URL at least

# 3. Install, migrate, seed
npm install
npm run migrate
npm run seed:core                   # locations, settings, first admin login

# 4. Run
npm run dev                         # http://localhost:3000
npm run worker                      # second terminal: processes queued papers
```

Sign in with the login printed by `seed:core`
(`admin@ideal.local` / `admin123` unless overridden — **change it after first login**).

### See it working with sample data

```bash
npm run seed:demo
```

This creates four suppliers, a customer, an item master, opening stock, two purchase
orders, and pushes five sample papers through the whole pipeline. Afterwards you can
walk through the system as the shop would:

| Where | What you will see |
|---|---|
| Dashboard | Stock totals, open findings, tasks waiting |
| Documents | Five papers: one ready to post, the rest asking questions |
| DOC → Sanjay bill | GST arithmetic recomputed; two lines held back because sizes 20 and 22 are not on that item's size list |
| DOC → Ideal→Jaan challan | Ready to post; posting it takes 204 pieces out of the shop |
| DOC → Sarda challan | Faint Marathi lines flagged for review rather than guessed |
| DOC → aavak vahi pages | An unclear fraction row queued for confirmation |
| Mapping | Supplier wordings waiting to be taught, with suggestions |
| Findings | Overdue orders, an invoice with no challan |
| Reports | Ten reports, each downloadable as CSV |
| Telegram simulator | Send a photo through the real intake path (needs `DEV_TOOLS=1`) |

Clear it again from **Settings → Clear demo data**. Real data is untouched.

---

## Tests

```bash
npm test
```

76 tests against a real PostgreSQL database (`ideal_uniforms_test`), covering the
size/quantity parser, GST arithmetic on the real Sanjay Dresses bill, ledger
immutability and idempotency, reconciliation and the no-double-count rule, POS
import deduplication, the intake pipeline, and one test per acceptance scenario in
`tests/acceptance.test.ts`.

---

## What is real and what is mocked

Everything in this repository is working code against a real database. Two external
services are behind adapters and default to a mock implementation, because they
cannot be reached from the build environment:

- **AI reading of photos** (`AI_PROVIDER`) — `mock` replays deterministic fixtures
  for the five sample papers; `anthropic` calls the real vision API. The interface,
  the JSON schema, validation, and every downstream stage are identical either way.
- **Telegram** (`TELEGRAM_MODE`) — `mock` writes outgoing messages to the
  `telegram_outbox` table and reads files from local paths; `real` talks to
  api.telegram.org. The webhook route, the long-polling script, caption tags, album
  grouping and duplicate detection are all real code.

Switching either to the real service is configuration, not a rewrite. See
`docs/DEPLOYMENT.md`.

---

## Documentation

| File | What it covers |
|---|---|
| `docs/DEPLOYMENT.md` | Going live: hosting, database, storage, Telegram bot, cron |
| `docs/ARCHITECTURE.md` | How it fits together, with the data model |
| `docs/BUSINESS_RULES.md` | Every rule the system applies, in plain language |
| `docs/OPERATIONS.md` | Day-to-day running: the daily loop, month-end, troubleshooting |
| `docs/API.md` | The HTTP endpoints |
| `docs/ASSUMPTIONS.md` | What was assumed where the specification was silent |
| `docs/LIMITATIONS.md` | What this does not do yet, honestly |
| `docs/NEXT_STEPS.md` | Suggested order of work from here |

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run migrate` | Apply SQL migrations |
| `npm run seed:core` | Locations, settings, first admin |
| `npm run seed:demo` | Sample data walkthrough |
| `npm run worker` | Background processing loop |
| `npm run telegram:poll` | Telegram long-polling (no public URL needed) |
| `npm run user:create` | Add a login from the command line |
| `npm test` | Test suite |
