-- Депозит, размеры, общие ключи и удаления в журнале.
--
-- После 0002 остались четыре места:
--
--   1. Депозит (страница deposit.html, ключ deposit филиала nao) ведёт
--      главный бухгалтер ЦА — учётка «Работа (огранич.)» центрального
--      аппарата. Страницу auth.js показывает только ей и администратору, но
--      база отдавала строку любому, кто читает ЦА: «Просмотру» и «Работе»
--      из ЦА, а через журнал правок — и все прежние версии.
--   2. Размер value не ограничен: одна запись могла раздуть таблицу и
--      журнал (каждая правка копируется в kv_audit).
--   3. Год бюджета (budget_year, budget_year_end) — общая настройка, она
--      живёт только в строке ЦА (см. GLOBALS в db-sync.js). Филиал мог
--      завести свою копию, и страницы видели бы два разных года.
--   4. Журнал писал INSERT и UPDATE, а удаление строки проходило бесследно —
--      вместе с последним значением.
--
-- Ограничения (2, 3 и запрет депозита вне ЦА) добавлены как NOT VALID:
-- новые и изменённые строки проверяются, а уже лежащие в базе миграцию не
-- уронят. Убедиться, что старых нарушений нет, и включить проверку целиком:
--
--     select branch, key, octet_length(value::text) from budget.kv
--      where octet_length(value::text) > 2097152
--         or (key ~ '^(deposit(_|$)|budget_year)' and branch <> 'nao');
--
--     alter table budget.kv validate constraint kv_value_size;
--     alter table budget.kv validate constraint kv_deposit_nao_only;
--     alter table budget.kv validate constraint kv_budget_year_nao_only;

/* ── 1. Депозит — только администратору и бухгалтеру ЦА ──────────── */

-- Ключи депозита: deposit и всё, что от него производно (deposit_…)
create or replace function budget.can_touch_key(k text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select case
        when k ~ '^deposit(_|$)' then
            budget.claim('role') = 'admin'
            or (budget.claim('role') = 'limited' and budget.claim('branch') = 'nao')
        else true
    end
$$;

revoke execute on function budget.can_touch_key(text) from public, anon;
grant execute on function budget.can_touch_key(text) to authenticated;

-- Ограничительные (restrictive) политики складываются с уже существующими
-- через И: kv_read/kv_insert/kv_update/kv_delete из 0001 остаются как есть,
-- а к ним добавляется условие на ключ
drop policy if exists kv_deposit_guard on budget.kv;
create policy kv_deposit_guard on budget.kv
    as restrictive
    for all to authenticated
    using (budget.can_touch_key(key))
    with check (budget.can_touch_key(key));

-- В журнале лежат все прежние значения — закрываем и его
drop policy if exists kv_audit_deposit_guard on budget.kv_audit;
create policy kv_audit_deposit_guard on budget.kv_audit
    as restrictive
    for select to authenticated
    using (budget.can_touch_key(key));

-- Депозит один на всю организацию и хранится в строке ЦА
alter table budget.kv
    drop constraint if exists kv_deposit_nao_only;
alter table budget.kv
    add constraint kv_deposit_nao_only
    check (key !~ '^deposit(_|$)' or branch = 'nao')
    not valid;

/* ── 2. Размер значения ──────────────────────────────────────────── */
-- 2 МБ текста JSON. Это с большим запасом: весь localStorage браузера —
-- около 5 млн символов, а самый крупный лист импорта — десятки килобайт.
-- Считаем по тексту, а не pg_column_size: тот меряет сжатое значение, и
-- хорошо сжимаемый мусор прошёл бы в разы больше лимита.

alter table budget.kv
    drop constraint if exists kv_value_size;
alter table budget.kv
    add constraint kv_value_size
    check (octet_length(value::text) <= 2097152)
    not valid;

/* ── 3. Год бюджета — только в строке ЦА ─────────────────────────── */

alter table budget.kv
    drop constraint if exists kv_budget_year_nao_only;
alter table budget.kv
    add constraint kv_budget_year_nao_only
    check (key !~ '^budget_year' or branch = 'nao')
    not valid;

/* ── 4. Удаление — тоже в журнал ─────────────────────────────────── */
-- INSERT и UPDATE журналирует budget.stamp() (before-триггер: он ещё и
-- проставляет updated_*). Для удаления — отдельный after-триггер тем же
-- способом: строка журнала с op = 'DELETE' и последним значением, чтобы
-- удалённое можно было восстановить.

create or replace function budget.audit_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into budget.kv_audit (branch, key, op, value, changed_by, changed_email)
    values (old.branch, old.key, tg_op, old.value, auth.uid(), budget.claim_email());

    return old;
end
$$;

-- Как и stamp(), руками её никто вызывать не должен
revoke execute on function budget.audit_delete() from public, anon, authenticated;

drop trigger if exists kv_audit_delete on budget.kv;
create trigger kv_audit_delete
    after delete on budget.kv
    for each row execute function budget.audit_delete();
