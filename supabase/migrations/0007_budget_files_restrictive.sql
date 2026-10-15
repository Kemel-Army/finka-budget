-- Вложения заявок: ограничения, которые нельзя обойти чужими политиками.
--
-- Проверка на боевом проекте (16.10.2026) показала: в общем проекте
-- Supabase соседний сервис (abai.live) держит на storage.objects две
-- permissive-политики —
--     «Enable read access for all users»          select to public  using (true)
--     «Enable insert for authenticated users only» insert to authenticated with check (true)
-- Permissive-политики складываются через ИЛИ, поэтому политики 0006 ничего
-- не ограничивали: файл чужой заявки читался (даже без входа), а положить
-- файл можно было в любую заявку. Удалять чужие политики нельзя — сломается
-- abai.live.
--
-- Решение — restrictive-политики: они складываются через И с любыми
-- permissive и касаются только корзины zayavki (для остальных корзин
-- условие bucket_id <> 'zayavki' истинно).
--
-- Проверка прав — в public.finka_zayavki_file_ok (security definer): её
-- может вызвать и anon, у которого нет доступа к схеме budget. Иначе любой
-- анонимный запрос к storage.objects падал бы с «permission denied for
-- schema budget» — и у abai.live тоже.
--
-- Применять в SQL Editor целиком. Повторный запуск безопасен.

create or replace function public.finka_zayavki_file_ok(p_name text, p_op text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
          from budget.requests r
         where r.id::text = split_part(p_name, '/', 1)
           and case p_op
                   -- Видит тот, кто видит заявку (то же, что requests_read)
                   when 'read' then
                        r.author = auth.uid()
                        or (r.status <> 'draft'
                            and budget.can_read_branch(r.branch)
                            and (budget.is_staff() or budget.claim('signer') <> ''))
                   -- Добавляет и удаляет автор, пока заявку никто не подписал
                   else r.author = auth.uid()
                        and r.status in ('draft', 'returned')
                        and jsonb_array_length(r.signatures) = 0
               end
    )
$$;

comment on function public.finka_zayavki_file_ok(text, text) is
    'Бюджет РФМШ: право на файл заявки-потребности в корзине zayavki '
    '(read | write). Используется restrictive-политиками storage.objects.';

revoke execute on function public.finka_zayavki_file_ok(text, text) from public;
grant execute on function public.finka_zayavki_file_ok(text, text) to anon, authenticated;

drop policy if exists zayavki_guard_read   on storage.objects;
drop policy if exists zayavki_guard_insert on storage.objects;
drop policy if exists zayavki_guard_update on storage.objects;
drop policy if exists zayavki_guard_delete on storage.objects;

create policy zayavki_guard_read on storage.objects
    as restrictive for select to public
    using (bucket_id <> 'zayavki' or public.finka_zayavki_file_ok(name, 'read'));

create policy zayavki_guard_insert on storage.objects
    as restrictive for insert to public
    with check (bucket_id <> 'zayavki' or public.finka_zayavki_file_ok(name, 'write'));

-- Перезаписывать файлы заявок нельзя никому: подписан SHA-256 исходного
create policy zayavki_guard_update on storage.objects
    as restrictive for update to public
    using (bucket_id <> 'zayavki')
    with check (bucket_id <> 'zayavki');

create policy zayavki_guard_delete on storage.objects
    as restrictive for delete to public
    using (bucket_id <> 'zayavki' or public.finka_zayavki_file_ok(name, 'write'));
