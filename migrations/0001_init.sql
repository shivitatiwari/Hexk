PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_id TEXT UNIQUE NOT NULL,
    prospect_name TEXT,
    company_name TEXT,
    recipient_email TEXT NOT NULL,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    subject TEXT,
    campaign TEXT DEFAULT 'mellowkraft',
    sent_at TEXT,
    created_at TEXT NOT NULL,
    first_open_at TEXT,
    last_open_at TEXT,
    open_count INTEGER DEFAULT 0,
    first_human_open_at TEXT,
    last_human_open_at TEXT,
    human_open_count INTEGER DEFAULT 0,
    first_click_at TEXT,
    last_click_at TEXT,
    click_count INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0,
    replied_at TEXT,
    bounced INTEGER DEFAULT 0,
    bounced_at TEXT,
    status TEXT DEFAULT 'created' CHECK(status IN ('created','queued','sent','opened','clicked','replied','bounced','cancelled'))
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('open','click','reply','bounce','send')),
    occurred_at TEXT NOT NULL,
    ip_hash TEXT,
    user_agent TEXT,
    country TEXT,
    colo TEXT,
    referer TEXT,
    classification TEXT CHECK(classification IN ('human_likely','proxy_likely','security_scanner_likely','unknown')),
    confidence REAL,
    metadata TEXT,
    FOREIGN KEY (tracking_id) REFERENCES emails(tracking_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(tracking_id, link_id),
    FOREIGN KEY (tracking_id) REFERENCES emails(tracking_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_campaign ON emails(campaign);
CREATE INDEX IF NOT EXISTS idx_emails_recipient ON emails(recipient_email);
CREATE INDEX IF NOT EXISTS idx_emails_company ON emails(company_name);
CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at);
CREATE INDEX IF NOT EXISTS idx_emails_last_human_open ON emails(last_human_open_at);
CREATE INDEX IF NOT EXISTS idx_emails_last_click ON emails(last_click_at);
CREATE INDEX IF NOT EXISTS idx_events_tracking_time ON events(tracking_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_tracking_type ON events(tracking_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events(tracking_id, ip_hash, user_agent, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_tracking ON links(tracking_id);
