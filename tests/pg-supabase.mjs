/**
 * Минимальная «Supabase» на PGlite для тестов миграций: роли
 * anon/authenticated, auth.uid() из request.jwt.claims (как его читает
 * PostgREST) и схема storage — корзины и объекты с включённым RLS, как в
 * настоящем Supabase. Затем — все supabase/migrations по порядку.
 *
 *     const db = await supabaseDb();          // PGlite с применёнными миграциями
 *     const res = await asUser(db, user, sql, params);
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG = path.join(ROOT, "supabase", "migrations");

export const SUPABASE_BASE = `
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
        select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
    $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;

    create schema storage;
    create table storage.buckets (
        id text primary key,
        name text not null,
        public boolean default false,
        file_size_limit bigint,
        allowed_mime_types text[]
    );
    create table storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text references storage.buckets (id),
        name text not null,
        owner uuid default auth.uid(),
        metadata jsonb,
        created_at timestamptz default now(),
        unique (bucket_id, name)
    );
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, anon;
    grant select, insert, update, delete on storage.objects to authenticated;
    grant select on storage.objects to anon;

    -- Как в боевом проекте: соседний сервис (abai.live) открыл хранилище
    -- широкими permissive-политиками. Политики складываются через ИЛИ, так
    -- что любые наши ограничения обязаны быть restrictive (миграция 0007)
    create policy "Enable read access for all users" on storage.objects
        for select to public using (true);
    create policy "Enable insert for authenticated users only" on storage.objects
        for insert to authenticated with check (true);
`;

export function migrationFiles() {
    return fs.readdirSync(MIG).filter((n) => n.endsWith(".sql")).sort();
}

/* onMigration(name, error|null) — чтобы тест мог отчитаться по каждой */
export async function supabaseDb(onMigration) {
    const db = new PGlite();
    await db.exec(SUPABASE_BASE);
    for (const f of migrationFiles()) {
        try {
            await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
            if (onMigration) onMigration(f, null);
        } catch (e) {
            if (onMigration) onMigration(f, e);
            else throw e;
        }
    }
    return db;
}

export async function asUser(db, user, sql, params = []) {
    try {
        return await db.transaction(async (tx) => {
            await tx.exec("set local role authenticated");
            await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user)]);
            return { rows: (await tx.query(sql, params)).rows };
        });
    } catch (e) {
        return { error: e.message, rows: [] };
    }
}
