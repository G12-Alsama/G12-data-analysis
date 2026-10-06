-- Minimal Supabase stand-ins so the repo's migrations (0001…) can be applied to a
-- plain, THROWAWAY local PostgreSQL for opt-in integration tests. Not for any real
-- database. Provides only what the migrations reference: the API roles, the `auth`
-- schema (users + uid()/role() reading the PostgREST JWT-claim GUCs) and one user
-- (0043's seed attributes its rows to the oldest auth user).
-- Roles are cluster-wide (they outlive a scratch database), so create idempotently.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
grant usage on schema public to anon, authenticated, service_role;
insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000001', 'scratch@example.test');
