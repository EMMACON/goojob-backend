-- Optional. The crawlers remove postings that disappear from a board
-- without this column. Apply it only if you want a second sweep:
-- rows not touched by a crawl can be recognised by last_seen_at.
--
-- After this succeeds, set JOBS_HAS_LAST_SEEN=true and run a full crawl.
-- Until that env var is set, the API does not send last_seen_at, so a
-- deploy before this migration does not break upserts.

alter table jobs add column if not exists last_seen_at timestamptz;

create index if not exists jobs_source_last_seen_idx
  on jobs (source, last_seen_at);
