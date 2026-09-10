import {
  DEFAULT_ADMIN_RATE_LIMIT,
  applyBooleanFilter,
  clamp,
  consumeRateLimit,
  generateTrackingId,
  getPublicBaseUrl,
  handleOptions,
  httpError,
  injectPixel,
  json,
  normalizeTimestamp,
  nowIso,
  optionalString,
  parseMetadata,
  parseNonNegativeInt,
  parsePositiveInt,
  readJson,
  requestIpHash,
  rewriteHref,
  safeEqual,
  validateDestination,
  validateEmailInput,
  validateOrGenerateLinkId,
  withCors,
} from './common.js';

export async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return handleOptions(request, env);
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return withCors(request, env, json({ error: auth.error }, auth.status));

  const clientKey = await requestIpHash(request, env);
  const limit = parsePositiveInt(env.ADMIN_RATE_LIMIT_PER_MINUTE, DEFAULT_ADMIN_RATE_LIMIT);
  const allowed = await consumeRateLimit(env.DB, `admin:${clientKey || 'unknown'}`, limit, 60);
  if (!allowed) {
    return withCors(request, env, json({ error: 'rate_limited' }, 429, { 'retry-after': '60' }));
  }

  let response;
  try {
    response = await routeApi(request, env, url);
  } catch (error) {
    console.error('api error', error);
    response = json({ error: error?.status ? error.message : 'internal_error' }, error?.status || 500);
  }

  return withCors(request, env, response);
}

async function routeApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS email_count FROM emails').first();
    return json({ ok: true, email_count: Number(row?.email_count || 0) });
  }

  if (path === '/api/emails' && request.method === 'POST') {
    const body = await readJson(request);
    const created = await createEmail(env, body, url.origin);
    return json(created, 201);
  }

  if (path === '/api/prepare' && request.method === 'POST') {
    const body = await readJson(request);
    const result = await prepareTrackedEmail(env, body, url.origin);
    return json(result, 201);
  }

  if (path === '/api/emails' && request.method === 'GET') {
    const result = await listEmails(env, url.searchParams, { agentMode: false });
    return json(result);
  }

  const detailMatch = path.match(/^\/api\/emails\/([A-Za-z0-9_-]{8,120})$/);
  if (detailMatch && request.method === 'GET') {
    const detail = await getEmailDetail(env, detailMatch[1], { agentMode: false, requestOrigin: url.origin });
    if (!detail) return json({ error: 'email_not_found' }, 404);
    return json(detail);
  }

  const linksMatch = path.match(/^\/api\/emails\/([A-Za-z0-9_-]{8,120})\/links$/);
  if (linksMatch && request.method === 'POST') {
    const body = await readJson(request);
    const link = await addTrackedLink(env, linksMatch[1], body, url.origin);
    return json(link, 201);
  }

  const stateMatch = path.match(/^\/api\/emails\/([A-Za-z0-9_-]{8,120})\/(sent|reply|bounce)$/);
  if (stateMatch && request.method === 'POST') {
    const body = await readJson(request, { allowEmpty: true });
    const result = await markEmailState(env, stateMatch[1], stateMatch[2], body || {});
    return json(result);
  }

  return json({ error: 'not_found' }, 404);
}

export async function handleAgent(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });

  const token = request.headers.get('x-agent-token') || url.searchParams.get('token');
  if (!env.AGENT_READ_TOKEN || !token || !safeEqual(token, env.AGENT_READ_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    if (url.pathname === '/agent/emails' || url.pathname === '/agent/recent') {
      const result = await listEmails(env, url.searchParams, { agentMode: true });
      return json(result);
    }

    const detailMatch = url.pathname.match(/^\/agent\/emails\/([A-Za-z0-9_-]{8,120})$/);
    if (detailMatch) {
      const detail = await getEmailDetail(env, detailMatch[1], { agentMode: true, requestOrigin: url.origin });
      if (!detail) return json({ error: 'email_not_found' }, 404);
      return json(detail);
    }

    return json({ error: 'not_found' }, 404);
  } catch (error) {
    console.error('agent endpoint error', error);
    return json({ error: error?.status ? error.message : 'internal_error' }, error?.status || 500);
  }
}

async function authenticateAdmin(request, env) {
  if (!env.TRACKER_API_KEY) {
    return { ok: false, status: 503, error: 'tracker_api_key_not_configured' };
  }

  const value = request.headers.get('authorization') || '';
  if (!value.startsWith('Bearer ')) return { ok: false, status: 401, error: 'unauthorized' };
  const token = value.slice(7);
  if (!safeEqual(token, env.TRACKER_API_KEY)) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true };
}

async function createEmail(env, body, requestOrigin) {
  const input = validateEmailInput(body);
  const trackingId = generateTrackingId();
  const createdAt = nowIso();
  const campaign = input.campaign || env.DEFAULT_CAMPAIGN || 'mellowkraft';

  await env.DB.prepare(
    `INSERT INTO emails
     (tracking_id, prospect_name, company_name, recipient_email, subject, campaign, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`,
  )
    .bind(
      trackingId,
      input.prospect_name,
      input.company_name,
      input.recipient_email,
      input.subject,
      campaign,
      createdAt,
    )
    .run();

  const base = getPublicBaseUrl(env, requestOrigin);
  return {
    tracking_id: trackingId,
    pixel_url: `${base}/o/${encodeURIComponent(trackingId)}.gif`,
    campaign,
    created_at: createdAt,
  };
}

async function addTrackedLink(env, trackingId, body, requestOrigin) {
  await requireEmail(env, trackingId);
  const destination = validateDestination(body?.destination_url);
  const linkId = validateOrGenerateLinkId(body?.link_id);
  const label = optionalString(body?.label, 200);
  const createdAt = nowIso();

  try {
    await env.DB.prepare(
      `INSERT INTO links (tracking_id, link_id, destination_url, label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(trackingId, linkId, destination, label, createdAt)
      .run();
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) throw httpError(409, 'link_id_already_exists');
    throw error;
  }

  const base = getPublicBaseUrl(env, requestOrigin);
  return {
    tracking_id: trackingId,
    link_id: linkId,
    destination_url: destination,
    tracked_url: `${base}/c/${encodeURIComponent(trackingId)}/${encodeURIComponent(linkId)}`,
    label,
  };
}

async function prepareTrackedEmail(env, body, requestOrigin) {
  if (!body || typeof body !== 'object') throw httpError(400, 'invalid_json_body');
  const htmlBody = requiredString(body.html_body, 'html_body', 100_000);
  if (!Array.isArray(body.links)) throw httpError(400, 'links_must_be_an_array');
  if (body.links.length > 30) throw httpError(400, 'too_many_links');

  const emailInput = validateEmailInput(body);
  const normalizedLinks = body.links.map((link, index) => {
    if (!link || typeof link !== 'object') throw httpError(400, `invalid_link_${index}`);
    return {
      link_id: validateOrGenerateLinkId(link.link_id || link.id),
      destination_url: validateDestination(link.destination_url || link.url),
      label: optionalString(link.label, 200),
    };
  });

  const seen = new Set();
  for (const link of normalizedLinks) {
    if (seen.has(link.link_id)) throw httpError(400, `duplicate_link_id:${link.link_id}`);
    seen.add(link.link_id);
  }

  const trackingId = generateTrackingId();
  const createdAt = nowIso();
  const campaign = emailInput.campaign || env.DEFAULT_CAMPAIGN || 'mellowkraft';
  const statements = [
    env.DB.prepare(
      `INSERT INTO emails
       (tracking_id, prospect_name, company_name, recipient_email, subject, campaign, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`,
    ).bind(
      trackingId,
      emailInput.prospect_name,
      emailInput.company_name,
      emailInput.recipient_email,
      emailInput.subject,
      campaign,
      createdAt,
    ),
  ];

  for (const link of normalizedLinks) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO links (tracking_id, link_id, destination_url, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(trackingId, link.link_id, link.destination_url, link.label, createdAt),
    );
  }

  await env.DB.batch(statements);

  const base = getPublicBaseUrl(env, requestOrigin);
  const trackedLinks = normalizedLinks.map((link) => ({
    ...link,
    tracked_url: `${base}/c/${encodeURIComponent(trackingId)}/${encodeURIComponent(link.link_id)}`,
  }));

  let modifiedHtml = htmlBody;
  for (const link of trackedLinks) {
    modifiedHtml = rewriteHref(modifiedHtml, link.destination_url, link.tracked_url);
  }

  const pixelUrl = `${base}/o/${encodeURIComponent(trackingId)}.gif`;
  modifiedHtml = injectPixel(modifiedHtml, pixelUrl);

  return {
    tracking_id: trackingId,
    pixel_url: pixelUrl,
    tracked_links: trackedLinks,
    html_body: modifiedHtml,
    campaign,
    created_at: createdAt,
  };
}

async function markEmailState(env, trackingId, action, body) {
  const email = await requireEmail(env, trackingId);
  const now = nowIso();

  if (action === 'sent') {
    const sentAt = normalizeTimestamp(body.sent_at) || now;
    const messageId = optionalString(body.gmail_message_id, 500);
    const threadId = optionalString(body.gmail_thread_id, 500);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE emails
         SET gmail_message_id = COALESCE(?, gmail_message_id),
             gmail_thread_id = COALESCE(?, gmail_thread_id),
             sent_at = ?,
             status = CASE WHEN status IN ('created','queued','sent') THEN 'sent' ELSE status END
         WHERE tracking_id = ?`,
      ).bind(messageId, threadId, sentAt, trackingId),
      env.DB.prepare(
        `INSERT INTO events
         (tracking_id, event_type, occurred_at, classification, confidence, metadata)
         VALUES (?, 'send', ?, 'unknown', 1.0, ?)`,
      ).bind(trackingId, sentAt, JSON.stringify({ gmail_message_id: messageId, gmail_thread_id: threadId })),
    ]);

    return { tracking_id: trackingId, status: 'sent', sent_at: sentAt, gmail_message_id: messageId, gmail_thread_id: threadId };
  }

  if (action === 'reply') {
    const repliedAt = normalizeTimestamp(body.replied_at) || now;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE emails SET replied = 1, replied_at = COALESCE(replied_at, ?), status = 'replied' WHERE tracking_id = ?`,
      ).bind(repliedAt, trackingId),
      env.DB.prepare(
        `INSERT INTO events
         (tracking_id, event_type, occurred_at, classification, confidence, metadata)
         VALUES (?, 'reply', ?, 'human_likely', 1.0, ?)`,
      ).bind(trackingId, repliedAt, JSON.stringify({ source: optionalString(body.source, 80) || 'manual_or_operator' })),
    ]);
    return { tracking_id: trackingId, replied: true, replied_at: repliedAt, status: 'replied' };
  }

  if (action === 'bounce') {
    const bouncedAt = normalizeTimestamp(body.bounced_at) || now;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE emails SET bounced = 1, bounced_at = COALESCE(bounced_at, ?), status = 'bounced' WHERE tracking_id = ?`,
      ).bind(bouncedAt, trackingId),
      env.DB.prepare(
        `INSERT INTO events
         (tracking_id, event_type, occurred_at, classification, confidence, metadata)
         VALUES (?, 'bounce', ?, 'unknown', 1.0, ?)`,
      ).bind(trackingId, bouncedAt, JSON.stringify({ source: optionalString(body.source, 80) || 'manual_or_operator' })),
    ]);
    return { tracking_id: trackingId, bounced: true, bounced_at: bouncedAt, status: 'bounced' };
  }

  return { tracking_id: email.tracking_id };
}

async function listEmails(env, params, { agentMode }) {
  const where = [];
  const binds = [];

  applyBooleanFilter(params, 'opened', 'open_count > 0', 'open_count = 0', where);
  applyBooleanFilter(params, 'clicked', 'click_count > 0', 'click_count = 0', where);
  applyBooleanFilter(params, 'replied', 'replied = 1', 'replied = 0', where);
  applyBooleanFilter(params, 'bounced', 'bounced = 1', 'bounced = 0', where);

  const company = params.get('company');
  if (company) {
    where.push('company_name LIKE ? COLLATE NOCASE');
    binds.push(`%${company.slice(0, 200)}%`);
  }

  const recipient = params.get('recipient');
  if (recipient) {
    where.push('recipient_email LIKE ? COLLATE NOCASE');
    binds.push(`%${recipient.slice(0, 320)}%`);
  }

  const campaign = params.get('campaign');
  if (campaign) {
    where.push('campaign = ? COLLATE NOCASE');
    binds.push(campaign.slice(0, 100));
  }

  const sentAfter = params.get('sent_after');
  if (sentAfter) {
    const value = normalizeTimestamp(sentAfter);
    if (!value) throw httpError(400, 'invalid_sent_after');
    where.push('sent_at >= ?');
    binds.push(value);
  }

  const engagedSince = params.get('engaged_since');
  if (engagedSince) {
    const value = normalizeTimestamp(engagedSince);
    if (!value) throw httpError(400, 'invalid_engaged_since');
    where.push('(last_open_at >= ? OR last_click_at >= ? OR replied_at >= ?)');
    binds.push(value, value, value);
  }

  const limit = clamp(parsePositiveInt(params.get('limit'), 50), 1, agentMode ? 100 : 200);
  const offset = clamp(parseNonNegativeInt(params.get('offset'), 0), 0, 100_000);
  binds.push(limit, offset);

  const sql = `
    SELECT tracking_id, prospect_name, company_name, recipient_email, gmail_message_id, gmail_thread_id,
           subject, campaign, sent_at, created_at, first_open_at, last_open_at, open_count,
           first_human_open_at, last_human_open_at, human_open_count,
           first_click_at, last_click_at, click_count, replied, replied_at, bounced, bounced_at, status
    FROM emails
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY MAX(COALESCE(last_click_at, ''), COALESCE(last_human_open_at, ''), COALESCE(last_open_at, ''), COALESCE(replied_at, ''), COALESCE(sent_at, ''), created_at) DESC
    LIMIT ? OFFSET ?`;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  const emails = (result.results || []).map(serializeEmail);
  return { count: emails.length, emails };
}

async function getEmailDetail(env, trackingId, { agentMode, requestOrigin }) {
  const row = await env.DB.prepare(
    `SELECT tracking_id, prospect_name, company_name, recipient_email, gmail_message_id, gmail_thread_id,
            subject, campaign, sent_at, created_at, first_open_at, last_open_at, open_count,
            first_human_open_at, last_human_open_at, human_open_count,
            first_click_at, last_click_at, click_count, replied, replied_at, bounced, bounced_at, status
     FROM emails WHERE tracking_id = ? LIMIT 1`,
  )
    .bind(trackingId)
    .first();
  if (!row) return null;

  const [eventsResult, linksResult] = await Promise.all([
    env.DB.prepare(
      `SELECT event_type, occurred_at, user_agent, country, colo, referer, classification, confidence, metadata
       FROM events WHERE tracking_id = ? ORDER BY occurred_at ASC, id ASC LIMIT 500`,
    )
      .bind(trackingId)
      .all(),
    env.DB.prepare(
      `SELECT link_id, destination_url, label, created_at
       FROM links WHERE tracking_id = ? ORDER BY id ASC`,
    )
      .bind(trackingId)
      .all(),
  ]);

  const base = getPublicBaseUrl(env, requestOrigin);
  return {
    email: serializeEmail(row),
    engagement: engagementSummary(row),
    links: (linksResult.results || []).map((link) => ({
      ...link,
      tracked_url: `${base}/c/${encodeURIComponent(trackingId)}/${encodeURIComponent(link.link_id)}`,
    })),
    events: (eventsResult.results || []).map((event) => ({
      ...event,
      metadata: parseMetadata(event.metadata),
      ...(agentMode ? {} : {}),
    })),
  };
}

function serializeEmail(row) {
  const email = {
    ...row,
    open_count: Number(row.open_count || 0),
    human_open_count: Number(row.human_open_count || 0),
    click_count: Number(row.click_count || 0),
    replied: Boolean(row.replied),
    bounced: Boolean(row.bounced),
  };
  email.engagement = engagementSummary(email);
  return email;
}

function engagementSummary(row) {
  const rawOpens = Number(row.open_count || 0);
  const humanOpens = Number(row.human_open_count || 0);
  const clicks = Number(row.click_count || 0);
  const replied = Boolean(row.replied);
  const bounced = Boolean(row.bounced);

  let score = 0;
  if (humanOpens > 0) score += 1;
  if (humanOpens > 1) score += 1;
  score += clicks * 3;
  if (replied) score += 8;
  if (bounced) score -= 10;

  let label = 'unknown';
  if (bounced) label = 'bounced';
  else if (replied) label = 'replied';
  else if (clicks > 0 && (clicks > 1 || humanOpens > 0)) label = 'high_intent';
  else if (clicks > 0 || humanOpens > 1) label = 'warm';
  else if (humanOpens > 0 || rawOpens > 0) label = 'opened';
  else if (row.sent_at) label = 'unengaged';

  return {
    label,
    score,
    raw_opens: rawOpens,
    likely_human_opens: humanOpens,
    clicks,
    replied,
    bounced,
    priority: bounced ? 0 : replied ? 5 : clicks > 0 ? 4 : humanOpens > 1 ? 3 : humanOpens === 1 ? 2 : 1,
  };
}

async function requireEmail(env, trackingId) {
  const email = await env.DB.prepare('SELECT tracking_id FROM emails WHERE tracking_id = ? LIMIT 1')
    .bind(trackingId)
    .first();
  if (!email) throw httpError(404, 'email_not_found');
  return email;
}
