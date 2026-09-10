# Revenue Operator Integration

## Per-email send flow

```text
choose prospect
  ↓
POST /api/prepare
  ↓
receive tracking_id + modified HTML + tracked URLs
  ↓
create text/plain fallback with direct links
  ↓
send via Gmail
  ↓
receive Gmail message/thread IDs
  ↓
POST /api/emails/:tracking_id/sent
```

Each outbound message receives a separate tracking ID even when it belongs to an existing Gmail thread.

## Before a Revenue Operator run

1. Check Gmail for replies and bounce notifications.
2. For every reply/bounce, update Hexk using `/reply` or `/bounce`.
3. Query `/agent/recent` or `/api/emails` for recent tracking engagement.
4. Use the order below for prioritization:

```text
reply
  > click
  > multiple likely-human opens
  > single likely-human open
  > no open
```

5. Treat tracking as supporting evidence only. Never send an extra message solely because a pixel fired.

## Useful agent queries

High-value unreplied clicks:

```text
GET /agent/recent?clicked=true&replied=false&token=...
```

All unreplied tracked messages that produced any raw open:

```text
GET /agent/recent?opened=true&replied=false&token=...
```

One prospect timeline:

```text
GET /agent/emails/mk_TRACKING_ID?token=...
```

## Google Drive summary shape

Keep D1 as the telemetry source of truth. A prospect file only needs a summary such as:

```markdown
## Email Engagement

Tracking ID: mk_...
Sent: 10 Sep 2026 18:10 IST
First likely human open: 10 Sep 2026 18:42 IST
Last likely human open: 10 Sep 2026 19:01 IST
Likely human opens: 2
Raw opens: 5
Clicks: 1
Reply: No
Bounce: No
Engagement classification: High intent
```

## Gmail synchronization

V1 intentionally does not poll Gmail by itself. The Revenue Operator can use the existing Gmail connector to detect replies/bounces and then call the authenticated Hexk state endpoints.
