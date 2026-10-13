-- Run once in the Supabase SQL Editor. Existing rows are preserved on reruns.
create table if not exists public.fengwei_account_records (
  namespace text not null,
  key text collate "C" not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  primary key (namespace, key)
);

-- Account and password records are server-only. No browser role has access.
alter table public.fengwei_account_records enable row level security;
revoke all on public.fengwei_account_records from public, anon, authenticated;
grant select, insert, update, delete on public.fengwei_account_records to service_role;

notify pgrst, 'reload schema';
