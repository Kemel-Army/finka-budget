/**
 * Миграции схемы budget на настоящем Postgres (PGlite, без сети и без
 * боевого Supabase): применяются все файлы supabase/migrations по порядку,
 * затем от имени разных учёток проверяются права и правила заявок и
 * примечаний (0004).
 *
 *     node tests/sql-local.mjs
 *
 * Supabase-окружение имитируется минимально: роли anon/authenticated,
 * auth.uid() из request.jwt.claims — так же, как его читает PostgREST.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG = path.join(ROOT, "supabase", "migrations");

let total = 0;
let failed = 0;
function ok(label, cond, extra) {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${label}${!cond && extra ? " — " + extra : ""}`);
}

const db = new PGlite();

await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
        select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
    $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
`);

for (const f of fs.readdirSync(MIG).filter((n) => n.endsWith(".sql")).sort()) {
    try {
        await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
        ok(`миграция ${f}`, true);
    } catch (e) {
        ok(`миграция ${f}`, false, e.message);
    }
}

/* ── Учётки ──────────────────────────────────────────────────────── */
let n = 0;
function user(email, meta) {
    n++;
    return {
        sub: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
        email,
        app_metadata: meta,
    };
}
const U = {
    ini: user("ini@x", { role: "initiator", branch: "astana", name: "Иванов И.И." }),
    ini2: user("ini2@x", { role: "initiator", branch: "astana" }),
    iniAla: user("inia@x", { role: "initiator", branch: "almaty" }),
    ahr: user("ahr@x", { role: "initiator", branch: "astana", signer: "ahr" }),
    zak: user("zak@x", { role: "initiator", branch: "astana", signer: "zakup" }),
    eco: user("eco@x", { role: "edit", branch: "astana" }),
    dir: user("dir@x", { role: "view", branch: "astana", signer: "director" }),
    naoEco: user("naoeco@x", { role: "edit", branch: "nao" }),
    alaEco: user("alaeco@x", { role: "edit", branch: "almaty" }),
    alaDir: user("aladir@x", { role: "view", branch: "almaty", signer: "director" }),
    stranger: user("abai@x", {}),
};

async function as(u, sql, params = []) {
    try {
        return await db.transaction(async (tx) => {
            await tx.exec("set local role authenticated");
            await tx.query("select set_config('request.jwt.claims', $1, true)", [
                JSON.stringify(u),
            ]);
            return { rows: (await tx.query(sql, params)).rows };
        });
    } catch (e) {
        return { error: e.message, rows: [] };
    }
}

const sig = (slot, kind = "ecp") =>
    JSON.stringify([{ slot, kind, cms: kind === "ecp" ? "MIIB" : undefined }]);
// Дописать подпись к тому, что уже лежит в строке
const SIGN = `update budget.requests
                 set signatures = signatures || $2::jsonb
               where id = $1 returning status, signatures`;
const doc = JSON.stringify({ fio: "Иванов", rows: [{ name: "Бумага", qty: 2, price: 1500 }] });

console.log("\n── Заявки ──");
let r = await as(U.ini, `insert into budget.requests (branch, doc, status, signatures)
                         values ('astana', $1, 'approved', $2) returning *`, [doc, sig("director")]);
ok("инициатор создаёт заявку", !r.error && r.rows.length === 1, r.error);
const id = r.rows[0] && r.rows[0].id;
ok("статус при создании — черновик, подписи сброшены",
    r.rows[0] && r.rows[0].status === "draft" && r.rows[0].signatures.length === 0);
ok("автор и имя — из токена", r.rows[0] && r.rows[0].author === U.ini.sub && r.rows[0].author_name === "Иванов И.И.");

r = await as(U.ini, `insert into budget.requests (branch, doc) values ('almaty', '{}')`);
ok("в чужой филиал подать нельзя", !!r.error);
r = await as(U.stranger, `insert into budget.requests (branch, doc) values ('astana', '{}')`);
ok("учётка без роли подать не может", !!r.error);

r = await as(U.eco, `select id from budget.requests`);
ok("черновик не видит экономист", r.rows.length === 0);
r = await as(U.ini2, `select id from budget.requests`);
ok("черновик не видит другой инициатор", r.rows.length === 0);

r = await as(U.ini, `update budget.requests set doc = $2 where id = $1 returning doc`, [
    id,
    JSON.stringify({ fio: "Иванов И.", rows: [] }),
]);
ok("автор правит черновик", !r.error && r.rows.length === 1, r.error);

r = await as(U.ahr, SIGN, [id, sig("ahr")]);
ok("черновик подписать согласующему нельзя (не видит)", r.rows.length === 0);

r = await as(U.ini, SIGN, [id, sig("initiator")]);
ok("инициатор подписывает — заявка подана", r.rows[0] && r.rows[0].status === "submitted", r.error);
ok("в подписи email и время сервера", r.rows[0] && r.rows[0].signatures[0].email === "ini@x" && !!r.rows[0].signatures[0].at);

r = await as(U.ini, `update budget.requests set doc = '{"x":1}' where id = $1`, [id]);
ok("подписанную заявку править нельзя", !!r.error);

r = await as(U.ini2, `select id from budget.requests`);
ok("поданную чужую заявку другой инициатор не видит", r.rows.length === 0);
r = await as(U.eco, `select id from budget.requests`);
ok("поданную видит экономист филиала", r.rows.length === 1);
r = await as(U.naoEco, `select id from budget.requests`);
ok("поданную видит экономист ЦА", r.rows.length === 1);
r = await as(U.alaEco, `select id from budget.requests`);
ok("экономист Алматы заявку Астаны не видит", r.rows.length === 0);

r = await as(U.zak, SIGN, [id, sig("ahr")]);
ok("закупщик не подписывает за АХР", !!r.error);
r = await as(U.ahr, SIGN, [id, sig("ahr")]);
ok("АХР подписывает", !r.error && r.rows[0].signatures.length === 2, r.error);
r = await as(U.ahr, SIGN, [id, sig("ahr")]);
ok("повторно ту же графу — нельзя", !!r.error);
r = await as(U.zak, SIGN, [id, sig("zakup", "simple")]);
ok("закупщик — простая отметка", !r.error, r.error);
r = await as(U.eco, SIGN, [id, JSON.stringify([{ slot: "economist", kind: "ecp", cms: "" }])]);
ok("пустая ЭЦП не принимается", !!r.error);
r = await as(U.eco, `update budget.requests set signatures = '[]' where id = $1`, [id]);
ok("стереть подписи нельзя", !!r.error);
r = await as(U.alaDir, SIGN, [id, sig("director")]);
ok("директор Алматы не утверждает заявку Астаны", !!r.error || r.rows.length === 0);
r = await as(U.ini, `update budget.requests set status = 'draft' where id = $1`, [id]);
ok("после согласующих автор отозвать не может", !!r.error);
r = await as(U.eco, SIGN, [id, sig("economist")]);
ok("экономист подписывает", !r.error, r.error);
r = await as(U.dir, SIGN, [id, sig("director")]);
ok("директор утверждает — статус approved", r.rows[0] && r.rows[0].status === "approved", r.error);

r = await as(U.ini, `delete from budget.requests where id = $1 returning id`, [id]);
ok("подписанную удалить нельзя", r.rows.length === 0);

// Возврат на доработку
r = await as(U.ini, `insert into budget.requests (branch, doc) values ('astana', $1) returning id`, [doc]);
const id2 = r.rows[0].id;
await as(U.ini, SIGN, [id2, sig("initiator")]);
r = await as(U.ini, `update budget.requests set status = 'returned' where id = $1`, [id2]);
ok("автор сам себе «вернуть» не может", !!r.error);
r = await as(U.eco, `update budget.requests set status = 'returned' where id = $1 returning status, signatures`, [id2]);
ok("экономист возвращает — подписи сняты",
    r.rows[0] && r.rows[0].status === "returned" && r.rows[0].signatures.length === 0, r.error);
r = await as(U.ini, `update budget.requests set doc = '{"fio":"исправлено"}' where id = $1 returning id`, [id2]);
ok("автор правит возвращённую", r.rows.length === 1, r.error);
r = await as(U.ini, SIGN, [id2, sig("initiator", "simple")]);
ok("и подаёт снова", r.rows[0] && r.rows[0].status === "submitted", r.error);
r = await as(U.ini, `update budget.requests set status = 'draft' where id = $1 returning status`, [id2]);
ok("автор отзывает, пока подписал только он", r.rows[0] && r.rows[0].status === "draft", r.error);
r = await as(U.ini, `update budget.requests set author_email = 'x' where id = $1`, [id2]);
ok("служебные поля не меняются", !!r.error);
r = await as(U.ini, `delete from budget.requests where id = $1 returning id`, [id2]);
ok("свой черновик удаляется", r.rows.length === 1, r.error);

console.log("\n── Примечания ──");
r = await as(U.eco, `insert into budget.notes (branch, page, body) values ('astana', 'pu-income-pu.html', 'Контингент уточнить') returning *`);
ok("экономист пишет примечание к листу", !r.error && r.rows[0].author_email === "eco@x", r.error);
const noteId = r.rows[0] && r.rows[0].id;
r = await as(U.naoEco, `insert into budget.notes (branch, page, body) values ('astana', 'pu-income-pu.html', 'ЦА: проверьте')`);
ok("ЦА комментирует лист филиала", !r.error, r.error);
r = await as(U.dir, `select body from budget.notes where page = 'pu-income-pu.html'`);
ok("директор читает примечания", r.rows.length === 2);
r = await as(U.alaEco, `select body from budget.notes`);
ok("Алматы не видит примечания Астаны", r.rows.length === 0);
r = await as(U.alaEco, `insert into budget.notes (branch, page, body) values ('astana', 'pu-income-pu.html', 'x')`);
ok("в чужой филиал писать нельзя", !!r.error);
r = await as(U.ini, `insert into budget.notes (branch, page, body) values ('astana', 'pu-income-pu.html', 'x')`);
ok("инициатор к листу бюджета не пишет", !!r.error);
r = await as(U.eco, `insert into budget.notes (branch, page, body) values ('astana', 'p', '   ')`);
ok("пустое примечание не принимается", !!r.error);
r = await as(U.naoEco, `delete from budget.notes where id = $1 returning id`, [noteId]);
ok("чужое примечание не удалить", r.rows.length === 0);
r = await as(U.eco, `update budget.notes set body = 'подмена' where id = $1 returning id`, [noteId]);
ok("примечание не редактируется", !!r.error || r.rows.length === 0);
r = await as(U.eco, `delete from budget.notes where id = $1 returning id`, [noteId]);
ok("своё примечание удаляется", r.rows.length === 1, r.error);

// Примечания к заявке — по видимости заявки
r = await as(U.ini, `insert into budget.requests (branch, doc) values ('astana', $1) returning id`, [doc]);
const id3 = r.rows[0].id;
r = await as(U.ini, `insert into budget.notes (branch, page, body) values ('astana', $1, 'Срочно')`, ["zayavka:" + id3]);
ok("автор комментирует свою заявку", !r.error, r.error);
r = await as(U.eco, `select id from budget.notes where page = $1`, ["zayavka:" + id3]);
ok("примечание к черновику экономист не видит", r.rows.length === 0);
await as(U.ini, SIGN, [id3, sig("initiator")]);
r = await as(U.eco, `insert into budget.notes (branch, page, body) values ('astana', $1, 'Уточните цену') returning id`, ["zayavka:" + id3]);
ok("экономист отвечает в поданной заявке", !r.error, r.error);
r = await as(U.ini2, `select id from budget.notes where page = $1`, ["zayavka:" + id3]);
ok("другой инициатор переписку не видит", r.rows.length === 0);
r = await as(U.ini, `select id from budget.notes where page = $1`, ["zayavka:" + id3]);
ok("автор видит ответ", r.rows.length === 2);

r = await as(U.stranger, `select count(*)::int c from budget.requests`);
ok("посторонняя учётка ничего не видит", r.rows[0] && r.rows[0].c === 0, r.error);

console.log(`\n${failed ? "ПРОВАЛЕНО" : "Все проверки пройдены"}: ${total - failed} из ${total}`);
process.exit(failed ? 1 : 0);
