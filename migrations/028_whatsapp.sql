CREATE TABLE IF NOT EXISTS wa_conversations (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  jid TEXT,
  display_name TEXT,
  language TEXT CHECK (language IS NULL OR language IN ('fr','ar','darija_latin','darija_arabic')),
  mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','human')),
  needs_human INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  taken_over_by TEXT REFERENCES users(id),
  taken_over_at TEXT,
  ai_paused_until TEXT,
  identity_failures INTEGER NOT NULL DEFAULT 0,
  identity_locked_until TEXT,
  no_whatsapp INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  last_agent_reply_at TEXT,
  last_preview TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_conv_updated ON wa_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_conv_needs_human ON wa_conversations(needs_human, updated_at DESC);

CREATE TABLE IF NOT EXISTS wa_conversation_orders (
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  access TEXT NOT NULL CHECK (access IN ('full','status_only')),
  linked_via TEXT NOT NULL CHECK (linked_via IN ('phone','ref_message','ref_last4','agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_conv_orders_order ON wa_conversation_orders(order_id);

CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  author TEXT NOT NULL CHECK (author IN ('customer','ai','agent','system')),
  author_user_id TEXT REFERENCES users(id),
  wa_message_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('text','audio','image','other')),
  body TEXT,
  transcript TEXT,
  media_path TEXT,
  media_mime TEXT,
  media_sha256 TEXT,
  media_bytes INTEGER,
  media_deleted_at TEXT,
  outbox_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_conv ON wa_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_media ON wa_messages(created_at) WHERE media_path IS NOT NULL AND media_deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wa_inbound_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  wa_message_id TEXT UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','ignored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease TEXT,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_inbound_pending ON wa_inbound_events(status, available_at);

CREATE TABLE IF NOT EXISTS wa_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  conversation_id TEXT REFERENCES wa_conversations(id),
  order_id TEXT REFERENCES orders(id),
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('notify_confirmed','notify_shipped','notify_delivered','notify_out_for_delivery','notify_delivery_issue','notify_cancelled','relance_no_answer','admin_alert','ai_reply','agent_reply','strike_warning','product_card')),
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image')),
  body TEXT NOT NULL,
  media_ref TEXT,
  respect_window INTEGER NOT NULL DEFAULT 1,
  counts_toward_cap INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','uncertain','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease TEXT,
  wa_message_id TEXT,
  last_error TEXT,
  author_user_id TEXT REFERENCES users(id),
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_due ON wa_outbox(status, available_at);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_order ON wa_outbox(order_id);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_sent ON wa_outbox(sent_at) WHERE sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS wa_strikes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 10),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('insult','severe','spam_burst','refused_delivery','repeated_cancel','manipulation','ref_guessing')),
  detail TEXT,
  message_id TEXT,
  order_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_strikes_phone ON wa_strikes(phone, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_strikes_order_reason ON wa_strikes(order_id, reason_code) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wa_ai_usage (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('chat','audio','vision','classify')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_ai_usage_day ON wa_ai_usage(day);

CREATE TABLE IF NOT EXISTS wa_media_cache (
  sha256 TEXT PRIMARY KEY,
  transcript TEXT,
  language TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_order_drafts (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  conversation_id TEXT REFERENCES wa_conversations(id),
  address TEXT CHECK (address IS NULL OR length(address) <= 500),
  city_id INTEGER,
  city_name TEXT,
  note TEXT,
  ready_to_confirm INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_proposals (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  conversation_id TEXT REFERENCES wa_conversations(id),
  kind TEXT NOT NULL CHECK (kind IN ('edit','cancel')),
  payload_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded','failed')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  result_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_proposals_order ON wa_proposals(order_id, status);

CREATE TABLE IF NOT EXISTS wa_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id),
  phone TEXT NOT NULL,
  customer_name TEXT,
  items_json TEXT NOT NULL,
  city_name TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','dismissed')),
  order_id TEXT REFERENCES orders(id),
  handled_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_requests_status ON wa_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS carrier_status_mappings (
  provider TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  notify_category TEXT CHECK (notify_category IS NULL OR notify_category IN ('in_transit','out_for_delivery','delivery_issue','ignore')),
  sample_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  mapped_by TEXT REFERENCES users(id),
  mapped_at TEXT,
  PRIMARY KEY (provider, raw_status)
);

ALTER TABLE blocked_phones ADD COLUMN source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','system'));
