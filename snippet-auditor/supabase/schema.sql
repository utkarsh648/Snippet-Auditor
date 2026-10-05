-- Snippet Auditor — Supabase schema (MVP)
-- Run once in the Supabase SQL editor. Safe to re-run.

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
-- Atomic pointer creation: reserve the next number and insert in one step.
-- ---------------------------------------------------------------
create or replace function public.create_qa_pointer(
  p_project_id text,
  p_screen_name text,
  p_notes text
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

  insert into public.qa_pointers (project_id, pointer_number, screen_name, notes)
  values (p_project_id, n, p_screen_name, coalesce(p_notes, ''))
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

revoke all on function public.create_qa_pointer(text, text, text) from public, anon, authenticated;
grant execute on function public.create_qa_pointer(text, text, text) to service_role;
