-- A plugin may ask for a session that outlives a restart ("remember me on this
-- machine"). The person sees that on the confirmation page before agreeing.
ALTER TABLE human_links ADD COLUMN remember INTEGER NOT NULL DEFAULT 0;
