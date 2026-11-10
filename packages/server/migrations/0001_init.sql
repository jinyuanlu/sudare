-- The directory: the only state that is queried across Durable Objects.
-- Conversation and inbox logs live in their own objects; nothing here is a
-- source of truth for message content.

CREATE TABLE principals (
  id             TEXT PRIMARY KEY,
  default_handle TEXT,
  invited_via    TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,           -- WebAuthn credential id (base64url)
  principal   TEXT NOT NULL REFERENCES principals(id),
  public_key  TEXT NOT NULL,              -- COSE key, base64url
  counter     INTEGER NOT NULL,
  transports  TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX credentials_principal ON credentials(principal);

CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL,               -- register | login | link | add
  subject    TEXT,
  expires_at INTEGER NOT NULL
);

-- `human` sessions. Only ever inserted after a verified passkey assertion (I6).
CREATE TABLE sessions (
  hash       TEXT PRIMARY KEY,
  principal  TEXT NOT NULL REFERENCES principals(id),
  kind       TEXT NOT NULL,               -- web | plugin
  device     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_principal ON sessions(principal);

-- `agent` credentials. An OAuth grant or a pasted token; never upgradable.
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  principal   TEXT NOT NULL REFERENCES principals(id),
  kind        TEXT NOT NULL,              -- oauth | token
  name        TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  client_name TEXT NOT NULL,
  rounds      INTEGER NOT NULL DEFAULT 0, -- may take a seat in discussion rounds
  token_hash  TEXT UNIQUE,
  created_at  INTEGER NOT NULL,
  last_active INTEGER,
  expires_at  INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX devices_principal ON devices(principal);

CREATE TABLE convs (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  dm_key      TEXT UNIQUE,                -- "<principal>|<principal>" for the canonical private chat
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

-- alias -> principal. Projected from the conversation logs; server-side only.
CREATE TABLE aliases (
  alias     TEXT PRIMARY KEY,
  conv      TEXT NOT NULL,
  principal TEXT NOT NULL,
  handle    TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at   INTEGER
);
CREATE INDEX aliases_principal ON aliases(principal, left_at);
CREATE INDEX aliases_conv ON aliases(conv, left_at);

CREATE TABLE invites (
  id              TEXT PRIMARY KEY,
  code_hash       TEXT UNIQUE,            -- link invites: SHA-256 of the code; the code itself is never stored
  conv            TEXT NOT NULL,
  kind            TEXT NOT NULL,          -- link | direct | bootstrap
  by_principal    TEXT,
  by_handle       TEXT NOT NULL,
  target          TEXT,                   -- direct: the invited principal
  bound           TEXT,                   -- link: the principal who registered through it
  bootstrap_topic TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  used_by         TEXT,
  declined_at     INTEGER
);
CREATE INDEX invites_target ON invites(target, used_at, declined_at);
CREATE INDEX invites_conv ON invites(conv);

-- Pending "give this plugin a human session" requests. Confirmed only by a
-- passkey assertion of the same principal the requesting device belongs to.
CREATE TABLE human_links (
  id           TEXT PRIMARY KEY,
  principal    TEXT NOT NULL,
  device       TEXT NOT NULL,
  challenge    TEXT NOT NULL,             -- S256 of the verifier the plugin keeps in memory
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  consumed_at  INTEGER
);
