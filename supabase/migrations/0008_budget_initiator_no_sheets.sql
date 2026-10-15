-- Инициатор не читает листы бюджета.
--
-- До сих пор «Инициатор» (учителя, завкафедрами, замы — все, кто подаёт
-- заявки-потребности) читал budget.kv своего филиала целиком: ФОТ,
-- штатное расписание, планы. В интерфейсе это был режим просмотра листов
-- ПУ, а через API — вообще все листы. Инициатору нужна только подача
-- заявок; бюджет — для экономистов, бухгалтерии и руководства.
--
-- budget.can_read_branch не трогаем: по нему подписанты с ролью
-- «Инициатор» (зам. по АХР, закупщик) видят поданные заявки своего
-- филиала (requests_read, 0004). Закрываем именно листы и их журнал.
--
-- Применять в SQL Editor целиком. Повторный запуск безопасен.

create or replace function budget.can_read_sheets(b text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select budget.claim('role') <> 'initiator' and budget.can_read_branch(b)
$$;

revoke execute on function budget.can_read_sheets(text) from public, anon;
grant execute on function budget.can_read_sheets(text) to authenticated;

drop policy if exists kv_read on budget.kv;
create policy kv_read on budget.kv
    for select to authenticated
    using (budget.can_read_sheets(branch));

drop policy if exists kv_audit_read on budget.kv_audit;
create policy kv_audit_read on budget.kv_audit
    for select to authenticated
    using (budget.can_read_sheets(branch));
