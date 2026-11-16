-- Optional indexes for search. Run in the Supabase SQL editor.
-- The API does not depend on these; they make ILIKE filters cheaper
-- once the jobs table is large.
--
-- Do not switch search over to the english tsvector index from schema.sql.
-- That stemmer reduces "accountant" to "account", which is the prefix
-- bug (Account Executive matching a search for accountant).

create extension if not exists pg_trgm;

create index if not exists jobs_title_trgm
  on jobs using gin (title gin_trgm_ops);

create index if not exists jobs_company_trgm
  on jobs using gin (company gin_trgm_ops);

create index if not exists jobs_location_trgm
  on jobs using gin (location gin_trgm_ops);

create index if not exists jobs_remote_posted_idx
  on jobs (remote, posted_at desc);
