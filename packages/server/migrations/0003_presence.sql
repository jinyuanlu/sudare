-- When a person's client was last connected or polling. Shown to the people they
-- share a conversation with as "here now"; nothing finer than a minute.
ALTER TABLE principals ADD COLUMN last_seen INTEGER;
