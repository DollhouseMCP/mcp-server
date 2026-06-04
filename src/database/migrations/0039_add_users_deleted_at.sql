-- Tombstone marker for deleted accounts.
--
-- A true DELETE of a users row is refused (ON DELETE RESTRICT) by the
-- tamper-evident admin audit chain and role-grant authorship for any account
-- with history, so account deletion falls back to anonymize-tombstone: the row
-- is scrubbed of all identifying data and kept solely as an audit anchor.
-- `deleted_at` marks those rows so they are excluded from the account directory
-- (they are not real, usable accounts). NULL means a live account. A returning
-- user signs in as a fresh account; the tombstone stays inert.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
