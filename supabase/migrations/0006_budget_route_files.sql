-- Маршрут согласования заявок и вложения (ЦП/КП).
--
-- Решение заказчика (15.10.2026, переписка финотдела):
--   1. Инициатор создаёт заявку и прикладывает подтверждающие документы.
--   2. Согласующие заданы заранее, без права выбора: зам. директора по АХР
--      → специалист по закупкам → экономист.
--   3. Инициатор может исключить АХР и закупки («не требуется»), экономист
--      обязателен всегда.
--   4. Директор подписывает последним. Утверждённые заявки попадают в
--      папку экономиста («Утверждённые» на странице заявок).
--
-- Маршрут хранится в самой заявке (doc.route) и входит в подписываемый
-- текст: после подписи инициатора его не поменять. Порядок подписей
-- проверяет триггер — подписать «через голову» нельзя ни из браузера, ни
-- через сервер ЭЦП.
--
-- Вложения — Supabase Storage, корзина zayavki, путь <id заявки>/<файл>.
-- Видит тот, кто видит заявку; добавляет и удаляет автор, пока заявка не
-- подписана. Имя, размер и SHA-256 файлов лежат в doc.files и тоже
-- подписываются.
--
-- Применять в SQL Editor целиком. Повторный запуск безопасен.

/* ── Маршрут ─────────────────────────────────────────────────────── */

-- Согласующие по порядку. Экономист — всегда; АХР и закупки — если не
-- исключены. Нет поля route (старые заявки) — полный маршрут
create or replace function budget.request_route(doc jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
    select array(
        select s
          from unnest(array['ahr', 'zakup', 'economist']) with ordinality as u(s, i)
         where s = 'economist'
            or jsonb_typeof(doc->'route') is distinct from 'array'
            or (doc->'route') ? s
         order by i
    )
$$;

create or replace function budget.route_valid(doc jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
    if doc ? 'route' then
        if jsonb_typeof(doc->'route') <> 'array'
           or exists (select 1 from jsonb_array_elements_text(doc->'route') e
                       where e not in ('ahr', 'zakup', 'economist')) then
            raise exception 'Маршрут согласования: допустимы только АХР, закупки и экономист';
        end if;
    end if;
end
$$;

create or replace function budget.route_check(doc jsonb, slot text, sigs jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
    rt   text[] := budget.request_route(doc);
    prev text;
    lbl  jsonb  := '{"ahr": "зам. директора по АХР", "zakup": "специалист по закупкам", "economist": "экономист"}';
begin
    if slot <> 'director' and not (slot = any (rt)) then
        raise exception 'Графа «%» исключена из маршрута этой заявки', lbl->>slot;
    end if;
    foreach prev in array rt loop
        exit when prev = slot;
        if not exists (select 1 from jsonb_array_elements(sigs) e where e->>'slot' = prev) then
            raise exception 'Сначала подписывает %', lbl->>prev;
        end if;
    end loop;
end
$$;

/* ── Триггер заявок: маршрут и порядок ───────────────────────────── */

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
        perform budget.route_valid(new.doc);
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
        perform budget.route_valid(new.doc);
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
                -- Маршрут и порядок (0006): АХР → закупки → экономист → директор
                perform budget.route_check(new.doc, slot, sigs);
            else
                raise exception 'Неизвестная графа подписи: %', slot;
            end if;

            if coalesce(s->>'kind', '') not in ('ecp', 'simple') then
                raise exception 'Вид подписи: ecp или simple';
            end if;
            if s->>'kind' = 'ecp' then
                -- Только из budget.add_ecp_signature, то есть после проверки
                -- подписи сервером (NCANode). Из браузера флаг не выставить
                if current_setting('budget.ecp_verified', true) is distinct from 'on' then
                    raise exception 'Подпись ЭЦП принимается только после проверки на сервере';
                end if;
                if coalesce(s->>'cms', '') = '' or coalesce(s #>> '{cert,iin}', '') = '' then
                    raise exception 'Подпись ЭЦП без сертификата';
                end if;
                -- Если к учётке привязан ИИН — подписывать можно только своим ключом
                if budget.claim('iin') <> '' and s #>> '{cert,iin}' <> budget.claim('iin') then
                    raise exception 'ИИН в сертификате ЭЦП не совпадает с учётной записью';
                end if;
            else
                -- Отметка без ЭЦП не может выдавать себя за подпись
                s := s - 'cms' - 'cert' - 'verified';
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



/* ── Вложения: корзина и права ───────────────────────────────────── */

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'zayavki', 'zayavki', false, 15728640,
    array[
        'application/pdf', 'image/jpeg', 'image/png',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
)
on conflict (id) do update
   set public = false,
       file_size_limit = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Заявка, к которой относится файл: первая папка пути
create or replace function budget.file_request(name text)
returns text
language sql
immutable
set search_path = ''
as $$
    select split_part(name, '/', 1)
$$;

drop policy if exists zayavki_files_read   on storage.objects;
drop policy if exists zayavki_files_insert on storage.objects;
drop policy if exists zayavki_files_delete on storage.objects;

-- Видит тот, кто видит заявку (RLS budget.requests внутри exists)
create policy zayavki_files_read on storage.objects
    for select to authenticated
    using (
        bucket_id = 'zayavki'
        and exists (select 1 from budget.requests r
                     where r.id::text = budget.file_request(name))
    );

-- Добавляет и удаляет автор, пока заявку никто не подписал
create policy zayavki_files_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'zayavki'
        and exists (select 1 from budget.requests r
                     where r.id::text = budget.file_request(name)
                       and r.author = auth.uid()
                       and r.status in ('draft', 'returned')
                       and jsonb_array_length(r.signatures) = 0)
    );

create policy zayavki_files_delete on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'zayavki'
        and exists (select 1 from budget.requests r
                     where r.id::text = budget.file_request(name)
                       and r.author = auth.uid()
                       and r.status in ('draft', 'returned')
                       and jsonb_array_length(r.signatures) = 0)
    );

/* ── Права ───────────────────────────────────────────────────────── */

revoke execute on function budget.request_route(jsonb) from public, anon;
revoke execute on function budget.route_valid(jsonb) from public, anon;
revoke execute on function budget.route_check(jsonb, text, jsonb) from public, anon;
revoke execute on function budget.file_request(text) from public, anon;
grant execute on function budget.request_route(jsonb) to authenticated;
grant execute on function budget.route_valid(jsonb) to authenticated;
grant execute on function budget.route_check(jsonb, text, jsonb) to authenticated;
grant execute on function budget.file_request(text) to authenticated;
revoke execute on function budget.requests_guard() from public, anon, authenticated;

notify pgrst, 'reload schema';
