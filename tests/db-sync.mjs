/**
 * Синхронизация с базой: раскладка ключей и упаковка значений.
 *
 * На этом держится совпадение localStorage с таблицей budget.kv. Ошибка
 * здесь тихо развалит данные: страница запишет rb_svodnaya_almaty, а
 * прочитает пустоту, потому что в базе ключ уехал не туда.
 *
 *     node tests/db-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsdomPkg from "jsdom";

const { JSDOM, VirtualConsole } = jsdomPkg;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(50)} ${extra}`);
}

function eq(label, got, want) {
    ok(label, got === want, got === want ? String(got) : `${got} ≠ ${want}`);
}

/* Модуль — самовызывающаяся функция, наружу отдаёт window.finkaSync.
   Без window.finkaAuth он должен молча ничего не делать: так страница
   работает и без входа в систему. */
function loadModule() {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on("jsdomError", (e) => errors.push(e.message));

    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        runScripts: "dangerously",
        url: "http://localhost/rb-svodnaya.html",
        virtualConsole: vc,
    });
    const win = dom.window;
    const s = win.document.createElement("script");
    s.textContent = fs.readFileSync(path.join(ROOT, "db-sync.js"), "utf8");
    win.document.body.appendChild(s);
    return { win, errors, sync: win.finkaSync };
}

console.log("\n── Раскладка ключа localStorage на филиал и ключ базы");
{
    const { sync, errors } = loadModule();
    ok("модуль загрузился без auth и не упал", errors.length === 0 && !!sync);

    const cases = [
        ["rb_svodnaya_almaty", "rb_svodnaya", "almaty"],
        ["rb_svodnaya_nao", "rb_svodnaya", "nao"],
        ["pu_income_pu_astana", "pu_income_pu", "astana"],
        ["plan_fact_pu_dt_uralsk", "plan_fact_pu_dt", "uralsk"],
        ["spravka_peredvizhka_rb_almaty", "spravka_peredvizhka_rb", "almaty"],
        ["shtat_almaty", "shtat", "almaty"],
        // импорт кладёт лист целиком: филиал в середине ключа, не в конце
        ["rb_svodnaya_almaty_full", "rb_svodnaya_full", "almaty"],
        ["pu_income_pu_astana_full", "pu_income_pu_full", "astana"],
        ["sheet_edits_rb-svod.html_astana", "sheet_edits_rb-svod.html", "astana"],
        // общие настройки филиала не имеют
        ["budget_year", "budget_year", "nao"],
        ["budget_year_end", "budget_year_end", "nao"],
    ];

    cases.forEach(([storageKey, wantKey, wantBranch]) => {
        const got = sync._split(storageKey);
        ok(
            `«${storageKey}»`,
            got.key === wantKey && got.branch === wantBranch,
            `${got.key} / ${got.branch}`,
        );
    });

    console.log("\n── Обратная сборка: ключ базы → ключ localStorage");
    cases.forEach(([storageKey, key, branch]) => {
        eq(`«${key}» + ${branch}`, sync._join(key, branch), storageKey);
    });

    // Ключ «budget_year_end» опасен: он оканчивается не на филиал, но
    // «..._nao» у обычных ключей отрезать надо — проверяем, что не путаются
    console.log("\n── Ключи, которые легко перепутать");
    eq("rb_svod_nao → ключ", sync._split("rb_svod_nao").key, "rb_svod");
    eq("rb_svod_nao → филиал", sync._split("rb_svod_nao").branch, "nao");
    eq("сборка rb_svod/nao", sync._join("rb_svod", "nao"), "rb_svod_nao");
    eq("сборка budget_year/nao", sync._join("budget_year", "nao"), "budget_year");
}

console.log("\n── Значение переживает дорогу в базу и обратно");
{
    const { sync } = loadModule();

    const samples = [
        '{"m0":{"111":{"fact":90,"plan":100}},"_lastUpdate":"30.07.2026"}',
        '{"rows":[{"code":"111","name":"Оплата труда","m":[1,2,3]}]}',
        '{"cells":{"A1":0,"B2":"текст"}}',
        "[]",
        "{}",
        "2026", // год бюджета — не объект, а простая строка
        "true",
        "не json вовсе",
        "",
    ];

    samples.forEach((raw) => {
        const back = sync._decode(sync._encode(raw));
        const same =
            back === raw ||
            (() => {
                try {
                    return (
                        JSON.stringify(JSON.parse(back)) ===
                        JSON.stringify(JSON.parse(raw))
                    );
                } catch (e) {
                    return false;
                }
            })();
        ok(`«${raw.slice(0, 44) || "(пусто)"}»`, same, same ? "" : `вернулось «${back}»`);
    });
}

console.log("\n── Перехват записи не мешает чужим ключам");
{
    const { win, sync } = loadModule();
    // без finkaAuth перехват не ставится — запись должна работать как обычно
    win.localStorage.setItem("rb_svod_almaty", '{"a":1}');
    win.localStorage.setItem("supabase.auth.token", "xxx");
    eq(
        "свой ключ записался",
        win.localStorage.getItem("rb_svod_almaty"),
        '{"a":1}',
    );
    eq(
        "чужой ключ записался",
        win.localStorage.getItem("supabase.auth.token"),
        "xxx",
    );
    ok("публичное API на месте", typeof sync.pull === "function" && typeof sync.push === "function");
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
