-- How many pictures each person has uploaded today: the daily cap is counted here,
-- across all their rooms. The pictures themselves live in each room's own storage.
CREATE TABLE uploads (
  principal TEXT NOT NULL,
  day       INTEGER NOT NULL,             -- days since the epoch, UTC
  n         INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  PRIMARY KEY (principal, day)
);
