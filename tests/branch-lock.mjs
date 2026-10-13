/**
 * Привязка к филиалу раньше загрузки страницы.
 *
 * auth.js у учётки филиала сам жмёт кнопку её города (lockBranch), как
 * только проверит сессию, — это бывает уже на DOMContentLoaded, раньше
 * обработчика load, в котором часть страниц строила таблицу и загружала
 * данные. Тогда switchBranch:
 *   • писал в ещё не созданные ячейки — «Cannot set properties of null»;
 *   • сохранял пустую заготовку поверх данных ЦА (ключ *_nao).
 *
 * Здесь клик auth.js воспроизводится на DOMContentLoaded в jsdom, и
 * проверяется: ошибок нет, ключи ЦА не тронуты, активна кнопка филиала.
 *
 * И главное: без ввода пользователя страница ничего не пишет в
 * localStorage — ни при открытии, ни при клике auth.js. Каждая запись
 * уходит в базу: у филиала это отказ RLS, у ЦА — нули или чужие данные
 * поверх настоящих. Прогон для учёток Уральска и Алматы и для ЦА (без
 * клика).
 *
 *     node tests/branch-lock.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsdomPkg from "jsdom";

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(52)} ${extra}`);
}

// Страницы с переключателем филиалов
const PAGES = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => /function switchBranch/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    .sort();

const XLSX_STUB = `
window.XLSX = { utils: {}, read: () => ({ SheetNames: [], Sheets: {} }), writeFile: () => {} };
window.html2pdf = () => ({ from: () => ({ save: () => {} }) });
`;

/* То же, что делает auth.js для учётки филиала: прячет чужие кнопки и
   жмёт свою, если она не активна. Ставится в <head> — раньше скриптов
   страницы, как и auth.js. late — сессия проверилась позже load (медленная
   сеть): клик приходит в уже загруженную страницу. */
const LOCK = (own, late) => `<script>
(function () {
    function branchOf(btn) {
        var attr = btn.getAttribute("data-branch");
        if (attr) return attr;
        var m = /switchBranch\\(\\s*['"]([^'"]+)/.exec(btn.getAttribute("onclick") || "");
        return m ? m[1] : "";
    }
    function selectOwn() {
        var btns = document.querySelectorAll(".branch-btn");
        for (var i = 0; i < btns.length; i++) {
            if (branchOf(btns[i]) === "${own}" && !btns[i].classList.contains("active")) {
                btns[i].click();
            }
        }
    }
    if (${late ? "true" : "false"}) {
        window.addEventListener("load", function () {
            setTimeout(selectOwn, 300);
        });
    } else {
        document.addEventListener("DOMContentLoaded", function () {
            selectOwn();
            setTimeout(selectOwn, 800);
        });
    }
})();
</script>`;

const JS = { headers: { "Content-Type": "application/javascript" } };

const localFiles = requestInterceptor((request) => {
    const url = request.url;
    if (/^https?:\/\/(cdn|cdnjs|unpkg)/i.test(url)) return new Response(XLSX_STUB, JS);
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    // auth.js и db-sync.js ходят в сеть — их роль здесь играет LOCK
    if (name === "auth.js" || name === "db-sync.js") return new Response("", JS);
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) return new Response(fs.readFileSync(p, "utf8"), JS);
    return new Response("", JS);
});

/* Сохранённые листы всех филиалов: с данными страницы идут другой веткой
   загрузки (пересчёт строк, updateRow и т. п.) — она тоже не должна писать */
const SEED = {
    pu_income_dop: { rows: { 1: { m1: "100" }, 2: { m3: "50" } } },
    pu_income_dt: { rows: { 1: { cont: "5", m1: "100" } } },
    pu_ss_dotacia: { contingent: { school: "1", fc: "2" }, items: { 1: { total: "10", fc: "3" } } },
    pu_kalkulyacia_almaty: { i1: "100" },
    pu_plan_rk: { trips: [{ purpose: "п", city: "г", trips: "1", days: "0", people: "2", ticket: "10", hotel: "5" }] },
    pu_plan_abroad: { trips: [{ purpose: "п", country: "с", trips: "1", days: "0", people: "2", ticket: "10", hotel: "5", daily: "1", visa: "0" }] },
    pu_svod_2026: { "plan-1": "100", "fact-1": "50" },
    pu_ss_almaty: { cells: { D10: "100" }, lastModified: "2026-01-01T00:00:00Z" },
    rb_income: { cells: { F7: "100" }, lastModified: "2026-01-01T00:00:00Z" },
    rb_kalkulyacia: { cells: { C5: "100" }, lastModified: "2026-01-01T00:00:00Z" },
    rb_svod: { cells: { D10: "100" }, lastModified: "2026-01-01T00:00:00Z" },
};

function installStubs(window, seed) {
    if (seed) {
        for (const [sheet, data] of Object.entries(SEED)) {
            for (const b of ["nao", "almaty", "astana", "uralsk"]) {
                window.localStorage.setItem(sheet + "_" + b, JSON.stringify(data));
            }
        }
    }
    // Все записи страницы в localStorage — до первого её скрипта
    window.__writes = [];
    const proto = Object.getPrototypeOf(window.localStorage);
    for (const fn of ["setItem", "removeItem", "clear"]) {
        const orig = proto[fn];
        proto[fn] = function (...args) {
            window.__writes.push(fn === "setItem" ? args[0] : fn + ":" + (args[0] || ""));
            return orig.apply(this, args);
        };
    }
    window.matchMedia = () => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
    });
    window.fetch = async (url) => {
        const name = String(url).split("/").pop().split("?")[0];
        const p = path.join(ROOT, decodeURIComponent(name));
        if (!fs.existsSync(p)) {
            return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        }
        const text = fs.readFileSync(p, "utf8");
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    };
}

/* own — филиал учётки (auth.js жмёт его кнопку), null — ЦА, без клика.
   edit — после загрузки ввести число и сразу перейти на Алматы: правка
   НАО должна сохраниться (флаг правок не глушит настоящий ввод) */
async function run(page, own, late, seed, edit) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    vc.on("error", (...a) => errors.push(String(a[0])));

    let html = fs.readFileSync(path.join(ROOT, page), "utf8");
    if (own) html = html.replace(/<head>/i, "<head>" + LOCK(own, late));

    let dom;
    try {
        dom = new JSDOM(html, {
            runScripts: "dangerously",
            url: "http://localhost/" + page,
            pretendToBeVisual: true,
            virtualConsole: vc,
            resources: { interceptors: [localFiles] },
            beforeParse: (w) => installStubs(w, seed),
        });
    } catch (e) {
        return { label: page, pass: false, extra: "не загрузилась: " + e.message };
    }
    const win = dom.window;
    await new Promise((r) => win.addEventListener("load", r, { once: true }));
    // таймеры автосохранения страниц — до 1 с, повторный клик — 800 мс
    await new Promise((r) => win.setTimeout(r, 2000));

    if (edit) {
        const doc = win.document;
        const inp = [...doc.querySelectorAll("tbody input")].find(
            (i) => !i.disabled && (i.type === "number" || i.dataset.cell),
        );
        const to = [...doc.querySelectorAll(".branch-btn")].find(
            (b) => b.getAttribute("data-branch") === "almaty" || /'almaty'/.test(b.getAttribute("onclick") || ""),
        );
        if (!inp || !to) {
            win.close();
            return { label: page, pass: false, extra: "нет поля или кнопки Алматы" };
        }
        inp.value = "777";
        inp.dispatchEvent(new win.Event("input", { bubbles: true }));
        to.click();
        await new Promise((r) => win.setTimeout(r, 1500));
        const naoWrites = win.__writes.filter((k) => /_nao$/.test(k) && !/^sheet_edits_/.test(k));
        win.close();
        return {
            label: page,
            pass: naoWrites.length > 0,
            extra: naoWrites.length ? "сохранено: " + [...new Set(naoWrites)].join(", ") : "правка НАО потеряна",
        };
    }

    const hard = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    // Ввода не было — любая запись лишняя (ключи ЦА в том числе)
    const writes = [...new Set(win.__writes)];
    const active = [...win.document.querySelectorAll(".branch-btn.active")].map((b) => {
        const attr = b.getAttribute("data-branch");
        if (attr) return attr;
        const m = /switchBranch\(\s*['"]([^'"]+)/.exec(b.getAttribute("onclick") || "");
        return m ? m[1] : "";
    }).filter(Boolean);
    win.close();

    // У ЦА клика нет — кнопка остаётся та, что активна по умолчанию
    const branchOk = own ? active.join() === own : true;
    return {
        label: page,
        pass: hard.length === 0 && writes.length === 0 && branchOk,
        extra:
            (hard.length ? "ошибки: " + hard.slice(0, 2).join(" | ").slice(0, 140) + " " : "") +
            (writes.length ? "записано без ввода: " + writes.join(", ") + " " : "") +
            "активна: " + (active.join(",") || "—"),
    };
}

for (const [own, late, seed, title] of [
    ["uralsk", false, false, "Клик auth.js по Уральску до загрузки страницы"],
    ["uralsk", true, false, "Клик auth.js по Уральску после загрузки страницы"],
    ["uralsk", true, true, "То же, у филиалов есть сохранённые листы"],
    ["almaty", false, true, "Клик auth.js по Алматы до загрузки, листы есть"],
    [null, false, false, "ЦА: открытие пустой страницы без ввода"],
    [null, false, true, "ЦА: открытие страницы с данными без ввода"],
]) {
    console.log("\n── " + title);
    // Страницы независимы — гоним по нескольку сразу, вывод в прежнем порядке
    const results = [];
    for (let i = 0; i < PAGES.length; i += 7) {
        results.push(...(await Promise.all(PAGES.slice(i, i + 7).map((p) => run(p, own, late, seed)))));
    }
    for (const r of results) ok(r.label, r.pass, r.extra);
}

/* Страницы, где флаг правок появился вместе с этим тестом: ввод перед
   сменой филиала по-прежнему сохраняется */
const EDITED = [
    "pu-income-dop.html", "pu-income-dt.html", "pu-ss-almaty.html", "pu-ss-dotacia.html",
    "pu-kalkulyacia-almaty.html", "pu-plan-rk.html", "pu-plan-abroad.html", "pu-svod-2026.html",
    "rb-income.html", "rb-kalkulyacia.html", "rb-svod.html",
];
console.log("\n── Правка перед переключением филиала сохраняется");
{
    const results = await Promise.all(EDITED.map((p) => run(p, null, false, true, true)));
    for (const r of results) ok(r.label, r.pass, r.extra);
}

/* Открыть страницу (как ЦА, без клика auth.js) с заданными листами */
async function open(page, store) {
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, page), "utf8"), {
        runScripts: "dangerously",
        url: "http://localhost/" + page,
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
        resources: { interceptors: [localFiles] },
        beforeParse: (w) => {
            for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, JSON.stringify(v));
            installStubs(w, false);
        },
    });
    const win = dom.window;
    await new Promise((r) => win.addEventListener("load", r, { once: true }));
    await new Promise((r) => win.setTimeout(r, 300));
    return win;
}

const val = (doc, id) => (doc.getElementById(id) || {}).value;
const money = (doc, id) => {
    const el = doc.getElementById(id);
    return el ? parseFloat(el.textContent.replace(/[\s ]/g, "").replace(",", ".")) : NaN;
};
const branchBtn = (doc, b) =>
    [...doc.querySelectorAll(".branch-btn")].find(
        (x) => x.getAttribute("data-branch") === b || new RegExp("'" + b + "'").test(x.getAttribute("onclick") || ""),
    );

/* Командировки: 0 дней / 0 человек / 0 поездок — настоящий ввод, а не
   «пусто». С «r.days || 3» ноль при загрузке подменялся значением по
   умолчанию, и следующее сохранение записывало его в базу. */
console.log("\n── Командировки: ноль не подменяется значением по умолчанию");
for (const [page, sheet] of [["pu-plan-rk.html", "pu_plan_rk"], ["pu-plan-abroad.html", "pu_plan_abroad"]]) {
    // Числом, как кладут импорт и база (строка "0" и раньше была истинной)
    const trip = { purpose: "п", city: "г", country: "с", trips: 0, days: 0, people: 0, ticket: 0, hotel: 0, daily: 0, visa: 0 };
    const win = await open(page, { [sheet + "_nao"]: { trips: [trip] } });
    const doc = win.document;
    const got = ["trips", "days", "people"].map((f) => val(doc, f + "-1"));
    ok(`${page}: поездки/дни/люди = 0`, got.join() === "0,0,0", "получили " + got.join(","));
    ok(`${page}: без записи при открытии`, win.__writes.length === 0, win.__writes.join(", "));
    branchBtn(doc, "consolidated").click();
    const cons = ["trips", "days", "people"].map((f) => val(doc, f + "-1"));
    ok(`${page}: консолидация — тоже 0`, cons.join() === "0,0,0", "получили " + cons.join(","));
    win.close();
}

/* Доходы ДТ и доп. услуги: итог строки r{N}-total после загрузки. Раньше
   loadData пересчитывала только итоги таблицы, и у сохранённого листа в
   строках стояло 0,00 до первого ввода. */
console.log("\n── Доходы ДТ / доп. услуги: итоги строк после загрузки");
for (const [page, sheet] of [["pu-income-dt.html", "pu_income_dt"], ["pu-income-dop.html", "pu_income_dop"]]) {
    const rows = { 1: { cont: "3", m1: "100", m2: "50" }, 2: { m12: "10" } };
    const win = await open(page, { [sheet + "_nao"]: { rows }, [sheet + "_almaty"]: { rows } });
    const doc = win.document;
    ok(`${page}: строка 1 = 150`, money(doc, "r1-total") === 150, "получили " + money(doc, "r1-total"));
    ok(`${page}: строка 2 = 10`, money(doc, "r2-total") === 10, "получили " + money(doc, "r2-total"));
    ok(`${page}: без записи при открытии`, win.__writes.length === 0, win.__writes.join(", "));
    branchBtn(doc, "consolidated").click();
    ok(`${page}: консолидация, строка 1 = 300`, money(doc, "r1-total") === 300, "получили " + money(doc, "r1-total"));
    win.close();
}

/* Под активной по умолчанию кнопкой НАО — лист НАО. tableData.branch был
   «almaty»: страница показывала Алматы под кнопкой НАО, а правки ЦА
   уходили в лист Алматы. */
console.log("\n── Кнопка НАО по умолчанию показывает и сохраняет лист НАО");
for (const [page, sheet, cell] of [
    ["pu-ss-almaty.html", "pu_ss_almaty", "D10"],
    ["rb-income.html", "rb_income", "F7"],
    ["rb-kalkulyacia.html", "rb_kalkulyacia", "C5"],
    ["rb-svod.html", "rb_svod", "D10"],
]) {
    const win = await open(page, {
        [sheet + "_nao"]: { cells: { [cell]: "111" } },
        [sheet + "_almaty"]: { cells: { [cell]: "222" } },
    });
    const doc = win.document;
    const inp = doc.querySelector(`input[data-cell="${cell}"]`);
    const activeNao = branchBtn(doc, "nao").classList.contains("active");
    ok(`${page}: активна НАО, в ${cell} лист НАО`, activeNao && inp && inp.value === "111", "в поле " + (inp ? inp.value : "—"));
    inp.value = "333";
    inp.dispatchEvent(new win.Event("input", { bubbles: true }));
    await new Promise((r) => win.setTimeout(r, 1300));
    const nao = JSON.parse(win.localStorage.getItem(sheet + "_nao") || "{}");
    const alm = JSON.parse(win.localStorage.getItem(sheet + "_almaty") || "{}");
    ok(
        `${page}: правка ушла в лист НАО`,
        (nao.cells || {})[cell] === "333" && (alm.cells || {})[cell] === "222",
        `НАО ${(nao.cells || {})[cell]}, Алматы ${(alm.cells || {})[cell]}`,
    );
    win.close();
}

/* Главная: год бюджета при открытии только читается. Запись budget_year
   уходит в базу — у ЦА выбор админа (2027) откатывался на текущий год,
   у филиала был отказ RLS. Пишет только смена года пользователем. */
console.log("\n── Главная: год бюджета пишется только при смене");
{
    let win = await open("index.html", { budget_year: 2027, budget_year_end: 2029 });
    let doc = win.document;
    ok("index.html: выбран сохранённый 2027–2029",
        val(doc, "yearInput") === "2027" && val(doc, "yearEndInput") === "2029",
        `${val(doc, "yearInput")}–${val(doc, "yearEndInput")}`);
    ok("index.html: открытие без записи", win.__writes.length === 0, win.__writes.join(", "));
    doc.getElementById("yearInput").value = "2028";
    doc.getElementById("yearInput").dispatchEvent(new win.Event("change", { bubbles: true }));
    ok("index.html: смена года сохраняется",
        win.localStorage.getItem("budget_year") === "2028" && win.localStorage.getItem("budget_year_end") === "2030",
        `${win.localStorage.getItem("budget_year")}–${win.localStorage.getItem("budget_year_end")}`);
    win.close();

    win = await open("index.html", {});
    doc = win.document;
    const y = String(new Date().getFullYear());
    ok("index.html: без сохранённого года — текущий, без записи",
        val(doc, "yearInput") === y && win.__writes.length === 0,
        `год ${val(doc, "yearInput")}; записи: ${win.__writes.join(", ") || "нет"}`);
    win.close();
}

/* Свод доходов: calc() при открытии ставил сохранение kb_income_svod_nao */
console.log("\n── Свод доходов: сохранение только после правки");
{
    const KEY = "kb_income_svod_nao";
    const win = await open("income-consolidation.html", {});
    await new Promise((r) => win.setTimeout(r, 1800));
    ok("income-consolidation.html: открытие без записи", win.__writes.length === 0, win.__writes.join(", "));
    const inp = win.document.querySelector('#sectionsContainer input[type="number"]');
    inp.value = "5";
    inp.dispatchEvent(new win.Event("input", { bubbles: true }));
    await new Promise((r) => win.setTimeout(r, 1800));
    ok("income-consolidation.html: правка сохраняется", win.__writes.includes(KEY), win.__writes.join(", ") || "записей нет");
    win.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
process.exit(failed ? 1 : 0);
