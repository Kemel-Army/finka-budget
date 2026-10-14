-- Подпись ЭЦП заявок — только после проверки на сервере.
--
-- В 0004 подпись ЭЦП принималась от браузера как есть: триггер проверял
-- права и порядок, но не саму подпись. Значит, учётка с правом подписи
-- могла записать любой текст под видом CMS. Теперь как в qoltanba/tamga:
--
--   браузер (NCALayer) → /api/ecp-sign (Vercel) → NCANode /cms/verify
--     (подпись именно этих данных, цепочка НУЦ, отзыв OCSP/CRL, ключ SIGN,
--     ИИН/ФИО владельца) → budget.add_ecp_signature(…, секрет сервера)
--
-- RPC выставляет транзакционный флаг budget.ecp_verified, и только с ним
-- триггер пропускает подпись вида ecp. Флаг из браузера не выставить:
-- PostgREST не даёт set_config, а RPC требует секрет, который знает только
-- сервер (в базе — его SHA-256, сам секрет — в переменной ECP_SECRET на
-- Vercel). Права на графу проверяет тот же триггер: RPC работает от имени
-- пользователя (security invoker), с его JWT и RLS.
--
-- Задать секрет: node scripts/ecp-secret.mjs — напечатает SQL с хешем и
-- значение для Vercel. Повторный запуск миграции безопасен.

/* ── Секрет сервера проверки ─────────────────────────────────────── */

create table if not exists budget.ecp_config (
    id          int         primary key default 1 check (id = 1),
    secret_hash bytea       not null,
    updated_at  timestamptz not null default now()
);

comment on table budget.ecp_config is
    'SHA-256 секрета сервера проверки ЭЦП (api/ecp-sign.js). Политик нет — '
    'читает только budget.ecp_secret_ok.';

alter table budget.ecp_config enable row level security;
revoke all on budget.ecp_config from public, anon, authenticated;

create or replace function budget.ecp_secret_ok(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select length(coalesce(p, '')) >= 32
       and exists (
           select 1 from budget.ecp_config
            where secret_hash = sha256(convert_to(p, 'UTF8'))
       )
$$;

/* ── Запись проверенной подписи ──────────────────────────────────── */

create or replace function budget.add_ecp_signature(p_id uuid, p_entry jsonb, p_secret text)
returns budget.requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
    r budget.requests;
begin
    if not budget.ecp_secret_ok(p_secret) then
        raise exception 'Подпись ЭЦП принимается только от сервера проверки'
            using errcode = '42501';
    end if;
    if coalesce(p_entry->>'kind', '') <> 'ecp' then
        raise exception 'Ожидалась подпись ЭЦП';
    end if;

    perform set_config('budget.ecp_verified', 'on', true);
    update budget.requests
       set signatures = signatures || jsonb_build_array(p_entry)
     where id = p_id
    returning * into r;
    perform set_config('budget.ecp_verified', 'off', true);

    if r.id is null then
        raise exception 'Заявка не найдена или нет доступа' using errcode = 'P0002';
    end if;
    return r;
end
$$;

/* ── Триггер заявок: ecp — только с флагом ───────────────────────── */

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


/* ── Права ───────────────────────────────────────────────────────── */

revoke execute on function budget.ecp_secret_ok(text) from public, anon;
revoke execute on function budget.add_ecp_signature(uuid, jsonb, text) from public, anon;
grant execute on function budget.ecp_secret_ok(text) to authenticated;
grant execute on function budget.add_ecp_signature(uuid, jsonb, text) to authenticated;
revoke execute on function budget.requests_guard() from public, anon, authenticated;

notify pgrst, 'reload schema';
