-- Ужесточение доступа к данным бюджета.
--
-- Первая миграция закрыла главное: филиал пишет только свой город, чужие
-- строки не отдаются. Аудит показал ещё четыре места, где можно подтянуть.
--
--   1. Функции схемы исполнимы кем угодно (PUBLIC), включая anon и все
--      17 тысяч посторонних учётных записей проекта. Сами по себе они
--      безобидны, но отдавать наружу то, чем никто снаружи не пользуется,
--      незачем.
--   2. «Инициатор» из центрального аппарата видел расходы всех филиалов.
--      Его роль — подавать заявки-потребности по своему филиалу, полный
--      обзор бюджета ему не нужен.
--   3. У ключа и филиала не было ограничений по длине и на пустоту —
--      таблицу можно было засорить мусором.
--   4. Права для будущих таблиц схемы не заданы: новая таблица получила бы
--      настройки по умолчанию, а не осознанные.

/* ── 1. Функции — только вошедшим ────────────────────────────────── */

revoke execute on all functions in schema budget from public, anon;

grant execute on function budget.claim(text)            to authenticated;
grant execute on function budget.claim_email()          to authenticated;
grant execute on function budget.has_role()             to authenticated;
grant execute on function budget.can_read_branch(text)  to authenticated;
grant execute on function budget.can_write_branch(text) to authenticated;

-- budget.stamp() — триггерная и security definer. Её никто не должен
-- вызывать руками: снаружи она всё равно упадёт без TG_OP, но пусть
-- и права это подтверждают.
revoke execute on function budget.stamp() from public, anon, authenticated;

/* ── 2. «Инициатор» видит только свой филиал ─────────────────────── */

create or replace function budget.can_read_branch(b text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select case
        when not budget.has_role()                then false
        when budget.claim('role') = 'admin'       then true
        -- Заявитель не должен видеть расходы других филиалов даже из ЦА
        when budget.claim('role') = 'initiator'   then budget.claim('branch') = b
        when budget.claim('branch') = 'nao'       then true
        else budget.claim('branch') = b
    end
$$;

/* ── 3. Ключ и филиал — в разумных рамках ────────────────────────── */

alter table budget.kv
    drop constraint if exists kv_key_sane;
alter table budget.kv
    add constraint kv_key_sane
    check (length(key) between 1 and 200 and key !~ '^\s*$');

alter table budget.kv_audit
    drop constraint if exists kv_audit_branch_known;
alter table budget.kv_audit
    add constraint kv_audit_branch_known
    check (branch in ('nao', 'almaty', 'astana', 'uralsk'));

/* ── 4. Будущие объекты схемы ────────────────────────────────────── */
-- Новая таблица в схеме не должна автоматически оказаться доступной

alter default privileges in schema budget
    revoke all on tables from public, anon;
alter default privileges in schema budget
    revoke all on sequences from public, anon;
alter default privileges in schema budget
    revoke all on functions from public, anon;

/* ── 5. Журнал правок нельзя переписать ──────────────────────────── */
-- Политик на INSERT/UPDATE/DELETE у kv_audit нет и не будет: строки туда
-- кладёт только триггер, а он security definer. Здесь лишь убираем
-- лишние права, если их кто-то выдаст в будущем.

revoke insert, update, delete, truncate on budget.kv_audit from authenticated, anon, public;
