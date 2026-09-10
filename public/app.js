const state = { emails: [], apiKey: sessionStorage.getItem('hexk_api_key') || '' };

const els = {
  rows: document.querySelector('#emailRows'),
  empty: document.querySelector('#emptyState'),
  status: document.querySelector('#statusText'),
  refresh: document.querySelector('#refreshButton'),
  auth: document.querySelector('#authButton'),
  search: document.querySelector('#searchInput'),
  engagement: document.querySelector('#engagementFilter'),
  clickedOnly: document.querySelector('#clickedOnly'),
  unrepliedOnly: document.querySelector('#unrepliedOnly'),
  tracked: document.querySelector('#statTracked'),
  opened: document.querySelector('#statOpened'),
  clicked: document.querySelector('#statClicked'),
  replied: document.querySelector('#statReplied'),
  dialog: document.querySelector('#detailDialog'),
  closeDialog: document.querySelector('#closeDialog'),
  detailTitle: document.querySelector('#detailTitle'),
  detailSubtitle: document.querySelector('#detailSubtitle'),
  detailSummary: document.querySelector('#detailSummary'),
  timeline: document.querySelector('#timeline'),
};

els.refresh.addEventListener('click', loadEmails);
els.auth.addEventListener('click', setApiKey);
els.search.addEventListener('input', render);
els.engagement.addEventListener('change', render);
els.clickedOnly.addEventListener('change', render);
els.unrepliedOnly.addEventListener('change', render);
els.closeDialog.addEventListener('click', () => els.dialog.close());

if (!state.apiKey) setStatus('Set the tracker API key to load data.');
else loadEmails();

async function setApiKey() {
  const next = prompt('Tracker API key', state.apiKey || '');
  if (next === null) return;
  state.apiKey = next.trim();
  if (state.apiKey) sessionStorage.setItem('hexk_api_key', state.apiKey);
  else sessionStorage.removeItem('hexk_api_key');
  await loadEmails();
}

async function loadEmails() {
  if (!state.apiKey) {
    setStatus('API key required.');
    state.emails = [];
    render();
    return;
  }
  setStatus('Loading…');
  try {
    const data = await api('/api/emails?limit=200');
    state.emails = Array.isArray(data.emails) ? data.emails : [];
    render();
    setStatus(`Updated ${new Date().toLocaleTimeString()}.`);
  } catch (error) {
    setStatus(error.message || 'Could not load engagement data.');
  }
}

function render() {
  const q = els.search.value.trim().toLowerCase();
  const engagement = els.engagement.value;
  const filtered = state.emails.filter((email) => {
    const haystack = [email.prospect_name, email.company_name, email.recipient_email, email.subject].filter(Boolean).join(' ').toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (engagement && email.engagement?.label !== engagement) return false;
    if (els.clickedOnly.checked && Number(email.click_count || 0) < 1) return false;
    if (els.unrepliedOnly.checked && email.replied) return false;
    return true;
  });

  els.rows.replaceChildren(...filtered.map(rowForEmail));
  els.empty.classList.toggle('hidden', filtered.length !== 0);

  els.tracked.textContent = String(state.emails.length);
  els.opened.textContent = String(state.emails.filter((e) => Number(e.human_open_count || 0) > 0).length);
  els.clicked.textContent = String(state.emails.filter((e) => Number(e.click_count || 0) > 0).length);
  els.replied.textContent = String(state.emails.filter((e) => e.replied).length);
}

function rowForEmail(email) {
  const tr = document.createElement('tr');
  const values = [
    email.prospect_name || email.recipient_email,
    email.company_name || '—',
    formatTime(email.sent_at),
    `${email.human_open_count || 0} / ${email.open_count || 0}`,
    formatTime(email.last_human_open_at || email.last_open_at),
    String(email.click_count || 0),
    email.replied ? 'Yes' : 'No',
    email.bounced ? 'Yes' : 'No',
  ];
  for (const value of values) {
    const td = document.createElement('td');
    td.textContent = value;
    tr.append(td);
  }
  const td = document.createElement('td');
  const badge = document.createElement('span');
  const label = email.engagement?.label || 'unknown';
  badge.className = `badge ${label}`;
  badge.textContent = label.replaceAll('_', ' ');
  td.append(badge);
  tr.append(td);
  tr.addEventListener('click', () => showDetail(email.tracking_id));
  return tr;
}

async function showDetail(trackingId) {
  setStatus('Loading detail…');
  try {
    const data = await api(`/api/emails/${encodeURIComponent(trackingId)}`);
    const email = data.email;
    els.detailTitle.textContent = email.prospect_name || email.recipient_email;
    els.detailSubtitle.textContent = [email.company_name, email.subject].filter(Boolean).join(' · ') || email.recipient_email;
    els.detailSummary.replaceChildren(
      summaryCard('Tracking ID', email.tracking_id, true),
      summaryCard('Sent', formatTime(email.sent_at)),
      summaryCard('Likely human opens', String(email.human_open_count || 0)),
      summaryCard('Raw opens', String(email.open_count || 0)),
      summaryCard('Clicks', String(email.click_count || 0)),
      summaryCard('Engagement', email.engagement?.label?.replaceAll('_', ' ') || 'unknown'),
    );

    const events = Array.isArray(data.events) ? data.events : [];
    els.timeline.replaceChildren(...events.map(eventNode));
    if (!events.length) {
      const empty = document.createElement('p');
      empty.className = 'subtle';
      empty.textContent = 'No events yet.';
      els.timeline.append(empty);
    }
    els.dialog.showModal();
    setStatus('');
  } catch (error) {
    setStatus(error.message || 'Could not load detail.');
  }
}

function summaryCard(label, value, mono = false) {
  const article = document.createElement('article');
  const span = document.createElement('span');
  span.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value || '—';
  if (mono) strong.className = 'mono';
  article.append(span, strong);
  return article;
}

function eventNode(event) {
  const row = document.createElement('div');
  row.className = 'event';
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = formatTime(event.occurred_at);
  const kind = document.createElement('div');
  kind.className = 'kind';
  kind.textContent = event.event_type || 'event';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [event.classification];
  if (event.metadata?.link_id) bits.push(`link: ${event.metadata.link_id}`);
  if (event.country) bits.push(event.country);
  meta.textContent = bits.filter(Boolean).join(' · ') || '—';
  row.append(time, kind, meta);
  return row;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      authorization: `Bearer ${state.apiKey}`,
    },
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

function setStatus(text) { els.status.textContent = text; }

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
