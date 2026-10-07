-- Snippet Auditor — migration 002: visual QA annotations
-- Adds click-to-anchor fields to qa_pointers. Additive only: no column is
-- removed, and existing notes become screen-level notes (target_type = 'screen').
-- Safe to re-run. Already included in schema.sql for fresh installs.

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

revoke all on function public.create_qa_pointer(text, text, text, text, text, text, text, double precision, double precision, integer, integer) from public, anon, authenticated;
grant execute on function public.create_qa_pointer(text, text, text, text, text, text, text, double precision, double precision, integer, integer) to service_role;
