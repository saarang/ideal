# Deployment

This is a standard Next.js 15 application with a PostgreSQL database and a private
file store. It runs on anything that can host Node — the notes below assume Vercel
plus a managed Postgres, which is the cheapest sensible option for a single shop.

---

## 1. Database

Any PostgreSQL 14 or newer works: Supabase, Neon, Railway, RDS, or a server you own.
Create the database, then apply migrations from your machine:

```bash
DATABASE_URL="postgres://…" npm run migrate
DATABASE_URL="postgres://…" npm run seed:core
```

`seed:core` creates the SHOP and GODOWN locations, every setting the code reads, and
the first admin login. Override the admin credentials:

```bash
SEED_ADMIN_EMAIL="you@example.com" SEED_ADMIN_PASSWORD="…" npm run seed:core
```

The migration runner records applied files in `schema_migrations` and is safe to
re-run. It requires the `pg_trgm` extension, which the first migration creates —
on a managed platform this usually needs no extra permission, but if it fails, run
`CREATE EXTENSION pg_trgm;` once as a superuser.

**Connection pooling.** On serverless platforms use the *pooled* connection string
(Supabase port 6543, Neon's pooler host). Every request opens a short-lived client;
a direct connection will exhaust the server's connection limit.

---

## 2. Application

```bash
npm run build
npm start
```

On Vercel: import the repository, set the environment variables below, deploy.
No build customisation is needed.

### Environment variables

| Variable | Needed | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Pooled connection string |
| `APP_BASE_URL` | yes | e.g. `https://ideal.example.com` — used in Telegram reply links |
| `APP_SECRET` | yes | Random 32+ characters |
| `STORAGE_DRIVER` | yes | `local` or `s3` |
| `DATA_DIR` | local only | Where photos are written |
| `AI_PROVIDER` | yes | `mock` or `anthropic` |
| `ANTHROPIC_API_KEY` | if anthropic | |
| `ANTHROPIC_MODEL` | no | Defaults to a current vision-capable model |
| `TELEGRAM_MODE` | yes | `mock` or `real` |
| `TELEGRAM_BOT_TOKEN` | if real | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | if real | Random string; verified on every update |
| `TELEGRAM_ALLOWED_CHAT_ID` | recommended | Restricts intake to the shop group |
| `JOBS_TICK_SECRET` | if serverless | Protects the cron endpoint |
| `DEV_TOOLS` | no | `1` enables the Telegram simulator — **never in production** |

---

## 3. File storage

Photos are private. They are never publicly addressable; the only read path is
`/api/files/…`, which checks the session first.

**Local disk** (`STORAGE_DRIVER=local`) works on a normal server but **not on
Vercel**, whose filesystem is ephemeral — uploads would vanish between requests.

**Object storage** (`STORAGE_DRIVER=s3`) is the production choice: Supabase Storage,
AWS S3, Cloudflare R2, or any S3-compatible bucket. The adapter interface is three
methods; `src/lib/storage/index.ts` carries a stub with step-by-step instructions
(install `@aws-sdk/client-s3`, implement `put`/`get`/`exists`, set the credentials).
Keep the bucket **private** — the application streams bytes through the authenticated
route rather than handing out URLs.

---

## 4. Telegram bot

1. Message **@BotFather**, `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_MODE=real`.
3. Add the bot to the shop's group. Send any message, then read the chat id from
   `https://api.telegram.org/bot<token>/getUpdates` and put it in
   `TELEGRAM_ALLOWED_CHAT_ID` — without this, anyone who finds the bot can feed
   documents into the system.
4. In BotFather, **disable privacy mode** (`/setprivacy` → Disable) so the bot
   receives group photos.
5. Register the webhook:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?\
url=https://your.app/api/telegram/webhook&\
secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Telegram then sends `X-Telegram-Bot-Api-Secret-Token` with every update, and the
route rejects anything else.

**No public URL?** Run `npm run telegram:poll` instead — it long-polls `getUpdates`
and feeds the same handler. The read offset is stored in the database, so restarts
do not reprocess or skip messages.

Caption tags that shortcut classification: `#bill`, `#challan`, `#inward`,
`#order`, `#ideal_challan`, `#shop_to_godown`, `#godown_to_shop`. Without a tag the
system classifies the photo itself and asks only when unsure.

---

## 5. Background processing

A photo is saved immediately; reading it happens in the background. Pick one:

**Long-running host** (a VPS, Railway, Fly, Render):

```bash
npm run worker
```

Processes queued jobs every few seconds, sends Telegram summaries when a paper is
finished, and runs the reconciliation scans every fifteen minutes.

**Serverless** (Vercel): call the tick endpoint from an external scheduler every
minute.

```
GET https://your.app/api/jobs/tick?secret=<JOBS_TICK_SECRET>
```

`vercel.json`:

```json
{ "crons": [{ "path": "/api/jobs/tick?secret=…", "schedule": "* * * * *" }] }
```

Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so a worker and the cron endpoint
can run at the same time without processing anything twice.

---

## 6. AI reading

`AI_PROVIDER=mock` is the default and needs no network — useful for demos and for
running the shop on already-read documents. For real photographs set
`AI_PROVIDER=anthropic` and supply `ANTHROPIC_API_KEY`.

The provider only ever returns structured JSON: what it read, and how sure it was.
It never does arithmetic and never decides what goes into stock. Totals are
recomputed in `src/lib/domain/arithmetic.ts`, size notation is interpreted in
`src/lib/domain/sizeNotation.ts`, and posting is a separate, explicit step. That
separation is deliberate — swapping the model changes reading quality, never the
books.

Budget roughly one vision call per photo for classification and one for extraction.

---

## 7. After going live

- Change the seeded admin password, then add real logins under **Settings**
  (ADMIN / STAFF / VIEWER).
- Import the item master (**Imports → product list**), then opening stock from a
  physical count.
- Set `negative_stock_policy` under **Settings** — `BLOCK` refuses any posting that
  would take stock below zero, `WARN_ALLOW` records it and raises a finding. Start
  with `BLOCK` only once opening stock is trustworthy; before that `WARN_ALLOW`
  avoids blocking real sales because the books have not caught up.
- Back up the database. The ledger is append-only inside the application, but a
  dropped database is still a dropped database.
