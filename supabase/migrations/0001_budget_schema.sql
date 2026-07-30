-- Бюджетная система НАО «РФМШ» — хранилище данных.
--
-- Проект Supabase общий с fizmat.abai.live: в нём около 17 700 учётных
-- записей, из которых к бюджету относятся полтора десятка. Поэтому всё
-- лежит в отдельной схеме budget, а таблицы abai.live не затрагиваются.
--
-- Формат хранения — «ключ-значение»: страницы бюджета считают по своим
-- формулам, сверенным с исходными книгами Excel, и держат результат в
-- localStorage под ключом вида rb_svodnaya_almaty. Здесь ровно те же ключи,
-- поэтому страницы менять не нужно: слой синхронизации подставляет им данные
-- из базы вместо локальных.
--
-- Роль и филиал берутся из app_metadata JWT. Именно app_metadata, а не
-- user_metadata: первое проставляет только администратор через сервисный
-- ключ, второе пользователь может изменить сам.

create schema if not exists budget;

/* ── Разбор JWT ──────────────────────────────────────────────────── */

create or replace function budget.claim(name text)
returns text
language sql
stable
set search_path = ''
as $$
    select coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb
            -> 'app_metadata' ->> name,
        ''
    )
$$;

create or replace function budget.claim_email()
returns text
language sql
stable
set search_path = ''
as $$
    select coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
        ''
    )
$$;

/* ── Кто что может ───────────────────────────────────────────────── */

-- Учётка без роли в бюджете не участвует: в проекте тысячи посторонних
-- пользователей abai.live, и по умолчанию доступа у них нет
create or replace function budget.has_role()
returns boolean
language sql
stable
set search_path = ''
as $$
    select budget.claim('role') in ('admin', 'view', 'edit', 'limited', 'initiator')
$$;

-- Филиал видит только свой город. Администратор и центральный аппарат
-- видят все — на них и держится консолидация: чтобы сложить Алматы с
-- Астаной, надо иметь право прочитать оба.
create or replace function budget.can_read_branch(b text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select case
        when not budget.has_role()            then false
        when budget.claim('role') = 'admin'   then true
        when budget.claim('branch') = 'nao'   then true
        else budget.claim('branch') = b
    end
$$;

-- Писать могут роли с правом редактирования и только в свой филиал;
-- администратор — в любой
create or replace function budget.can_write_branch(b text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select case
        when budget.claim('role') = 'admin'                     then true
        when budget.claim('role') not in ('edit', 'limited')    then false
        else budget.claim('branch') = b
    end
$$;

/* ── Данные ──────────────────────────────────────────────────────── */

create table if not exists budget.kv (
    branch        text        not null
                  check (branch in ('nao', 'almaty', 'astana', 'uralsk')),
    key           text        not null,
    value         jsonb       not null,
    updated_at    timestamptz not null default now(),
    updated_by    uuid,
    updated_email text,
    primary key (branch, key)
);

comment on table budget.kv is
    'Таблицы бюджета: одна строка — одна страница одного филиала. '
    'key совпадает с ключом localStorage на странице.';

create index if not exists kv_updated_at_idx on budget.kv (updated_at desc);
create index if not exists kv_key_idx        on budget.kv (key);

-- Журнал: кто и когда менял цифры. Пишется триггером, руками недоступен.
create table if not exists budget.kv_audit (
    id            bigserial primary key,
    branch        text        not null,
    key           text        not null,
    op            text        not null,
    value         jsonb,
    changed_at    timestamptz not null default now(),
    changed_by    uuid,
    changed_email text
);

create index if not exists kv_audit_key_idx
    on budget.kv_audit (branch, key, changed_at desc);

create or replace function budget.stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.updated_at    := now();
    new.updated_by    := auth.uid();
    new.updated_email := budget.claim_email();

    insert into budget.kv_audit (branch, key, op, value, changed_by, changed_email)
    values (new.branch, new.key, tg_op, new.value, new.updated_by, new.updated_email);

    return new;
end
$$;

drop trigger if exists kv_stamp on budget.kv;
create trigger kv_stamp
    before insert or update on budget.kv
    for each row execute function budget.stamp();

/* ── Разграничение доступа ───────────────────────────────────────── */

alter table budget.kv       enable row level security;
alter table budget.kv_audit enable row level security;

drop policy if exists kv_read   on budget.kv;
drop policy if exists kv_insert on budget.kv;
drop policy if exists kv_update on budget.kv;
drop policy if exists kv_delete on budget.kv;

create policy kv_read on budget.kv
    for select to authenticated
    using (budget.can_read_branch(branch));

create policy kv_insert on budget.kv
    for insert to authenticated
    with check (budget.can_write_branch(branch));

create policy kv_update on budget.kv
    for update to authenticated
    using (budget.can_write_branch(branch))
    with check (budget.can_write_branch(branch));

create policy kv_delete on budget.kv
    for delete to authenticated
    using (budget.can_write_branch(branch));

drop policy if exists kv_audit_read on budget.kv_audit;

-- Журнал только на чтение: строки в него кладёт триггер, он security definer
create policy kv_audit_read on budget.kv_audit
    for select to authenticated
    using (budget.can_read_branch(branch));

/* ── Права ───────────────────────────────────────────────────────── */

grant usage on schema budget to authenticated;
grant select, insert, update, delete on budget.kv to authenticated;
grant select on budget.kv_audit to authenticated;

-- Неавторизованным в схеме делать нечего
revoke all on schema budget from anon, public;
revoke all on all tables in schema budget from anon, public;
