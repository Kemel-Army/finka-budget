/**
 * Сквозная проверка разграничения доступа на живой базе.
 *
 * Логика политик проверена на функциях, но политика и функция — разные
 * вещи: RLS может не сработать из-за забытого GRANT или незакрытой схемы.
 * Здесь настоящий вход настоящими учётками и настоящие запросы к API.
 *
 * Нужен dev-logins.js (в git его нет — только локально):
 *     node tests/rls-live.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const URL_BASE = "https://fdzwvwapcxoxllfqaoxw.supabase.co";
const ANON = "sb_publishable_ksFJ2xPiZXRTqk2l77NkMg_DSbD60u2";

const loginsPath = path.join(ROOT, "dev-logins.js");
if (!fs.existsSync(loginsPath)) {
    console.log("нет dev-logins.js — проверка пропущена");
    process.exit(0);
}

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(loginsPath, "utf8"), sandbox);

const ACCOUNTS = {};
for (const group of sandbox.window.FINKA_DEV_LOGINS || []) {
    for (const a of group.accounts) ACCOUNTS[a.email] = a.password;
}

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(46)} ${extra}`);
}

async function signIn(email) {
    const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: ANON, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: ACCOUNTS[email] }),
    });
    const body = await res.json();
    if (!body.access_token) throw new Error(`вход ${email}: ${JSON.stringify(body)}`);
    return body.access_token;
}

function api(token) {
    const headers = {
        apikey: ANON,
        Authorization: `Bearer ${token}`,
        "Accept-Profile": "budget",
        "Content-Profile": "budget",
        "Content-Type": "application/json",
    };
    return {
        async select(query = "") {
            const r = await fetch(`${URL_BASE}/rest/v1/kv?select=branch,key${query}`, {
                headers,
            });
            return { status: r.status, body: await r.json() };
        },
        async upsert(row) {
            const r = await fetch(`${URL_BASE}/rest/v1/kv?on_conflict=branch,key`, {
                method: "POST",
                headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
                body: JSON.stringify(row),
            });
            return { status: r.status, body: await r.json().catch(() => null) };
        },
    };
}

/* ── Подготовка: администратор кладёт по строке в каждый филиал ──── */
console.log("\n── Раскладываем пробные данные администратором");
const TEST_KEY = "__rls_probe";
const admin = api(await signIn("admin@rfmsh.kz"));

for (const branch of ["nao", "almaty", "astana", "uralsk"]) {
    const r = await admin.upsert({
        branch,
        key: TEST_KEY,
        value: { probe: branch },
    });
    ok(`админ пишет в «${branch}»`, r.status === 201, `HTTP ${r.status}`);
}

/* ── Кто что видит ──────────────────────────────────────────────── */
console.log("\n── Что видно каждой учётке");

const PERSONAS = [
    ["admin@rfmsh.kz", "админ / ЦА", ["nao", "almaty", "astana", "uralsk"]],
    ["edit.ala@rfmsh.kz", "работа / Алматы", ["almaty"]],
    ["view.ast@rfmsh.kz", "просмотр / Астана", ["astana"]],
    ["lim.ura@rfmsh.kz", "огранич. / Уральск", ["uralsk"]],
    ["edit@rfmsh.kz", "работа / ЦА", ["nao", "almaty", "astana", "uralsk"]],
];

for (const [email, label, expect] of PERSONAS) {
    const cli = api(await signIn(email));
    const r = await cli.select(`&key=eq.${TEST_KEY}`);
    const seen = (Array.isArray(r.body) ? r.body : [])
        .map((x) => x.branch)
        .sort();
    const want = [...expect].sort();
    ok(
        `${label} видит филиалы`,
        JSON.stringify(seen) === JSON.stringify(want),
        seen.join(", ") || "(ничего)",
    );
}

/* ── Кто куда может писать ──────────────────────────────────────── */
console.log("\n── Запись в чужой филиал");

const WRITES = [
    ["edit.ala@rfmsh.kz", "работа / Алматы → Алматы", "almaty", true],
    ["edit.ala@rfmsh.kz", "работа / Алматы → Астана", "astana", false],
    ["view.ast@rfmsh.kz", "просмотр / Астана → Астана", "astana", false],
    ["init.ala@rfmsh.kz", "инициатор / Алматы → Алматы", "almaty", false],
    ["lim.ura@rfmsh.kz", "огранич. / Уральск → Уральск", "uralsk", true],
];

for (const [email, label, branch, allowed] of WRITES) {
    const cli = api(await signIn(email));
    const r = await cli.upsert({ branch, key: TEST_KEY, value: { probe: "w" } });
    // 201 — строка создана, 200 — обновлена поверх созданной администратором
    const wrote = r.status === 201 || r.status === 200;
    ok(label, wrote === allowed, allowed ? `HTTP ${r.status}` : `отказ HTTP ${r.status}`);
}

/* ── Посторонний из abai.live ───────────────────────────────────── */
console.log("\n── Учётка без роли в бюджете");
{
    const r = await fetch(`${URL_BASE}/rest/v1/kv?select=branch,key`, {
        headers: { apikey: ANON, "Accept-Profile": "budget" },
    });
    const body = await r.json().catch(() => null);
    const empty = Array.isArray(body) ? body.length === 0 : true;
    ok("без входа ничего не видно", empty, `HTTP ${r.status}`);
}

/* ── Консолидация: города заполняют своё, свод складывает всё ───── */
console.log("\n── Алматы и Астана заполняют своё, консолидация складывает");
const PLAN_KEY = "__rls_plan_fact_pu";
{
    // Каждый город пишет своей учёткой в свой филиал
    const ala = api(await signIn("edit.ala@rfmsh.kz"));
    const ast = api(await signIn("edit.ast@rfmsh.kz"));

    const r1 = await ala.upsert({
        branch: "almaty",
        key: PLAN_KEY,
        value: { m0: { 111: { plan: 100, fact: 80 } } },
    });
    const r2 = await ast.upsert({
        branch: "astana",
        key: PLAN_KEY,
        value: { m0: { 111: { plan: 40, fact: 30 } } },
    });
    ok("Алматы записала свои цифры", r1.status === 201 || r1.status === 200, `HTTP ${r1.status}`);
    ok("Астана записала свои цифры", r2.status === 201 || r2.status === 200, `HTTP ${r2.status}`);

    // Город видит только себя — консолидация у него не соберётся, и это верно
    const alaSees = await ala.select(`&key=eq.${PLAN_KEY}`);
    ok(
        "Алматы видит только свою строку",
        alaSees.body.length === 1 && alaSees.body[0].branch === "almaty",
        alaSees.body.map((x) => x.branch).join(", "),
    );

    // Администратор видит оба города — из этого и считается свод
    const adminSees = await fetch(
        `${URL_BASE}/rest/v1/kv?select=branch,value&key=eq.${PLAN_KEY}`,
        {
            headers: {
                apikey: ANON,
                Authorization: `Bearer ${await signIn("admin@rfmsh.kz")}`,
                "Accept-Profile": "budget",
            },
        },
    ).then((r) => r.json());

    ok(
        "администратор видит оба города",
        adminSees.length === 2,
        adminSees.map((x) => x.branch).sort().join(", "),
    );

    const sumPlan = adminSees.reduce((a, r) => a + r.value.m0["111"].plan, 0);
    const sumFact = adminSees.reduce((a, r) => a + r.value.m0["111"].fact, 0);
    ok("свод по плану: 100 + 40", sumPlan === 140, String(sumPlan));
    ok("свод по факту: 80 + 30", sumFact === 110, String(sumFact));
}

/* ══ Попытки обойти ограничения ═══════════════════════════════════ */
console.log("\n══ Попытки обойти ограничения\n");

const ESC_KEY = "__rls_escalation";
{
    const adminTok = await signIn("admin@rfmsh.kz");
    const adminApi = api(adminTok);
    await adminApi.upsert({ branch: "astana", key: ESC_KEY, value: { secret: 1 } });
    await adminApi.upsert({ branch: "almaty", key: ESC_KEY, value: { own: 1 } });

    const ala = await signIn("edit.ala@rfmsh.kz");
    const H = {
        apikey: ANON,
        Authorization: `Bearer ${ala}`,
        "Accept-Profile": "budget",
        "Content-Profile": "budget",
        "Content-Type": "application/json",
    };

    // 1. Прямое чтение чужого филиала
    {
        const r = await fetch(
            `${URL_BASE}/rest/v1/kv?select=branch,value&branch=eq.astana&key=eq.${ESC_KEY}`,
            { headers: H },
        );
        const body = await r.json();
        ok(
            "Алматы не читает строку Астаны напрямую",
            Array.isArray(body) && body.length === 0,
            `вернулось строк: ${Array.isArray(body) ? body.length : "?"}`,
        );
    }

    // 2. Перенос собственной строки в чужой филиал
    {
        const r = await fetch(
            `${URL_BASE}/rest/v1/kv?branch=eq.almaty&key=eq.${ESC_KEY}`,
            { method: "PATCH", headers: H, body: JSON.stringify({ branch: "astana" }) },
        );
        ok("нельзя переписать филиал у своей строки", r.status === 403, `HTTP ${r.status}`);
    }

    // 3. Правка чужой строки вслепую (без чтения)
    {
        const r = await fetch(
            `${URL_BASE}/rest/v1/kv?branch=eq.astana&key=eq.${ESC_KEY}`,
            { method: "PATCH", headers: H, body: JSON.stringify({ value: { hacked: 1 } }) },
        );
        const touched = r.status === 200 || r.status === 204;
        // PostgREST молча меняет ноль строк — важно, что данные целы
        const check = await fetch(
            `${URL_BASE}/rest/v1/kv?select=value&branch=eq.astana&key=eq.${ESC_KEY}`,
            { headers: { apikey: ANON, Authorization: `Bearer ${adminTok}`, "Accept-Profile": "budget" } },
        ).then((x) => x.json());
        ok(
            "чужая строка не изменилась",
            check[0] && check[0].value && check[0].value.secret === 1,
            `ответ HTTP ${r.status}${touched ? " (0 строк)" : ""}, значение ${JSON.stringify(check[0] && check[0].value)}`,
        );
    }

    // 4. Удаление чужой строки
    {
        await fetch(`${URL_BASE}/rest/v1/kv?branch=eq.astana&key=eq.${ESC_KEY}`, {
            method: "DELETE",
            headers: H,
        });
        const left = await fetch(
            `${URL_BASE}/rest/v1/kv?select=branch&branch=eq.astana&key=eq.${ESC_KEY}`,
            { headers: { apikey: ANON, Authorization: `Bearer ${adminTok}`, "Accept-Profile": "budget" } },
        ).then((x) => x.json());
        ok("чужая строка не удалена", left.length === 1, `осталось строк: ${left.length}`);
    }

    // 5. Подделка журнала правок
    {
        const r = await fetch(`${URL_BASE}/rest/v1/kv_audit`, {
            method: "POST",
            headers: H,
            body: JSON.stringify({ branch: "almaty", key: "подделка", op: "INSERT" }),
        });
        ok("журнал правок нельзя дописать", r.status >= 400, `HTTP ${r.status}`);

        const d = await fetch(`${URL_BASE}/rest/v1/kv_audit?key=eq.${ESC_KEY}`, {
            method: "DELETE",
            headers: H,
        });
        ok("журнал правок нельзя чистить", d.status >= 400, `HTTP ${d.status}`);
    }

    // 6. Служебные функции снаружи
    {
        const r = await fetch(`${URL_BASE}/rest/v1/rpc/stamp`, {
            method: "POST",
            headers: H,
            body: "{}",
        });
        ok("служебная функция закрыта", r.status >= 400, `HTTP ${r.status}`);
    }

    // 7. «Инициатор» из центрального аппарата — только свой филиал
    {
        const init = api(await signIn("init@rfmsh.kz"));
        const r = await init.select(`&key=eq.${ESC_KEY}`);
        const seen = (Array.isArray(r.body) ? r.body : []).map((x) => x.branch).sort();
        ok(
            "инициатор ЦА не видит филиалы",
            seen.length === 0 || (seen.length === 1 && seen[0] === "nao"),
            seen.join(", ") || "(ничего)",
        );
    }

    // 8. Мусорный ключ
    {
        const r = await fetch(`${URL_BASE}/rest/v1/kv`, {
            method: "POST",
            headers: H,
            body: JSON.stringify({ branch: "almaty", key: "   ", value: {} }),
        });
        ok("пустой ключ не принимается", r.status >= 400, `HTTP ${r.status}`);
    }

    // 9. Без входа — ничего
    {
        const r = await fetch(`${URL_BASE}/rest/v1/kv?select=branch`, {
            headers: { apikey: ANON, "Accept-Profile": "budget" },
        });
        ok("без входа доступа нет", r.status >= 400, `HTTP ${r.status}`);
    }
}

/* ── Убираем за собой ───────────────────────────────────────────── */
console.log("\n── Уборка");
{
    const token = await signIn("admin@rfmsh.kz");
    const wipe = (k) =>
        fetch(`${URL_BASE}/rest/v1/kv?key=eq.${k}`, {
            method: "DELETE",
            headers: {
                apikey: ANON,
                Authorization: `Bearer ${token}`,
                "Content-Profile": "budget",
            },
        });
    const a = await wipe(TEST_KEY);
    const b = await wipe(PLAN_KEY);
    const c = await wipe(ESC_KEY);
    ok(
        "пробные строки удалены",
        a.status === 204 && b.status === 204 && c.status === 204,
        `HTTP ${a.status} / ${b.status} / ${c.status}`,
    );
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
