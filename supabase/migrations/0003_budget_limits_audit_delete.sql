-- Размеры, общие ключи и удаления в журнале.
--
-- После 0002 остались три места:
--
--   1. Размер value не ограничен: одна запись могла раздуть таблицу и
--      журнал (каждая правка копируется в kv_audit).
--   2. Год бюджета (budget_year, budget_year_end) — общая настройка, она
--      живёт только в строке ЦА (см. GLOBALS в db-sync.js). Филиал мог
--      завести свою копию, и страницы видели бы два разных года.
--   3. Журнал писал INSERT и UPDATE, а удаление строки проходило бесследно —
--      вместе с последним значением.
--
-- Ограничения (1 и 2) добавлены как NOT VALID: новые и изменённые строки
-- проверяются, а уже лежащие в базе миграцию не уронят. Убедиться, что
-- старых нарушений нет, и включить проверку целиком:
--
--     select branch, key, octet_length(value::text) from budget.kv
--      where octet_length(value::text) > 2097152
--         or (key ~ '^budget_year' and branch <> 'nao');
--
--     alter table budget.kv validate constraint kv_value_size;
--     alter table budget.kv validate constraint kv_budget_year_nao_only;

/* ── 1. Депозит — общий для всех ─────────────────────────────────── */
-- Депозит ведут все: у каждого города свой ключ deposit в своей строке, и
-- права на него те же, что на любой лист (can_read_branch/can_write_branch
-- из 0001/0002). Черновик этой миграции закрывал депозит для всех, кроме
-- администратора и главбуха ЦА, — если его где-то успели применить, убираем.

drop policy if exists kv_deposit_guard on budget.kv;
drop policy if exists kv_audit_deposit_guard on budget.kv_audit;
alter table budget.kv drop constraint if exists kv_deposit_nao_only;
drop function if exists budget.can_touch_key(text);

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
