-- ============================================================================
-- 0051 — which periods a year expects (drives "ready for certificates")
--
-- Until now "the Overall is ready" meant "both the February and the May sitting are
-- locked", spelled into the app. This makes the list of EXPECTED periods a property
-- of the year, so a year can be configured to expect only some periods, or (once a
-- new period exists in the registry — lib/data/periods.ts) more of them.
--
--   exam_years.expected_periods sitting_period[] NOT NULL DEFAULT '{february,may}'
--
-- A year is ready when every expected period has a LOCKED sitting.
--
-- EXISTING DATA BEHAVES EXACTLY AS BEFORE: every existing year gets the default
-- {february,may}, which is the pair the app required until now. (Adding a NOT NULL
-- column with a constant default is a metadata-only change on PostgreSQL 11+: no table
-- rewrite, no long lock.) A period added to the enum later does NOT change any
-- existing year — it must be opted into with set_year_expected_periods().
--
-- Also adds public.set_year_expected_periods(p_year_id, p_periods): the only way the
-- app changes the list (exam_years has no client write policy). Same gate as moving a
-- year between centres (general.manage_centres). The list must be non-empty and is
-- stored de-duplicated, in enum order.
--
-- Touches no fact table and no scoring path.
-- Order: apply after 0050. Reversible: 0051_year_expected_periods.rollback.sql.
--
-- VERIFY (after applying):
--   select name, expected_periods from exam_years;                  -- all {february,may}
--   select column_default from information_schema.columns
--    where table_name = 'exam_years' and column_name = 'expected_periods';
-- ============================================================================

begin;

set local lock_timeout = '30s';

alter table public.exam_years
  add column if not exists expected_periods public.sitting_period[] not null default '{february,may}';

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'exam_years_expected_periods_nonempty' and conrelid = 'public.exam_years'::regclass
  ) then
    alter table public.exam_years
      add constraint exam_years_expected_periods_nonempty check (cardinality(expected_periods) >= 1);
  end if;
end $$;

create or replace function public.set_year_expected_periods(
  p_year_id uuid, p_periods public.sitting_period[])
returns public.exam_years
language plpgsql security definer set search_path = public, app as $$
declare
  y_before public.exam_years;
  y_after  public.exam_years;
  v_list   public.sitting_period[];
begin
  if not app.can_do(null, 'general.manage_centres') then
    raise exception 'not authorized';
  end if;

  select * into y_before from public.exam_years where id = p_year_id;
  if not found then raise exception 'exam year not found'; end if;

  -- De-duplicated, in enum order; refuse an empty / null list (a year must expect something).
  select coalesce(array_agg(p order by p), '{}') into v_list
    from (select distinct unnest(p_periods) as p) s;
  if cardinality(v_list) < 1 then
    raise exception 'a year must expect at least one period';
  end if;

  -- Idempotent fast path: nothing to write or audit.
  if y_before.expected_periods = v_list then
    return y_before;
  end if;

  update public.exam_years set expected_periods = v_list, updated_at = now()
   where id = p_year_id
  returning * into y_after;

  perform app.audit(null, 'set_expected_periods', 'exam_year', p_year_id::text,
                    jsonb_build_object('expected_periods', y_before.expected_periods),
                    jsonb_build_object('expected_periods', y_after.expected_periods));
  return y_after;
end $$;

revoke execute on function public.set_year_expected_periods(uuid, public.sitting_period[]) from public;
grant  execute on function public.set_year_expected_periods(uuid, public.sitting_period[]) to authenticated;

commit;
