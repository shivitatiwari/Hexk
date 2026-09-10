# Hexk — MellowKraft Email Tracker

Small self-hosted email engagement tracker for individual outbound sales emails.

**Runtime:** Cloudflare Workers  
**Storage:** Cloudflare D1  
**Dashboard:** Worker Static Assets  
**Intended custom domain:** `track.apoorv.sbs`

Hexk records raw open/click telemetry, keeps a separate de-duplicated "likely human open" count, stores Gmail message/thread IDs after sending, and exposes both an authenticated admin API and a read-only agent API.

## What V1 includes

- Unique cryptographically random `mk_*` tracking IDs
- `GET /o/:tracking_id.gif` 1×1 transparent tracking pixel
- `GET /c/:tracking_id/:link_id` safe tracked redirects
- Cloudflare D1 schema for emails, links, events, and lightweight rate limits
- Basic proxy/security-scanner classification
- Raw opens + de-duplicated likely-human opens
- Click, reply, bounce, and Gmail message/thread association
- Authenticated JSON admin API
- Read-only `/agent/*` API intended for the Revenue Operator / ChatGPT-assisted workflows
- Minimal same-origin dashboard
- Email preparation helper that rewrites selected HTML links and injects the pixel

Open tracking is inherently imperfect. Google/Apple proxies and security scanners can hide or manufacture image requests. Hexk therefore treats tracking as supporting evidence rather than proof that a person read a message.

## Prerequisites

1. Node.js 20+.
2. A Cloudflare account with `apoorv.sbs` active if you want the custom domain.
3. Wrangler authenticated to the Cloudflare account.
4. A D1 database.

Install dependencies:

```bash
npm install
```

Authenticate Wrangler if needed:

```bash
npx wrangler login
```

## 1. Create D1

```bash
npx wrangler d1 create mellowkraft-email-tracker --location apac
```

Cloudflare prints a database UUID. Replace this placeholder in `wrangler.jsonc`:

```text
00000000-0000-0000-0000-000000000000
```

with the real UUID.

Apply the migration remotely:

```bash
npm run db:migrate:remote
```

For local development:

```bash
npm run db:migrate:local
```

## 2. Configure secrets

Generate two different long random secrets. Do not commit them.

```bash
npx wrangler secret put TRACKER_API_KEY
npx wrangler secret put AGENT_READ_TOKEN
```

Secret purposes:

- `TRACKER_API_KEY` — full `/api/*` administration access.
- `AGENT_READ_TOKEN` — read-only `/agent/*` access for later automated/assistant inspection.

Optional non-secret variable:

- `ALLOWED_ORIGIN` — one additional browser origin allowed to call `/api/*`. Same-origin dashboard calls work without it.

## 3. Check locally

```bash
npm run check
npm run dev
```

The local dashboard will be on the URL printed by Wrangler.

## 4. Deploy Worker

```bash
npm run deploy
```

The first deploy can use the generated `*.workers.dev` hostname.

Test:

```bash
curl https://YOUR-WORKER.workers.dev/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "hexk-email-tracker",
  "database": "reachable"
}
```

## 5. Attach `track.apoorv.sbs`

Once the Worker works, either add the custom domain in Cloudflare Dashboard:

**Workers & Pages → your Worker → Settings → Domains & Routes → Add → Custom Domain**

and enter:

```text
track.apoorv.sbs
```

or replace the `routes` array in `wrangler.jsonc` and redeploy:

```jsonc
"routes": [
  { "pattern": "track.apoorv.sbs", "custom_domain": true }
]
```

Do this only when the hostname does not already have a conflicting DNS record.

## 6. Connect GitHub to Cloudflare Builds

Repository:

```text
shivitatiwari/Hexk
```

Cloudflare build settings can use:

```text
Build command: npm run check
Deploy command: npm run deploy
```

The D1 binding and secrets must exist in the Cloudflare Worker environment before an automatic production deploy can succeed.

## Quick API example

Create a tracked email:

```bash
curl -X POST 'https://track.apoorv.sbs/api/emails' \
  -H "Authorization: Bearer $TRACKER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "prospect_name":"Jane Doe",
    "company_name":"Example AI",
    "recipient_email":"jane@example.ai",
    "subject":"cost per successful workflow",
    "campaign":"mellowkraft"
  }'
```

See [`docs/API.md`](docs/API.md) for the complete API.

## Prepare an HTML email in one request

`POST /api/prepare` is the integration helper. It:

1. creates the tracked email,
2. creates the selected tracked links,
3. rewrites matching `href` attributes,
4. injects the 1×1 pixel,
5. returns the modified HTML.

It takes fields including:

```text
recipient_email
company_name
prospect_name
subject
html_body
links[]
```

and returns:

```text
tracking_id
pixel_url
html_body
tracked_links[]
```

The outbound sender should still create a normal `text/plain` MIME fallback using direct, untracked URLs.

## Read-only agent endpoint

The special read surface exists so a Revenue Operator or assistant can inspect engagement without receiving the full admin credential.

```text
GET /agent/recent?token=AGENT_READ_TOKEN
GET /agent/emails/:tracking_id?token=AGENT_READ_TOKEN
```

`X-Agent-Token: ...` is also supported and is preferable when the HTTP client can set headers. Query-string tokens are intentionally supported because some simple retrieval clients cannot set custom headers; they are less private because URLs may appear in request logs/history.

Do not put `AGENT_READ_TOKEN` in GitHub. If a later ChatGPT session needs direct web access, provide the read-only endpoint/token at that time rather than the admin key.

## Dashboard

Open the Worker root. The dashboard asks for `TRACKER_API_KEY` and stores it only in browser `sessionStorage`. It displays no prospect data without the authenticated API.

This is deliberately lightweight authentication, not a multi-user identity system.

## Event interpretation

Priority returned by the API is:

```text
reply > click > multiple likely-human opens > one likely-human open > no open
```

Engagement labels are:

```text
unknown
unengaged
opened
warm
high_intent
replied
bounced
```

A non-open is **not** proof that the message was unseen.

## Reliability behavior

- Pixel endpoint always returns the transparent GIF even if event persistence fails.
- Unknown pixel IDs return the same transparent GIF.
- A click redirects only after its tracking/link pair resolves to a stored `http` or `https` destination.
- Click telemetry is written asynchronously after the destination is resolved.
- Raw IP addresses are never written to D1; a salted SHA-256 derivative is stored instead.
- Repeated likely-human opens from the same hashed IP + UA within ten minutes remain raw events but do not increment `human_open_count` again.

## Files

```text
src/index.js                 Worker/API/tracking logic
public/                      Static dashboard
migrations/0001_init.sql     D1 schema
scripts/smoke.sh             End-to-end deployed smoke test
docs/API.md                  Full API reference
docs/REVENUE_OPERATOR.md     Gmail/Revenue Operator workflow
wrangler.jsonc               Cloudflare configuration
```
