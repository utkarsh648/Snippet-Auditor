-- Snippet Auditor — Supabase schema (MVP)
-- Run in the Supabase SQL editor. Safe to re-run: it also upgrades an
-- existing database (adds the visual-annotation columns from migration 002).

-- gen_random_uuid() is built into PostgreSQL 13+ (Supabase runs 15+).

-- ---------------------------------------------------------------
-- projects: one row per prototype. Only token HASHES are stored.
-- ---------------------------------------------------------------
create table if not exists public.projects (
  id                  text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  html                text not null default '' check (octet_length(html) <= 2097152),
  dev_token_hash      text not null unique,
  qa_token_hash       text not null unique,
  -- Next QA pointer number. Only ever increases, so deleted numbers are never reused.
  next_pointer_number integer not null default 1 check (next_pointer_number >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint projects_distinct_tokens check (dev_token_hash <> qa_token_hash)
);

-- ---------------------------------------------------------------
-- qa_pointers: client feedback, kept separate from the HTML.
-- ---------------------------------------------------------------
create table if not exists public.qa_pointers (
  id             uuid primary key default gen_random_uuid(),
  project_id     text not null references public.projects(id) on delete cascade,
  pointer_number integer not null check (pointer_number >= 1),
  screen_name    text not null check (char_length(btrim(screen_name)) between 1 and 150),
  notes          text not null default '' check (char_length(notes) <= 5000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, pointer_number)
);

create index if not exists qa_pointers_project_idx on public.qa_pointers (project_id, pointer_number);

-- ---------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Only content edits bump projects.updated_at (adding a QA pointer
-- increments next_pointer_number and must not look like an HTML save).
drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update of name, html on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists qa_pointers_set_updated_at on public.qa_pointers;
create trigger qa_pointers_set_updated_at
  before update on public.qa_pointers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Visual annotation fields (migration 002) + atomic pointer creation.
-- Existing notes keep working as screen-level notes.
-- ---------------------------------------------------------------
alter table public.qa_pointers
  add column if not exists screen_state    text not null default 'Default'
    check (char_length(screen_state) <= 100),
  add column if not exists target_type     text not null default 'screen'
    check (target_type in ('screen', 'element', 'area')),
  add column if not exists target_selector text
    check (target_selector is null or char_length(target_selector) <= 500),
  add column if not exists target_label    text
    check (target_label is null or char_length(target_label) <= 150),
  -- anchor_x: fraction of the preview viewport width (0–1)
  -- anchor_y: fraction of the full document height (0–1), so it survives scrolling
  add column if not exists anchor_x        double precision
    check (anchor_x is null or (anchor_x >= 0 and anchor_x <= 1)),
  add column if not exists anchor_y        double precision
    check (anchor_y is null or (anchor_y >= 0 and anchor_y <= 1)),
  add column if not exists viewport_width  integer
    check (viewport_width is null or (viewport_width between 1 and 10000)),
  add column if not exists viewport_height integer
    check (viewport_height is null or (viewport_height between 1 and 10000));

-- Replace the 3-argument create function with one that also stores the annotation.
drop function if exists public.create_qa_pointer(text, text, text);

create or replace function public.create_qa_pointer(
  p_project_id      text,
  p_screen_name     text,
  p_notes           text,
  p_screen_state    text             default 'Default',
  p_target_type     text             default 'screen',
  p_target_selector text             default null,
  p_target_label    text             default null,
  p_anchor_x        double precision default null,
  p_anchor_y        double precision default null,
  p_viewport_width  integer          default null,
  p_viewport_height integer          default null
)
returns public.qa_pointers
language plpgsql
security invoker
set search_path = public
as $$
declare
  n integer;
  r public.qa_pointers;
begin
  update public.projects
     set next_pointer_number = next_pointer_number + 1
   where id = p_project_id
  returning next_pointer_number - 1 into n;

  if n is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  insert into public.qa_pointers (
    project_id, pointer_number, screen_name, notes,
    screen_state, target_type, target_selector, target_label,
    anchor_x, anchor_y, viewport_width, viewport_height
  ) values (
    p_project_id, n, p_screen_name, coalesce(p_notes, ''),
    coalesce(p_screen_state, 'Default'), coalesce(p_target_type, 'screen'), p_target_selector, p_target_label,
    p_anchor_x, p_anchor_y, p_viewport_width, p_viewport_height
  )
  returning * into r;

  return r;
end;
$$;


-- ---------------------------------------------------------------
-- Lock everything down. The browser never talks to these tables:
-- all access goes through /api using the server-only secret key,
-- which bypasses RLS. With RLS on and no policies, the public
-- (anon / authenticated) keys can read or write nothing.
-- ---------------------------------------------------------------
alter table public.projects    enable row level security;
alter table public.qa_pointers enable row level security;

revoke all on table public.projects    from anon, authenticated;
revoke all on table public.qa_pointers from anon, authenticated;

revoke all on function public.create_qa_pointer(text, text, text, text, text, text, text, double precision, double precision, integer, integer) from public, anon, authenticated;
grant execute on function public.create_qa_pointer(text, text, text, text, text, text, text, double precision, double precision, integer, integer) to service_role;
