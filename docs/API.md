# Hexk API

## Base URL

Production target:

```text
https://track.apoorv.sbs
```

During first deployment, use the assigned `*.workers.dev` origin instead.

## Authentication

Every `/api/*` request uses:

```http
Authorization: Bearer <TRACKER_API_KEY>
```

The read-only agent surface uses either:

```http
X-Agent-Token: <AGENT_READ_TOKEN>
```

or, for clients that cannot set headers:

```text
?token=<AGENT_READ_TOKEN>
```

Public `/o/*`, `/c/*`, and `/health` routes do not use admin authentication.

---

## `GET /health`

Basic public service/DB health check. Does not expose prospect data.

---

## `POST /api/emails`

Create one tracking identity for one outbound message.

Request:

```json
{
  "prospect_name": "Jane Doe",
  "company_name": "Example AI",
  "recipient_email": "jane@example.ai",
  "subject": "cost per successful workflow",
  "campaign": "mellowkraft"
}
```

Response:

```json
{
  "tracking_id": "mk_...",
  "pixel_url": "https://track.apoorv.sbs/o/mk_....gif",
  "campaign": "mellowkraft",
  "created_at": "2026-09-10T14:30:00.000Z"
}
```

A follow-up in the same Gmail thread must create a new tracked email ID.

---

## `POST /api/emails/:tracking_id/links`

Request:

```json
{
  "link_id": "calendar",
  "destination_url": "https://calendar.app.google/example",
  "label": "Calendar"
}
```

`link_id` may be omitted; Hexk will generate one.

Response:

```json
{
  "tracking_id": "mk_...",
  "link_id": "calendar",
  "destination_url": "https://calendar.app.google/example",
  "tracked_url": "https://track.apoorv.sbs/c/mk_.../calendar",
  "label": "Calendar"
}
```

Only stored `http:` and `https:` destinations can be redirected to. The public click URL never accepts a destination parameter.

---

## `POST /api/prepare`

Recommended integration helper for an outbound HTML email.

Request:

```json
{
  "prospect_name": "Jane Doe",
  "company_name": "Example AI",
  "recipient_email": "jane@example.ai",
  "subject": "cost per successful workflow",
  "campaign": "mellowkraft",
  "html_body": "<html><body><p>Hi Jane...</p><a href=\"https://calendar.app.google/example\">Calendar</a></body></html>",
  "links": [
    {
      "link_id": "calendar",
      "url": "https://calendar.app.google/example",
      "label": "Calendar"
    }
  ]
}
```

Response:

```json
{
  "tracking_id": "mk_...",
  "pixel_url": "https://track.apoorv.sbs/o/mk_....gif",
  "tracked_links": [
    {
      "link_id": "calendar",
      "destination_url": "https://calendar.app.google/example",
      "tracked_url": "https://track.apoorv.sbs/c/mk_.../calendar",
      "label": "Calendar"
    }
  ],
  "html_body": "<html>...rewritten href...tracking pixel...</html>",
  "campaign": "mellowkraft",
  "created_at": "2026-09-10T14:30:00.000Z"
}
```

The helper rewrites exact matching `href` attributes for the URLs listed in `links`. It does not crawl or rewrite every URL automatically.

---

## `POST /api/emails/:tracking_id/sent`

Call after Gmail returns the message/thread IDs.

```json
{
  "gmail_message_id": "18f...",
  "gmail_thread_id": "18f...",
  "sent_at": "2026-09-10T14:35:00Z"
}
```

All fields except the tracking ID may be omitted; the current timestamp is used when `sent_at` is absent.

---

## `POST /api/emails/:tracking_id/reply`

```json
{
  "replied_at": "2026-09-10T16:10:00Z",
  "source": "gmail"
}
```

Replies receive the highest engagement priority.

---

## `POST /api/emails/:tracking_id/bounce`

```json
{
  "bounced_at": "2026-09-10T14:36:00Z",
  "source": "gmail"
}
```

---

## `GET /api/emails/:tracking_id`

Returns the full email record, derived engagement summary, tracked links, and chronological event timeline.

Example response shape:

```json
{
  "email": {
    "tracking_id": "mk_...",
    "prospect_name": "Jane Doe",
    "company_name": "Example AI",
    "human_open_count": 2,
    "open_count": 4,
    "click_count": 1,
    "replied": false,
    "bounced": false,
    "engagement": {
      "label": "high_intent",
      "score": 5,
      "priority": 4
    }
  },
  "engagement": {},
  "links": [],
  "events": []
}
```

Event IPs are not returned because raw IPs are never stored. The timeline may include UA, country, colo, classification, confidence, and non-sensitive event metadata.

---

## `GET /api/emails`

Supported query parameters:

```text
opened=true|false
clicked=true|false
replied=true|false
bounced=true|false
company=<substring>
recipient=<substring>
campaign=<exact campaign>
sent_after=<ISO timestamp>
engaged_since=<ISO timestamp>
limit=1..200
offset=<integer>
```

Examples:

```text
/api/emails?clicked=true&replied=false
/api/emails?opened=true&replied=false&campaign=mellowkraft
/api/emails?engaged_since=2026-09-10T00:00:00Z
```

---

## Public tracking routes

### `GET /o/:tracking_id.gif`

Returns a valid transparent GIF with no-cache headers. Unknown tracking IDs return the same image and do not reveal whether the email exists.

### `GET /c/:tracking_id/:link_id`

If the pair exists, records a click asynchronously and sends HTTP 302 to the stored destination. Invalid pairs return 404 and cannot provide a destination URL.

---

## Read-only agent routes

### `GET /agent/recent`

Same list filters as `/api/emails`, with a maximum limit of 100.

Example:

```text
https://track.apoorv.sbs/agent/recent?clicked=true&replied=false&token=...
```

### `GET /agent/emails/:tracking_id`

Returns detail/timeline for a single tracked email without allowing mutation.

For assistant use, prefer the read-only token instead of sharing the full admin key.
