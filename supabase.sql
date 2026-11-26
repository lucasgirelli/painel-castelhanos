-- Painel de Locações | Castelhanos: estrutura do banco no Supabase.
-- Cole tudo no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

-- Quem tem acesso ao painel (todos que estão aqui veem e editam).
create table if not exists public.membros (
  email text primary key,
  nome text,
  criado_em timestamptz not null default now()
);

-- Uma linha por locação e uma por despesa; "dados" guarda o registro inteiro do app.
create table if not exists public.locacoes (
  id text primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now(),
  atualizado_por text default (auth.jwt() ->> 'email')
);

create table if not exists public.despesas (
  id text primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now(),
  atualizado_por text default (auth.jwt() ->> 'email')
);

-- Registra quem e quando alterou por último.
create or replace function public.marcar_alteracao() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.jwt() ->> 'email';
  return new;
end $$;

drop trigger if exists locacoes_alteracao on public.locacoes;
create trigger locacoes_alteracao before insert or update on public.locacoes
  for each row execute function public.marcar_alteracao();
drop trigger if exists despesas_alteracao on public.despesas;
create trigger despesas_alteracao before insert or update on public.despesas
  for each row execute function public.marcar_alteracao();

-- A pessoa logada está na lista de membros?
create or replace function public.eh_membro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.membros
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.eh_membro() from public;
grant execute on function public.eh_membro() to authenticated;

-- Regras de acesso: só membros logados leem e escrevem. Sem login, nada.
alter table public.membros  enable row level security;
alter table public.locacoes enable row level security;
alter table public.despesas enable row level security;

drop policy if exists "membros veem membros" on public.membros;
create policy "membros veem membros" on public.membros
  for select to authenticated using (public.eh_membro());

drop policy if exists "membros acessam locacoes" on public.locacoes;
create policy "membros acessam locacoes" on public.locacoes
  for all to authenticated using (public.eh_membro()) with check (public.eh_membro());

drop policy if exists "membros acessam despesas" on public.despesas;
create policy "membros acessam despesas" on public.despesas
  for all to authenticated using (public.eh_membro()) with check (public.eh_membro());

-- Tempo real: mudanças de uma pessoa aparecem na tela das outras.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'locacoes') then
    alter publication supabase_realtime add table public.locacoes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'despesas') then
    alter publication supabase_realtime add table public.despesas;
  end if;
end $$;

-- Para dar acesso a alguém: inclua o e-mail aqui (e crie o usuário em Authentication > Users).
-- insert into public.membros (email, nome) values ('pessoa@exemplo.com', 'Nome');
