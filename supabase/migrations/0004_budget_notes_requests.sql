-- Примечания к листам и заявки-потребности (приложение № 2).
--
-- Заказчик просил (12.10.2026):
--   1. «В каждом документе окошечко примечание, чтобы оставлять комменты».
--   2. Инициаторы заполняют заявку-потребность на товары, работы, услуги
--      прямо в системе и подписывают её ЭЦП вместе с согласующими.
--
-- В budget.kv ни то, ни другое не ложится:
--   * kv пишут только роли edit/limited и только в свой город, а
--     комментировать должны и директор (view), и ЦА по листу филиала;
--   * инициатору kv закрыт совсем (0001), и правильно: дай ему запись в
--     строку филиала — он перепишет любой лист бюджета.
-- Поэтому две отдельные таблицы со своими правилами.
--
-- Кто подписывает заявку — поле signer в app_metadata учётки:
--   ahr      — заместитель директора по АХР          («Согласовано»)
--   zakup    — специалист по закупкам                 («Согласовано»)
--   economist— экономист (или любая учётка с ролью edit) («Согласовано»)
--   director — директор филиала                      («Утверждаю»)
-- Инициатор подписывает свою заявку сам, отдельного поля не нужно.
--
-- Применять в SQL Editor целиком. Повторный запуск безопасен.

/* ── Общие проверки ──────────────────────────────────────────────── */

-- Роли, которые видят бюджет филиала целиком (не инициатор)
create or replace function budget.is_staff()
returns boolean
language sql
stable
set search_path = ''
as $$
    select budget.claim('role') in ('admin', 'view', 'edit', 'limited')
$$;

-- Может ли текущая учётка поставить подпись в графе slot заявки филиала b.
-- Графу «Инициатор» проверяет триггер (это автор заявки).
create or replace function budget.can_sign(slot text, b text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select case slot
        when 'ahr'       then budget.claim('signer') = 'ahr'
                              and budget.claim('branch') = b
        when 'zakup'     then budget.claim('signer') = 'zakup'
                              and budget.claim('branch') = b
        when 'director'  then budget.claim('signer') = 'director'
                              and budget.claim('branch') = b
        -- Экономист филиала или ЦА (у ЦА чтение всех филиалов)
        when 'economist' then (budget.claim('role') = 'edit'
                               or budget.claim('signer') = 'economist')
                              and budget.can_read_branch(b)
        else false
    end
$$;

/* ── Заявки-потребности ──────────────────────────────────────────── */

create table if not exists budget.requests (
    id            uuid        primary key default gen_random_uuid(),
    no            bigint      generated always as identity,
    branch        text        not null
                  check (branch in ('nao', 'almaty', 'astana', 'uralsk')),
    status        text        not null default 'draft'
                  check (status in ('draft', 'submitted', 'returned',
                                    'approved', 'rejected')),
    -- Содержимое формы: дата, должность, ФИО, строки, итог
    doc           jsonb       not null default '{}'::jsonb
                  check (jsonb_typeof(doc) = 'object'
                         and octet_length(doc::text) <= 262144),
    -- Подписи по порядку: [{slot, kind, cms, cert, iin, hash, uid, email,
    -- name, title, at}]. Подпись ЭЦП (CMS) — десятки килобайт, отсюда лимит
    signatures    jsonb       not null default '[]'::jsonb
                  check (jsonb_typeof(signatures) = 'array'
                         and octet_length(signatures::text) <= 1048576),
    author        uuid        not null default auth.uid(),
    author_email  text        not null default '',
    author_name   text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    updated_email text
);

comment on table budget.requests is
    'Заявки-потребности на товары, работы и услуги (приложение № 2): '
    'инициатор заполняет и подписывает, согласующие подписывают ЭЦП.';

create index if not exists requests_branch_idx
    on budget.requests (branch, created_at desc);
create index if not exists requests_author_idx
    on budget.requests (author, created_at desc);

/* Вся логика переходов — здесь, а не в браузере: политика RLS решает
   «можно ли трогать строку», но не «что именно в ней поменять».

   Статусы:
     draft     — черновик, видит только автор;
     submitted — автор подписал, заявка ушла на согласование;
     approved  — подписал директор («Утверждаю»);
     returned  — согласующий вернул на доработку, подписи сняты;
     rejected  — отклонена.
   submitted и approved выставляются сами по подписям. Руками можно только
   вернуть/отклонить (согласующий) или отозвать в черновик (автор, пока
   никто, кроме него, не подписал). */
create or replace function budget.requests_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    me        uuid    := auth.uid();
    is_author boolean;
    reviewer  boolean := budget.is_staff() or budget.claim('signer') <> '';
    base      jsonb;
    sigs      jsonb;
    s         jsonb;
    slot      text;
    n_base    int;
    i         int;
    do_reset     boolean := false;
begin
    if tg_op = 'INSERT' then
        new.author       := me;
        new.author_email := budget.claim_email();
        new.author_name  := nullif(budget.claim('name'), '');
        new.created_at   := now();
        new.updated_at   := now();
        new.updated_email:= new.author_email;
        new.status       := 'draft';
        -- Подписывают уже сохранённую заявку: подпись ставится на её номер
        new.signatures   := '[]'::jsonb;
        return new;
    end if;

    if new.id <> old.id
       or new.branch <> old.branch
       or new.author <> old.author
       or new.author_email <> old.author_email
       or new.created_at <> old.created_at then
        raise exception 'Служебные поля заявки менять нельзя';
    end if;

    is_author := old.author = me;
    base := old.signatures;

    /* 1. Ручные переходы */
    if new.status is distinct from old.status then
        if new.status in ('returned', 'rejected') then
            if not reviewer or old.status not in ('submitted', 'approved') then
                raise exception 'Вернуть или отклонить заявку может только согласующий';
            end if;
            if new.status = 'returned' then
                do_reset := true;
            end if;
        elsif new.status = 'draft' then
            if not is_author or old.status not in ('submitted', 'returned') then
                raise exception 'Отозвать заявку может только её автор';
            end if;
            if exists (select 1 from jsonb_array_elements(old.signatures) e
                        where e->>'slot' <> 'initiator') then
                raise exception 'Заявку уже подписали согласующие — отозвать нельзя, попросите вернуть на доработку';
            end if;
            do_reset := true;
        else
            -- submitted/approved — только по подписям
            new.status := old.status;
        end if;
    end if;

    if do_reset then
        base := '[]'::jsonb;
        new.signatures := '[]'::jsonb;
    end if;

    /* 2. Содержимое меняет только автор и только до своей подписи */
    if new.doc is distinct from old.doc then
        if not is_author
           or new.status not in ('draft', 'returned')
           or jsonb_array_length(base) > 0 then
            raise exception 'Подписанную или чужую заявку менять нельзя';
        end if;
    end if;

    /* 3. Новые подписи — только дописываются в конец */
    if not do_reset and new.signatures is distinct from base then
        if jsonb_typeof(new.signatures) <> 'array'
           or jsonb_array_length(new.signatures) < jsonb_array_length(base) then
            raise exception 'Подписи нельзя удалять';
        end if;
        n_base := jsonb_array_length(base);
        for i in 0 .. n_base - 1 loop
            if (new.signatures -> i) is distinct from (base -> i) then
                raise exception 'Подписи нельзя менять';
            end if;
        end loop;

        sigs := base;
        for i in n_base .. jsonb_array_length(new.signatures) - 1 loop
            s := new.signatures -> i;
            slot := s ->> 'slot';

            if exists (select 1 from jsonb_array_elements(sigs) e
                        where e->>'slot' = slot) then
                raise exception 'Графа «%» уже подписана', slot;
            end if;

            if slot = 'initiator' then
                if not is_author or new.status not in ('draft', 'returned') then
                    raise exception 'Графу инициатора подписывает автор заявки';
                end if;
            elsif slot in ('ahr', 'zakup', 'economist', 'director') then
                if new.status not in ('submitted', 'approved')
                   or not exists (select 1 from jsonb_array_elements(sigs) e
                                   where e->>'slot' = 'initiator') then
                    raise exception 'Заявка ещё не подана инициатором';
                end if;
                if not budget.can_sign(slot, old.branch) then
                    raise exception 'Нет права подписи в графе «%»', slot;
                end if;
            else
                raise exception 'Неизвестная графа подписи: %', slot;
            end if;

            if coalesce(s->>'kind', '') not in ('ecp', 'simple') then
                raise exception 'Вид подписи: ecp или simple';
            end if;
            if s->>'kind' = 'ecp' and coalesce(s->>'cms', '') = '' then
                raise exception 'Подпись ЭЦП пришла пустой';
            end if;

            -- Кто и когда — из токена и часов сервера, не из браузера
            s := s || jsonb_build_object(
                'uid',   me,
                'email', budget.claim_email(),
                'name',  nullif(budget.claim('name'), ''),
                'title', nullif(budget.claim('title'), ''),
                'at',    now()
            );
            sigs := sigs || jsonb_build_array(s);

            if slot = 'initiator' then
                new.status := 'submitted';
            elsif slot = 'director' then
                new.status := 'approved';
            end if;
        end loop;
        new.signatures := sigs;
    end if;

    new.updated_at    := now();
    new.updated_email := budget.claim_email();
    return new;
end
$$;

drop trigger if exists requests_guard on budget.requests;
create trigger requests_guard
    before insert or update on budget.requests
    for each row execute function budget.requests_guard();

alter table budget.requests enable row level security;

drop policy if exists requests_read   on budget.requests;
drop policy if exists requests_insert on budget.requests;
drop policy if exists requests_update on budget.requests;
drop policy if exists requests_delete on budget.requests;

-- Автор видит свои. Поданные видят бюджетные роли и подписанты филиала
-- (ЦА — всех филиалов). Чужие черновики не видит никто.
create policy requests_read on budget.requests
    for select to authenticated
    using (
        author = auth.uid()
        or (
            status <> 'draft'
            and budget.can_read_branch(branch)
            and (budget.is_staff() or budget.claim('signer') <> '')
        )
    );

-- Подать можно только в свой филиал
create policy requests_insert on budget.requests
    for insert to authenticated
    with check (
        budget.has_role()
        and (branch = budget.claim('branch') or budget.claim('role') = 'admin')
    );

create policy requests_update on budget.requests
    for update to authenticated
    using (
        author = auth.uid()
        or (
            status <> 'draft'
            and budget.can_read_branch(branch)
            and (budget.is_staff() or budget.claim('signer') <> '')
        )
    )
    with check (true);

-- Удалить — только свой неподписанный черновик или возвращённую
create policy requests_delete on budget.requests
    for delete to authenticated
    using (
        author = auth.uid()
        and status in ('draft', 'returned')
        and jsonb_array_length(signatures) = 0
    );

/* ── Примечания ──────────────────────────────────────────────────── */

create table if not exists budget.notes (
    id           bigserial   primary key,
    branch       text        not null
                 check (branch in ('nao', 'almaty', 'astana', 'uralsk')),
    -- Лист (pu-income-pu.html) или заявка (zayavka:<uuid>)
    page         text        not null
                 check (length(page) between 1 and 200),
    body         text        not null
                 check (length(body) between 1 and 4000 and body !~ '^\s*$'),
    author       uuid        not null default auth.uid(),
    author_email text        not null default '',
    author_name  text,
    created_at   timestamptz not null default now()
);

comment on table budget.notes is
    'Примечания (комментарии) к листам бюджета и к заявкам-потребностям.';

create index if not exists notes_page_idx
    on budget.notes (branch, page, created_at);

-- Примечание к заявке видит тот, кто видит саму заявку (RLS requests
-- срабатывает внутри exists). К листу — бюджетные роли филиала.
create or replace function budget.can_see_note(b text, p text)
returns boolean
language sql
stable
set search_path = ''
as $$
    select case
        when p like 'zayavka:%' then exists (
            select 1 from budget.requests r
             where r.id::text = substr(p, 9) and r.branch = b
        )
        else budget.is_staff() and budget.can_read_branch(b)
    end
$$;

create or replace function budget.notes_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.author       := auth.uid();
    new.author_email := budget.claim_email();
    new.author_name  := nullif(budget.claim('name'), '');
    new.created_at   := now();
    return new;
end
$$;

drop trigger if exists notes_stamp on budget.notes;
create trigger notes_stamp
    before insert on budget.notes
    for each row execute function budget.notes_stamp();

alter table budget.notes enable row level security;

drop policy if exists notes_read   on budget.notes;
drop policy if exists notes_insert on budget.notes;
drop policy if exists notes_delete on budget.notes;

create policy notes_read on budget.notes
    for select to authenticated
    using (budget.can_see_note(branch, page));

create policy notes_insert on budget.notes
    for insert to authenticated
    with check (budget.can_see_note(branch, page));

-- Править нельзя (политики UPDATE нет), удалить — своё
create policy notes_delete on budget.notes
    for delete to authenticated
    using (author = auth.uid() or budget.claim('role') = 'admin');

/* ── Права ───────────────────────────────────────────────────────── */

grant select, insert, update, delete on budget.requests to authenticated;
grant select, insert, delete on budget.notes to authenticated;
grant usage on sequence budget.notes_id_seq to authenticated;
grant usage on sequence budget.requests_no_seq to authenticated;

revoke all on budget.requests, budget.notes from anon, public;

grant execute on function budget.is_staff()               to authenticated;
grant execute on function budget.can_sign(text, text)     to authenticated;
grant execute on function budget.can_see_note(text, text) to authenticated;
-- Триггерные — руками не вызываются
revoke execute on function budget.requests_guard() from public, anon, authenticated;
revoke execute on function budget.notes_stamp()    from public, anon, authenticated;
