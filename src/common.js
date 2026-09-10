const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const MAX_JSON_BYTES = 150_000;
export const DEFAULT_ADMIN_RATE_LIMIT = 120;
export const DEFAULT_PUBLIC_EVENT_RATE_LIMIT = 300;
export const HUMAN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export function validateEmailInput(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'invalid_json_body');
  const recipient = requiredString(body.recipient_email || body.recipient, 'recipient_email', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw httpError(400, 'invalid_recipient_email');

  return {
    recipient_email: recipient,
    prospect_name: optionalString(body.prospect_name, 200),
    company_name: optionalString(body.company_name || body.company, 200),
    subject: optionalString(body.subject, 998),
    campaign: optionalString(body.campaign, 100),
  };
}

export function validateDestination(value) {
  const raw = requiredString(value, 'destination_url', 4000);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'invalid_destination_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'destination_protocol_not_allowed');
  if (url.username || url.password) throw httpError(400, 'destination_credentials_not_allowed');
  return url.toString();
}

export function isAllowedDestination(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateOrGenerateLinkId(value) {
  if (value == null || value === '') return generateLinkId();
  const id = String(value);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw httpError(400, 'invalid_link_id');
  return id;
}

export function generateTrackingId() {
  return `mk_${randomBase64Url(18)}`;
}

export function generateLinkId() {
  return `l_${randomBase64Url(8)}`;
}

export function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function requestFingerprint(request, env) {
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 1000) || null;
  const country = request.cf?.country ? String(request.cf.country).slice(0, 8) : null;
  const colo = request.cf?.colo ? String(request.cf.colo).slice(0, 20) : null;
  const ipHash = await requestIpHash(request, env);
  return { userAgent, country, colo, ipHash };
}

export async function requestIpHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ip) return null;
  const salt = env.TRACKER_API_KEY || env.AGENT_READ_TOKEN || 'hexk-nonsecret-fallback';
  const data = new TextEncoder().encode(`${salt}\n${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export function classifyEvent({ kind, request, sentAt }) {
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const purpose = `${request.headers.get('purpose') || ''} ${request.headers.get('sec-purpose') || ''}`.toLowerCase();
  const seconds = secondsSince(sentAt);

  const scannerPatterns = [
    'proofpoint', 'mimecast', 'barracuda', 'safelinks', 'microsoft office', 'defender',
    'symantec', 'messagelabs', 'trendmicro', 'urlscan', 'crawler', 'spider', 'headless',
    'preview', 'linkchecker', 'link check', 'security', 'scanner', 'bot', 'wget', 'curl',
  ];
  if (scannerPatterns.some((p) => ua.includes(p)) || purpose.includes('prefetch') || purpose.includes('preview')) {
    return { classification: 'security_scanner_likely', confidence: 0.9 };
  }

  const proxyPatterns = ['googleimageproxy', 'google image proxy', 'ggpht', 'applemail', 'mailprivacy'];
  if (proxyPatterns.some((p) => ua.includes(p))) {
    return { classification: 'proxy_likely', confidence: 0.9 };
  }

  if (seconds != null && seconds >= 0 && seconds < 8) {
    return { classification: kind === 'click' ? 'security_scanner_likely' : 'proxy_likely', confidence: 0.75 };
  }

  const browserish = /mozilla\/|chrome\/|safari\/|firefox\/|edg\//.test(ua);
  if (browserish && ua) {
    return { classification: 'human_likely', confidence: kind === 'click' ? 0.72 : 0.62 };
  }

  return { classification: 'unknown', confidence: 0.35 };
}

export async function consumeRateLimit(db, bucket, limit, windowSeconds) {
  if (!limit || limit < 1) return true;
  const now = Math.floor(Date.now() / 1000);
  const expires = now + windowSeconds;

  await db.prepare(
    `INSERT INTO rate_limits (bucket, count, expires_at)
     VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.expires_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       expires_at = CASE WHEN rate_limits.expires_at <= ? THEN ? ELSE rate_limits.expires_at END`,
  )
    .bind(bucket, expires, now, now, expires)
    .run();

  const row = await db.prepare('SELECT count, expires_at FROM rate_limits WHERE bucket = ? LIMIT 1')
    .bind(bucket)
    .first();

  if (Math.random() < 0.01) {
    db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now - 3600).run().catch(() => {});
  }

  return Number(row?.count || 0) <= limit;
}

export function injectPixel(html, pixelUrl) {
  const tag = `<img src="${escapeHtmlAttr(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;" />`;
  const bodyClose = /<\/body\s*>/i;
  if (bodyClose.test(html)) return html.replace(bodyClose, `${tag}</body>`);
  return `${html}${tag}`;
}

export function rewriteHref(html, destination, trackedUrl) {
  return html.replace(/href\s*=\s*(["'])(.*?)\1/gi, (full, quote, href) => {
    try {
      if (new URL(href).toString() === destination) {
        return `href=${quote}${trackedUrl}${quote}`;
      }
    } catch {}
    return full;
  });
}

export function getPublicBaseUrl(env, requestOrigin) {
  const candidate = env.PUBLIC_BASE_URL || requestOrigin;
  if (!candidate) throw httpError(500, 'public_base_url_not_configured');
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
    return url.origin;
  } catch {
    throw httpError(500, 'invalid_public_base_url');
  }
}

export async function readJson(request, { allowEmpty = false } = {}) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_JSON_BYTES) throw httpError(413, 'request_too_large');

  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw httpError(400, 'json_body_required');
  }
  if (text.length > MAX_JSON_BYTES) throw httpError(413, 'request_too_large');

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'invalid_json_body');
  }
}

export function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, `${field}_required`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw httpError(400, `${field}_too_long`);
  return trimmed;
}

export function optionalString(value, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_string_value');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw httpError(400, 'string_value_too_long');
  return trimmed;
}

export function normalizeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function secondsSince(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.round((Date.now() - time) / 1000);
}

export function applyBooleanFilter(params, key, trueSql, falseSql, where) {
  const value = params.get(key);
  if (value === 'true' || value === '1') where.push(trueSql);
  else if (value === 'false' || value === '0') where.push(falseSql);
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function nowIso() {
  return new Date().toISOString();
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function handleOptions(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return new Response(null, { status: 204 });
  if (!isAllowedCorsOrigin(origin, request, env)) return json({ error: 'cors_origin_not_allowed' }, 403);
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  });
}

export function withCors(request, env, response) {
  const origin = request.headers.get('origin');
  if (!origin || !isAllowedCorsOrigin(origin, request, env)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function isAllowedCorsOrigin(origin, request, env) {
  try {
    if (origin === new URL(request.url).origin) return true;
  } catch {}
  return Boolean(env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function escapeHtmlAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
