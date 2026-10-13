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
function loadModule(seed) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on("jsdomError", (e) => errors.push(e.message));

    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        runScripts: "dangerously",
        url: "http://localhost/rb-svodnaya.html",
        virtualConsole: vc,
    });
    const win = dom.window;
    // Кэш, оставшийся в браузере до загрузки модуля
    if (seed) seed(win);
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

console.log("\n── Кэш чужого пользователя стирается при входе другого");
{
    // Сессию Supabase кладёт под storageKey из auth.js
    const session = (id) => JSON.stringify({ access_token: "t", user: { id } });
    const fill = (win, owner, user) => {
        win.localStorage.setItem("rb_svodnaya_almaty", '{"a":1}');
        win.localStorage.setItem("pu_ss_almaty_nao", '{"b":2}');
        win.localStorage.setItem("budget_year", "2026");
        win.localStorage.setItem("theme", "dark");
        if (owner) win.localStorage.setItem("finka_cache_owner", owner);
        if (user) win.localStorage.setItem("finka-auth", session(user));
        win.sessionStorage.setItem("finka_synced_rb-svodnaya.html", "1");
    };

    // Алматы вышел, на том же компьютере вошёл Уральск
    {
        const { win } = loadModule((w) => fill(w, "user-almaty", "user-uralsk"));
        const ls = win.localStorage;
        eq("алматинские таблицы стёрты", ls.getItem("rb_svodnaya_almaty"), null);
        eq("ключи ПУ стёрты", ls.getItem("pu_ss_almaty_nao"), null);
        eq("год бюджета — общая настройка, остался", ls.getItem("budget_year"), "2026");
        eq("не наши ключи не тронуты", ls.getItem("theme"), "dark");
        eq("сессия не тронута", ls.getItem("finka-auth"), session("user-uralsk"));
        eq("кэш теперь за Уральском", ls.getItem("finka_cache_owner"), "user-uralsk");
        eq(
            "отметка «уже перезагружали» снята",
            win.sessionStorage.getItem("finka_synced_rb-svodnaya.html"),
            null,
        );
    }

    // Тот же пользователь перезашёл — кэш его, ничего не трогаем
    {
        const { win } = loadModule((w) => fill(w, "user-uralsk", "user-uralsk"));
        eq("свой кэш на месте", win.localStorage.getItem("rb_svodnaya_almaty"), '{"a":1}');
        eq(
            "отметка перезагрузки на месте",
            win.sessionStorage.getItem("finka_synced_rb-svodnaya.html"),
            "1",
        );
    }

    // Кэш от версии без владельца — неизвестно чей, стираем
    {
        const { win } = loadModule((w) => fill(w, "", "user-astana"));
        eq("кэш без владельца стёрт", win.localStorage.getItem("rb_svodnaya_almaty"), null);
        eq("владелец записан", win.localStorage.getItem("finka_cache_owner"), "user-astana");
    }

    // Не вошли — auth.js уведёт на вход, кэш не трогаем
    {
        const { win } = loadModule((w) => fill(w, "user-almaty", ""));
        eq("без сессии кэш на месте", win.localStorage.getItem("rb_svodnaya_almaty"), '{"a":1}');
    }

    // Повторный вызов для того же пользователя ничего не стирает
    {
        const { win, sync } = loadModule((w) => fill(w, "user-almaty", "user-uralsk"));
        win.localStorage.setItem("rb_svod_uralsk", "1");
        ok("повтор для того же пользователя — без стирания", sync._dropForeignCache() === false);
        eq("новые данные пользователя остаются", win.localStorage.getItem("rb_svod_uralsk"), "1");
    }

    // Очередь и версии прошлого пользователя — тоже его: иначе его
    // неотправленные удаления ушли бы в базу от имени нового
    {
        const { win } = loadModule((w) => {
            fill(w, "user-almaty", "user-uralsk");
            w.localStorage.setItem("finka_sync_queue", '{"rb_svodnaya_almaty":1}');
            w.localStorage.setItem("finka_sync_known", '{"rb_svodnaya_almaty":{"at":"t1"}}');
            w.localStorage.setItem("finka_conflict_rb_svod_almaty", "{}");
        });
        eq("очередь прошлого пользователя стёрта", win.localStorage.getItem("finka_sync_queue"), null);
        eq("версии прошлого пользователя стёрты", win.localStorage.getItem("finka_sync_known"), null);
        eq("запасные копии стёрты", win.localStorage.getItem("finka_conflict_rb_svod_almaty"), null);
    }
}

/* ══ Обмен с базой на заглушке Supabase ═════════════════════════════
   Заглушка повторяет то, на что опирается db-sync.js:
     • updated_at ставит «триггер» при каждой вставке и правке;
     • jsonb возвращает ключи объекта в своём порядке (по длине, потом по
       алфавиту), а не в порядке записи;
     • update/delete, не прошедшие RLS, ошибки не дают — просто 0 строк;
       insert, не прошедший RLS, — ошибка 42501;
     • повтор первичного ключа при insert — ошибка 23505. */
function jsonbOrder(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(jsonbOrder);
    const out = {};
    Object.keys(v)
        .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
        .forEach((k) => (out[k] = jsonbOrder(v[k])));
    return out;
}

function makeServer() {
    const rows = new Map();
    let clock = 0;
    const srv = {
        rows,
        log: [],
        failNext: 0, // столько запросов подряд упадут «сетью»
        deny: new Set(), // филиалы, куда RLS не пускает писать
        onSelect: null, // вызывается перед чтением всей таблицы
        stamp() {
            clock++;
            return `2026-10-13T10:00:00.${String(clock).padStart(6, "0")}+00:00`;
        },
        // Запись «другим пользователем» мимо модуля
        put(branch, key, value) {
            rows.set(branch + "|" + key, {
                branch, key, value: jsonbOrder(JSON.parse(JSON.stringify(value))),
                updated_at: srv.stamp(),
            });
        },
        get(branch, key) {
            const r = rows.get(branch + "|" + key);
            return r ? r.value : undefined;
        },
        remove(branch, key) {
            rows.delete(branch + "|" + key);
        },
    };

    const clone = (r) => JSON.parse(JSON.stringify(r));
    const match = (q, r) => q.filters.every(([c, v]) => r[c] === v);

    function exec(q) {
        srv.log.push(q.op + (q.op === "select" && !q.filters.length ? ":all" : ""));
        if (srv.failNext > 0) {
            srv.failNext--;
            return { data: null, error: { message: "TypeError: Failed to fetch", code: "" } };
        }
        if (q.op === "select") {
            if (!q.filters.length && q.range && q.range[0] === 0 && srv.onSelect) srv.onSelect();
            let list = [...rows.values()].filter((r) => match(q, r));
            list.sort((a, b) => (a.branch + "|" + a.key < b.branch + "|" + b.key ? -1 : 1));
            if (q.range) list = list.slice(q.range[0], q.range[1] + 1);
            return { data: list.map(clone), error: null };
        }
        if (q.op === "insert") {
            const v = q.values;
            if (srv.deny.has(v.branch)) {
                return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
            }
            if (rows.has(v.branch + "|" + v.key)) {
                return { data: null, error: { code: "23505", message: "duplicate key value" } };
            }
            srv.put(v.branch, v.key, v.value);
            return { data: q.wantSelect ? [clone(rows.get(v.branch + "|" + v.key))] : null, error: null };
        }
        const hit = [...rows.values()].filter((r) => match(q, r) && !srv.deny.has(r.branch));
        if (q.op === "update") {
            hit.forEach((r) => {
                r.value = jsonbOrder(JSON.parse(JSON.stringify(q.values.value)));
                r.updated_at = srv.stamp();
            });
        } else if (q.op === "delete") {
            hit.forEach((r) => rows.delete(r.branch + "|" + r.key));
        }
        return { data: q.wantSelect ? hit.map(clone) : null, error: null };
    }

    function builder() {
        const q = { op: "select", filters: [], values: null, range: null, wantSelect: false };
        const api = {
            select() {
                if (q.op !== "select") q.wantSelect = true;
                return api;
            },
            insert(v) { q.op = "insert"; q.values = v; return api; },
            update(v) { q.op = "update"; q.values = v; return api; },
            delete() { q.op = "delete"; return api; },
            eq(c, v) { q.filters.push([c, v]); return api; },
            order() { return api; },
            range(a, b) { q.range = [a, b]; return api; },
            then(res, rej) {
                return new Promise((r) => setTimeout(r, 1)).then(() => exec(q)).then(res, rej);
            },
        };
        return api;
    }

    srv.client = { schema: () => ({ from: () => builder() }) };
    return srv;
}

const EDITOR = { role: { canEdit: true }, roleKey: "edit", branchKey: "almaty" };
const VIEWER = { role: { canEdit: false }, roleKey: "view", branchKey: "nao" };
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
// Ждём условия, а не фиксированное время: на медленной машине первая
// загрузка jsdom занимает заметно дольше
async function waitFor(cond, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await wait(5);
    return cond();
}

// Страница отработала запуск: прочитала базу и отправила, что могла
async function settle(p) {
    await waitFor(() => {
        const st = p.sync.status();
        return st.ready && !st.sending && (!st.pending || st.code === "off" || st.code === "wait");
    });
    await wait(30);
}

/* Страница с модулем, вошедшим пользователем и заглушкой базы.
   storage — содержимое localStorage/sessionStorage «до загрузки»: так
   имитируется перезагрузка страницы. reads — ключи, которые страница
   читает при открытии; writes — что она при открытии пересохраняет. */
function boot(srv, opts = {}) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on("jsdomError", (e) => errors.push(e.message));
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        runScripts: "dangerously",
        url: "http://localhost/" + (opts.page || "rb-svod.html"),
        virtualConsole: vc,
    });
    const win = dom.window;
    const ls = win.localStorage;
    const st = opts.storage || {};
    Object.entries(st.local || {}).forEach(([k, v]) => ls.setItem(k, v));
    Object.entries(st.session || {}).forEach(([k, v]) => win.sessionStorage.setItem(k, v));
    if (!st.local) {
        ls.setItem("finka-auth", JSON.stringify({ user: { id: "u1" } }));
        ls.setItem("finka_cache_owner", "u1");
    }
    if (opts.seed) opts.seed(win);

    const toasts = [];
    win.finkaToast = (text, type) => toasts.push({ text, type });
    win.finkaAuth = {
        getClient: () => Promise.resolve(srv.client),
        getProfile: () => Promise.resolve(opts.profile || EDITOR),
    };
    const s = win.document.createElement("script");
    s.textContent = fs.readFileSync(path.join(ROOT, "db-sync.js"), "utf8");
    win.document.body.appendChild(s);

    const sync = win.finkaSync;
    const reloads = [];
    sync._hooks.reload = () => reloads.push(1);
    sync._timing.debounce = 5;
    sync._timing.retry = [15, 30];
    // Скрипты страницы: читают и пересохраняют свои ключи при открытии
    (opts.reads || []).forEach((k) => ls.getItem(k));
    (opts.writes || []).forEach(([k, v]) => ls.setItem(k, v));
    return { win, ls, sync, toasts, reloads, errors };
}

// Содержимое хранилищ — чтобы «перезагрузить» страницу в новом окне
function snapshot(win) {
    const dump = (s) => {
        const o = {};
        for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i));
        return o;
    };
    return { local: dump(win.localStorage), session: dump(win.sessionStorage) };
}

const queueOf = (ls) => JSON.parse(ls.getItem("finka_sync_queue") || "{}");

console.log("\n── Чтение из базы и перезагрузка по ключам страницы");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 5 } });
    srv.put("almaty", "rb_income", { cells: { E7: 1 } });

    const a = boot(srv, { reads: ["rb_svod_almaty"] });
    await settle(a);
    eq("лист из базы лёг в localStorage", a.ls.getItem("rb_svod_almaty"), '{"cells":{"C10":5}}');
    eq("страница прочитала изменённый ключ — перезагрузка", a.reloads.length, 1);
    eq("счётчик перезагрузок", a.win.sessionStorage.getItem("finka_synced_rb-svod.html"), "1");
    ok("версия строки запомнена", !!JSON.parse(a.ls.getItem("finka_sync_known"))["rb_svod_almaty"]);

    // После перезагрузки база ничего нового не дала — второй раз не грузим
    const b = boot(srv, { storage: snapshot(a.win), reads: ["rb_svod_almaty"] });
    await settle(b);
    eq("после перезагрузки без изменений — не перезагружаем", b.reloads.length, 0);
    eq("счётчик сброшен", b.win.sessionStorage.getItem("finka_synced_rb-svod.html"), null);

    // Изменился лист, который эта страница не читала, — перезагрузка не нужна
    srv.put("almaty", "rb_income", { cells: { E7: 2 } });
    const c = boot(srv, { storage: snapshot(b.win), reads: ["rb_svod_almaty"] });
    await settle(c);
    eq("чужой для страницы ключ обновлён", c.ls.getItem("rb_income_almaty"), '{"cells":{"E7":2}}');
    eq("и страница не перезагружалась", c.reloads.length, 0);

    // jsonb вернул ключи в другом порядке — по смыслу то же самое
    srv.put("almaty", "pu_x", { zeta: 1, a: { yy: 2, b: 3 } });
    const d0 = boot(srv, { storage: snapshot(c.win) });
    await settle(d0);
    const st = snapshot(d0.win);
    st.local.pu_x_almaty = '{"a":{"b":3,"yy":2},"zeta":1}';
    const d = boot(srv, { storage: st, reads: ["pu_x_almaty"] });
    await settle(d);
    eq("другой порядок ключей не считается изменением", d.reloads.length, 0);
}

console.log("\n── Страховка от цикла перезагрузок");
{
    // База меняется при каждом чтении — так бывает, если кто-то правит
    // лист одновременно или значение не переживает дорогу туда-обратно
    const srv = makeServer();
    let n = 0;
    srv.onSelect = () => srv.put("almaty", "rb_svod", { cells: { C10: ++n } });
    let storage;
    let total = 0;
    const toasts = [];
    for (let i = 0; i < 5; i++) {
        const p = boot(srv, { storage, reads: ["rb_svod_almaty"] });
        await settle(p);
        total += p.reloads.length;
        toasts.push(...p.toasts);
        storage = snapshot(p.win);
    }
    eq("перезагрузок подряд — не больше двух", total, 2);
    ok("дальше — просьба обновить вручную", toasts.some((t) => /обновите страницу/.test(t.text)));
}

console.log("\n── Запись: ключ уходит из очереди только после ответа базы");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 1 } });
    const p = boot(srv);
    await settle(p);
    p.ls.setItem("rb_svod_almaty", '{"cells":{"C10":2}}');
    ok("правка встала в очередь в localStorage", queueOf(p.ls)["rb_svod_almaty"] === 1);
    eq("состояние: есть неотправленное", p.sync.status().pending, 1);
    await waitFor(() => p.ls.getItem("finka_sync_queue") === null && !p.sync.status().sending);
    eq("в базе новое значение", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":2}}');
    eq("очередь пуста", p.ls.getItem("finka_sync_queue"), null);
    const known = JSON.parse(p.ls.getItem("finka_sync_known"));
    eq("версия взята из ответа базы", known.rb_svod_almaty.at, srv.rows.get("almaty|rb_svod").updated_at);
    ok("запись условная — через update", srv.log.includes("update"));

    // Новый лист — insert
    p.ls.setItem("pu_new_almaty", '{"a":1}');
    const st = await p.sync.flush();
    eq("flush: всё отправлено", st.pending, 0);
    eq("новый лист вставлен", JSON.stringify(srv.get("almaty", "pu_new")), '{"a":1}');

    // Удаление листа
    p.ls.removeItem("pu_new_almaty");
    await p.sync.flush();
    ok("удалён и в базе", !srv.rows.has("almaty|pu_new"));

    // Пересохранение того же значения — не правка
    const before = srv.log.length;
    p.ls.setItem("rb_svod_almaty", '{"cells":{"C10":2}}');
    await wait();
    eq("то же значение в базу не уходит", srv.log.length, before);
}

console.log("\n── Конфликт: чужая правка не затирается");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 1 } });
    const p = boot(srv, { reads: ["rb_svod_almaty"] });
    await settle(p);
    p.reloads.length = 0;
    // Пока страница открыта, лист поменял другой пользователь
    srv.put("almaty", "rb_svod", { cells: { C10: 99 } });
    p.ls.setItem("rb_svod_almaty", '{"cells":{"C10":2}}');
    const st = await p.sync.flush();
    eq("в базе осталась чужая правка", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":99}}');
    eq("в браузере — версия из базы", p.ls.getItem("rb_svod_almaty"), '{"cells":{"C10":99}}');
    eq("своя версия сохранена отдельно", p.ls.getItem("finka_conflict_rb_svod_almaty"), '{"cells":{"C10":2}}');
    ok("состояние: конфликт", st.code === "conflict" && st.conflicts[0] === "rb_svod_almaty");
    eq("ключ убран из очереди", st.pending, 0);
    // Предупреждение отложено до перезагрузки (страница читала этот лист)
    eq("страница перезагружена с версией из базы", p.reloads.length, 1);
    ok(
        "предупреждение ждёт перезагрузки",
        /изменён в базе другим/.test(p.win.sessionStorage.getItem("finka_sync_notice") || ""),
    );
    const q = boot(srv, { storage: snapshot(p.win) });
    await settle(q);
    ok("после перезагрузки показано предупреждение", q.toasts.some((t) => /изменён в базе другим/.test(t.text)));

    // Страница не читала лист — перезагрузки нет, предупреждение сразу
    const r = boot(srv, { storage: snapshot(q.win) });
    await settle(r);
    srv.put("almaty", "pu_y", { a: 1 });
    r.ls.setItem("pu_y_almaty", '{"a":2}'); // строки не видели — будет insert
    await r.sync.flush();
    eq("insert на занятый ключ (23505) — конфликт", JSON.stringify(srv.get("almaty", "pu_y")), '{"a":1}');
    ok("предупреждение тостом", r.toasts.some((t) => /pu_y_almaty/.test(t.text)));
    eq("без перезагрузки", r.reloads.length, 0);
}

console.log("\n── Две вкладки одного пользователя — не конфликт");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 1 } });
    const p = boot(srv);
    await settle(p);
    // Соседняя вкладка записала лист и обновила общую карту версий
    srv.put("almaty", "rb_svod", { cells: { C10: 2 } });
    const kn = JSON.parse(p.ls.getItem("finka_sync_known"));
    kn.rb_svod_almaty.at = srv.rows.get("almaty|rb_svod").updated_at;
    p.ls.setItem("finka_sync_known", JSON.stringify(kn));
    // Эта вкладка правит поверх
    p.ls.setItem("rb_svod_almaty", '{"cells":{"C10":3}}');
    const st = await p.sync.flush();
    eq("записано без конфликта", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":3}}');
    eq("конфликтов нет", st.conflicts.length, 0);
}

console.log("\n── Сбой сети: повтор с паузой и очередь через перезагрузку");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 1 } });
    const p = boot(srv);
    await settle(p);
    srv.failNext = 2;
    p.ls.setItem("rb_svod_almaty", '{"cells":{"C10":7}}');
    await waitFor(() => p.sync.status().code === "wait");
    ok("после сбоя ключ остался в очереди", queueOf(p.ls)["rb_svod_almaty"] === 1);
    ok("состояние: ждём повтора", p.sync.status().code === "wait");
    await waitFor(() => p.ls.getItem("finka_sync_queue") === null);
    eq("повтор дошёл до базы", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":7}}');
    eq("очередь пуста", p.ls.getItem("finka_sync_queue"), null);

    // Сети нет совсем: повторы кончаются, очередь остаётся
    srv.failNext = 1000;
    p.ls.setItem("rb_svod_almaty", '{"cells":{"C10":8}}');
    await waitFor(() => p.sync.status().code === "off");
    ok("повторы ограничены — состояние «не сохранено»", p.sync.status().code === "off");
    const tries = srv.log.filter((x) => x === "update").length;
    await wait(80);
    eq("после последней паузы запросов больше нет", srv.log.filter((x) => x === "update").length, tries);

    // Закрыли вкладку, открыли с сетью: очередь уходит, pull её не затёр
    srv.failNext = 0;
    const q = boot(srv, { storage: snapshot(p.win), reads: ["rb_svod_almaty"] });
    await settle(q);
    eq("неотправленное не перезаписано чтением", q.ls.getItem("rb_svod_almaty"), '{"cells":{"C10":8}}');
    eq("и доехало до базы", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":8}}');
    eq("без лишней перезагрузки", q.reloads.length, 0);
}

console.log("\n── Пересохранение устаревшего кэша при открытии");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 1 } });
    const p = boot(srv);
    await settle(p);
    // Пока вкладка была закрыта, лист поменяли; страница при открытии
    // пересохраняет то, что лежало в кэше
    srv.put("almaty", "rb_svod", { cells: { C10: 50 } });
    const q = boot(srv, {
        storage: snapshot(p.win),
        reads: ["rb_svod_almaty"],
        writes: [["rb_svod_almaty", '{"cells":{"C10":1},"lastModified":"x"}']],
    });
    await settle(q);
    eq("база не затёрта старым кэшем", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":50}}');
    eq("в браузере свежая версия", q.ls.getItem("rb_svod_almaty"), '{"cells":{"C10":50}}');
    eq("конфликтом не считается", q.toasts.length, 0);
    eq("страница перезагружена", q.reloads.length, 1);
}

console.log("\n── Удалённые в базе листы");
{
    const srv = makeServer();
    srv.put("almaty", "rb_svod", { a: 1 });
    srv.put("almaty", "rb_income", { a: 1 });
    srv.put("almaty", "pu_keep", { a: 1 });
    srv.put("nao", "budget_year", { __raw: "2026" });
    const p = boot(srv, { seed: (w) => w.localStorage.setItem("pu_local_almaty", '{"x":1}') });
    await settle(p);
    // Удалили в базе; один из листов у нас правится и ещё не отправлен
    srv.remove("almaty", "rb_svod");
    srv.remove("almaty", "rb_income");
    srv.remove("nao", "budget_year");
    srv.failNext = 1000;
    p.ls.setItem("rb_income_almaty", '{"a":2}');
    await waitFor(() => p.sync.status().code === "off");
    srv.failNext = 0;
    const q = boot(srv, { storage: snapshot(p.win) });
    await settle(q);
    eq("удалённый в базе лист удалён и локально", q.ls.getItem("rb_svod_almaty"), null);
    eq("неотправленный лист не тронут", q.ls.getItem("rb_income_almaty"), '{"a":2}');
    eq("…и восстановлен в базе", JSON.stringify(srv.get("almaty", "rb_income")), '{"a":2}');
    ok("лист, которого в базе не было никогда, не тронут", q.ls.getItem("pu_local_almaty") !== null);
    eq("общая настройка не удаляется", q.ls.getItem("budget_year"), "2026");
    eq("живой лист на месте", q.ls.getItem("pu_keep_almaty"), '{"a":1}');
}

console.log("\n── Роль без права правки");
{
    const srv = makeServer();
    srv.put("nao", "rb_svod", { a: 1 });
    const p = boot(srv, { profile: VIEWER, writes: [["rb_svod_nao", '{"a":5}']] });
    await settle(p);
    const st = p.sync.status();
    ok("состояние «Только чтение» не перетёрто", st.code === "ro" && st.text === "Только чтение");
    eq("правки не копятся в очереди", p.ls.getItem("finka_sync_queue"), null);
    eq("данные из базы видны", p.ls.getItem("rb_svod_nao"), '{"a":1}');
    ok("в базу ничего не писали", !srv.log.some((x) => /insert|update|delete/.test(x)));
}

console.log("\n── RLS не пустила запись");
{
    const srv = makeServer();
    srv.put("astana", "rb_svod", { a: 1 });
    const p = boot(srv);
    await settle(p);
    srv.deny.add("astana");
    p.ls.setItem("rb_svod_astana", '{"a":2}');
    const st = await p.sync.flush();
    ok("состояние «Нет права записи»", st.code === "off" && /права/.test(st.text));
    eq("ключ убран из очереди — повтор не поможет", st.pending, 0);
    eq("конфликтом не считается", st.conflicts.length, 0);
}

console.log("\n── Старые ключи вне синхронизации переносятся");
{
    const srv = makeServer();
    const p = boot(srv, {
        seed: (w) => {
            w.localStorage.setItem("ss_almaty_almaty", '{"cells":{"D10":3}}');
            w.localStorage.setItem("income_svod", '{"r1":{"cont":"1"}}');
            w.localStorage.setItem("ss_almaty_astana", '{"old":1}');
            w.localStorage.setItem("pu_ss_almaty_astana", '{"new":1}');
        },
    });
    eq("ss_almaty → pu_ss_almaty", p.ls.getItem("pu_ss_almaty_almaty"), '{"cells":{"D10":3}}');
    eq("income_svod → kb_income_svod_nao", p.ls.getItem("kb_income_svod_nao"), '{"r1":{"cont":"1"}}');
    eq("старый ключ удалён", p.ls.getItem("ss_almaty_almaty"), null);
    eq("новый ключ не перезаписан старым", p.ls.getItem("pu_ss_almaty_astana"), '{"new":1}');
    await settle(p);
    eq("перенесённое уехало в базу", JSON.stringify(srv.get("almaty", "pu_ss_almaty")), '{"cells":{"D10":3}}');
    eq("ставки — под синхронизацией", p.sync._split("rates_uralsk").branch, "uralsk");

    // Кэш сменил владельца — старые ключи неизвестно чьи, не переносим
    const q = boot(srv, {
        seed: (w) => {
            w.localStorage.setItem("finka_cache_owner", "someone-else");
            w.localStorage.setItem("ss_almaty_uralsk", '{"x":1}');
        },
    });
    eq("чужой старый ключ удалён", q.ls.getItem("ss_almaty_uralsk"), null);
    eq("и не перенесён", q.ls.getItem("pu_ss_almaty_uralsk"), null);
}

console.log("\n── Ctrl+S показывает настоящее состояние обмена");
{
    // Навигация (shared-nav.js) с настоящим finkaToast поверх модуля
    let saves = 2;
    async function pressCtrlS(srv, opts, before) {
        const p = boot(srv, opts);
        await settle(p);
        p.win.matchMedia = () => ({ matches: false });
        const nav = p.win.document.createElement("script");
        nav.textContent = fs.readFileSync(path.join(ROOT, "shared-nav.js"), "utf8");
        p.win.document.body.appendChild(nav);
        p.win.saveData = () =>
            p.ls.setItem("rb_svod_almaty", JSON.stringify({ cells: { C10: ++saves } }));
        if (before) before(p);
        p.win.document.dispatchEvent(
            new p.win.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
        );
        await waitFor(() => p.win.document.querySelector(".finka-toast"), 3000);
        const t = p.win.document.querySelector(".finka-toast");
        return { text: t ? t.textContent : "", cls: t ? t.className : "", p };
    }

    const srv = makeServer();
    srv.put("almaty", "rb_svod", { cells: { C10: 1 } });
    let r = await pressCtrlS(srv, {});
    ok("всё ушло — «Сохранено в базе»", /Сохранено в базе/.test(r.text) && /success/.test(r.cls), r.text);
    eq("и правда в базе", JSON.stringify(srv.get("almaty", "rb_svod")), '{"cells":{"C10":3}}');

    r = await pressCtrlS(srv, {}, () => (srv.failNext = 1000));
    ok("нет сети — «в базу не отправлено»", /не отправлено/.test(r.text) && /error/.test(r.cls), r.text);
    srv.failNext = 0;

    r = await pressCtrlS(srv, { profile: VIEWER });
    ok("роль без права правки — режим просмотра", /просмотра/.test(r.text), r.text);
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
