import {
  DEFAULT_PUBLIC_EVENT_RATE_LIMIT,
  HUMAN_DEDUPE_WINDOW_MS,
  classifyEvent,
  consumeRateLimit,
  isAllowedDestination,
  json,
  nowIso,
  parsePositiveInt,
  requestFingerprint,
  secondsSince,
} from './common.js';

const TRANSPARENT_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='),
  (c) => c.charCodeAt(0),
);

const PIXEL_HEADERS = {
  'content-type': 'image/gif',
  'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'x-content-type-options': 'nosniff',
};

export async function handleHealth(env) {
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ ok: true, service: 'hexk-email-tracker', database: 'reachable' });
  } catch (error) {
    return json({ ok: false, service: 'hexk-email-tracker', database: 'unreachable' }, 503);
  }
}

export function handleOpen(request, env, ctx, trackingId) {
  if (request.method === 'GET') {
    ctx.waitUntil(
      recordOpen(request, env, trackingId).catch((error) => {
        console.error('open tracking failed', trackingId, error);
      }),
    );
  }

  return new Response(request.method === 'HEAD' ? null : TRANSPARENT_GIF, {
    status: 200,
    headers: PIXEL_HEADERS,
  });
}

async function recordOpen(request, env, trackingId) {
  const email = await env.DB.prepare(
    'SELECT tracking_id, sent_at FROM emails WHERE tracking_id = ? LIMIT 1',
  )
    .bind(trackingId)
    .first();

  if (!email) return;

  const fingerprint = await requestFingerprint(request, env);
  const limit = parsePositiveInt(env.PUBLIC_EVENT_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_EVENT_RATE_LIMIT);
  const allowed = await consumeRateLimit(env.DB, `open:${trackingId}:${fingerprint.ipHash || 'none'}`, limit, 60);
  if (!allowed) return;

  const now = nowIso();
  const classification = classifyEvent({
    kind: 'open',
    request,
    sentAt: email.sent_at,
  });

  let countsAsHuman = classification.classification === 'human_likely';
  let duplicateLikely = false;

  if (countsAsHuman) {
    const cutoff = new Date(Date.now() - HUMAN_DEDUPE_WINDOW_MS).toISOString();
    const previous = await env.DB.prepare(
      `SELECT id FROM events
       WHERE tracking_id = ?
         AND event_type = 'open'
         AND classification = 'human_likely'
         AND COALESCE(ip_hash, '') = COALESCE(?, '')
         AND COALESCE(user_agent, '') = COALESCE(?, '')
         AND occurred_at >= ?
       LIMIT 1`,
    )
      .bind(trackingId, fingerprint.ipHash, fingerprint.userAgent, cutoff)
      .first();

    if (previous) {
      countsAsHuman = false;
      duplicateLikely = true;
    }
  }

  const metadata = JSON.stringify({
    duplicate_likely: duplicateLikely,
    timing_seconds_after_send: secondsSince(email.sent_at),
  });

  const statements = [
    env.DB.prepare(
      `INSERT INTO events
       (tracking_id, event_type, occurred_at, ip_hash, user_agent, country, colo, referer, classification, confidence, metadata)
       VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      trackingId,
      now,
      fingerprint.ipHash,
      fingerprint.userAgent,
      fingerprint.country,
      fingerprint.colo,
      request.headers.get('referer'),
      classification.classification,
      classification.confidence,
      metadata,
    ),
    env.DB.prepare(
      `UPDATE emails
       SET first_open_at = COALESCE(first_open_at, ?),
           last_open_at = ?,
           open_count = open_count + 1,
           status = CASE
             WHEN status IN ('created','queued','sent','opened') THEN 'opened'
             ELSE status
           END
       WHERE tracking_id = ?`,
    ).bind(now, now, trackingId),
  ];

  if (countsAsHuman) {
    statements.push(
      env.DB.prepare(
        `UPDATE emails
         SET first_human_open_at = COALESCE(first_human_open_at, ?),
             last_human_open_at = ?,
             human_open_count = human_open_count + 1
         WHERE tracking_id = ?`,
      ).bind(now, now, trackingId),
    );
  }

  await env.DB.batch(statements);
}

export async function handleClick(request, env, ctx, trackingId, linkId) {
  let link;
  try {
    link = await env.DB.prepare(
      `SELECT l.destination_url, e.sent_at
       FROM links l
       JOIN emails e ON e.tracking_id = l.tracking_id
       WHERE l.tracking_id = ? AND l.link_id = ?
       LIMIT 1`,
    )
      .bind(trackingId, linkId)
      .first();
  } catch (error) {
    console.error('click destination lookup failed', trackingId, linkId, error);
    return json({ error: 'link_temporarily_unavailable' }, 503);
  }

  if (!link || !isAllowedDestination(link.destination_url)) {
    return json({ error: 'link_not_found' }, 404);
  }

  if (request.method === 'GET') {
    ctx.waitUntil(
      recordClick(request, env, trackingId, linkId, link.sent_at).catch((error) => {
        console.error('click tracking failed', trackingId, linkId, error);
      }),
    );
  }

  return Response.redirect(link.destination_url, 302);
}

async function recordClick(request, env, trackingId, linkId, sentAt) {
  const fingerprint = await requestFingerprint(request, env);
  const limit = parsePositiveInt(env.PUBLIC_EVENT_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_EVENT_RATE_LIMIT);
  const allowed = await consumeRateLimit(env.DB, `click:${trackingId}:${fingerprint.ipHash || 'none'}`, limit, 60);
  if (!allowed) return;

  const now = nowIso();
  const classification = classifyEvent({ kind: 'click', request, sentAt });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events
       (tracking_id, event_type, occurred_at, ip_hash, user_agent, country, colo, referer, classification, confidence, metadata)
       VALUES (?, 'click', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      trackingId,
      now,
      fingerprint.ipHash,
      fingerprint.userAgent,
      fingerprint.country,
      fingerprint.colo,
      request.headers.get('referer'),
      classification.classification,
      classification.confidence,
      JSON.stringify({
        link_id: linkId,
        timing_seconds_after_send: secondsSince(sentAt),
      }),
    ),
    env.DB.prepare(
      `UPDATE emails
       SET first_click_at = COALESCE(first_click_at, ?),
           last_click_at = ?,
           click_count = click_count + 1,
           status = CASE
             WHEN status NOT IN ('replied','bounced','cancelled') THEN 'clicked'
             ELSE status
           END
       WHERE tracking_id = ?`,
    ).bind(now, now, trackingId),
  ]);
}
