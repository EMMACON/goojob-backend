-- ─────────────────────────────────────────────────────────────
-- Goojob.io — Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ─────────────────────────────────────────────────────────────

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ─── Jobs table ───────────────────────────────────────────────
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  external_id   text unique not null,          -- dedup key (job_id from API or crawl)
  title         text not null,
  company       text not null,
  location      text not null default 'Unknown',
  remote        boolean default false,
  type          text default 'Full-time',       -- Full-time | Part-time | Contract | Internship
  description   text default '',
  apply_url     text not null,                 -- ← direct company link, the whole point
  company_logo  text,                          -- URL to logo image
  logo_color    text default '#333333',        -- fallback color for logo placeholder
  featured      boolean default false,
  source        text default 'api',            -- 'api' | 'crawl'
  posted_at     timestamptz default now(),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─── Click tracking ───────────────────────────────────────────
create table if not exists job_clicks (
  id         bigserial primary key,
  job_id     uuid references jobs(id) on delete cascade,
  user_ip    text,
  clicked_at timestamptz default now()
);

-- ─── Indexes for fast search ──────────────────────────────────
create index if not exists jobs_title_idx      on jobs using gin(to_tsvector('english', title));
create index if not exists jobs_company_idx    on jobs(company);
create index if not exists jobs_remote_idx     on jobs(remote);
create index if not exists jobs_type_idx       on jobs(type);
create index if not exists jobs_posted_at_idx  on jobs(posted_at desc);
create index if not exists jobs_featured_idx   on jobs(featured);

-- ─── Auto-update updated_at ───────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger jobs_updated_at
  before update on jobs
  for each row execute function update_updated_at();

-- ─── Row Level Security (public read) ────────────────────────
alter table jobs enable row level security;

-- Anyone can read jobs (public search)
create policy "Public read jobs"
  on jobs for select
  using (true);

-- Only service role (backend) can insert/update
create policy "Service role write jobs"
  on jobs for all
  using (auth.role() = 'service_role');

-- ─── Sample data (optional, to test immediately) ──────────────
insert into jobs (external_id, title, company, location, remote, type, description, apply_url, logo_color, featured)
values
  ('stripe_fe_001', 'Frontend Engineer', 'Stripe', 'San Francisco, CA', true, 'Full-time', 'Build beautiful payment UIs used by millions of businesses worldwide.', 'https://stripe.com/jobs/listing/frontend-engineer', '#635BFF', true),
  ('vercel_devops_001', 'DevOps Engineer', 'Vercel', 'Remote', true, 'Full-time', 'Scale the infrastructure that powers the modern web.', 'https://vercel.com/careers', '#000000', true),
  ('notion_design_001', 'Product Designer', 'Notion', 'New York, NY', true, 'Full-time', 'Shape the future of productivity tools used by 30M+ people.', 'https://www.notion.so/careers', '#000000', true)
on conflict (external_id) do nothing;
