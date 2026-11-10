-- A room link is an invitation many people can use until it is turned off or
-- expires. Members can copy it again, so its code is kept (single-use links
-- still store only a hash).
ALTER TABLE invites ADD COLUMN code TEXT;
