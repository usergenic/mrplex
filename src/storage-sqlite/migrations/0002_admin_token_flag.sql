-- Design §6.4 / §8.2 give Token an `admin: boolean` field separate from
-- `scopes`. The M0 schema packed only `scopes json`; M1 splits `admin` out
-- as its own column so it's independently indexable and queryable
-- ("list all admin tokens", "revoke all non-admin tokens for user X", etc.).
--
-- Default 0 (not admin) — existing tokens (there are none in M0, but the
-- default protects against surprises during branch rebases).

alter table api_tokens add column admin integer not null default 0;
