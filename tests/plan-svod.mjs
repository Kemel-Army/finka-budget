/**
 * «План финансирования по платежам», вкладка «Свод ПУ + ДТ».
 *
 * Слагаемые приезжают из двух книг, и одна и та же специфика подписана в
 * них по-разному: «Обязательное медицинское страхование» в ПУ против
 * «Обязательное социальное медицинское страхование» в дотации. Пока свод
 * склеивал строки по паре «специфика + наименование», такие статьи шли
 * двумя строками. Склейка идёт по специфике — но по счёту внутри своего
 * плана: в ПУ специфика 112 стоит дважды (доплаты и минусующая строка за
 * счёт средств Астаны), и складывать их между собой нельзя.
 *
 * Наименования взяты из книги «План Алматы ПУ 2026 г.xlsx» как есть,
 * вместе с опечаткой «разъеды» — из-за неё командировочные приезжали без
 * специфики.
 *
 *     node tests/plan-svod.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(46)} ${extra}`);
}

function eq(label, got, want) {
    total++;
    const good = String(got) === String(want);
    if (!good) failed++;
    console.log(
        `   ${good ? "OK  " : "FAIL"} ${String(label).padEnd(46)}` +
            ` ждём ${JSON.stringify(want)}   получили ${JSON.stringify(got)}`,
    );
}

const PU = [
    "Оплата труда",
    "Дополнительные денежные выплаты",
    "Компенсационные выплаты",
    "Обязательные пенсионные взносы за счет средств работодателя",
    "Социальный налог",
    "Социальные отчисления в Государственный фонд социального страхования",
    "Обязательное медицинское страхование",
    "Приобретение топлива, горюче-смазочных материалов ",
    "Приобретение прочих запасов",
    "Оплата прочих услуг и работ",
    "Командировки и служебные разъеды в пределах РК филиала г.Алматы",
    "Командировки и служебные разъеды за пределы РК филиала г.Алматы",
    "Организация горячим пятиразовым питанием учащихся проживающих в интернате в рамках фонда всеобуча",
    "Прочие текущие затраты ",
    "Приобретение машин, оборудования, инструментов, производственного и хозяйственного инвентаря",
    "Приобретение прочих основных средств (библиотечный фонд)",
    "Дополнительные денежные выплаты за счет средств ФНАО РФМШ Астаны",
];

const DT = [
    "Оплата труда",
    "Обязательные пенсионные взносы за счет работодателя",
    "Социальный налог",
    "Социальные отчисления в Государственный фонд социального страхования",
    "Обязательное социальное медицинское страхование  ",
];

/* ── Страница ────────────────────────────────────────────────────── */
const pageHtml = fs.readFileSync(
    path.join(ROOT, "plan-finansirovaniya.html"),
    "utf8",
);
/* Свой inline-скрипт страницы убираем и запускаем его сами: иначе он
   вызовет MonthlyPlan.init раньше, чем подключатся модули — внешние
   <script src> jsdom в тестах не грузит */
const stripped = pageHtml.replace(
    /<script>[\s\S]*?MonthlyPlan\.init[\s\S]*?<\/script>/,
    "",
);
const dom = new JSDOM(stripped, {
    url: "http://localhost/plan-finansirovaniya.html",
    runScripts: "dangerously",
});
const { window } = dom;

function addScript(code) {
    const el = window.document.createElement("script");
    el.textContent = code;
    window.document.body.appendChild(el);
}

// Строки кладём так, как их положил бы импорт до правки — без специфик
const rows = (names) =>
    names.map((n) => ({ code: "", name: n, m: new Array(12).fill(1) }));
window.localStorage.setItem(
    "plan_fin_pu_almaty",
    JSON.stringify({ rows: rows(PU), doc: {} }),
);
window.localStorage.setItem(
    "plan_fin_dt_almaty",
    JSON.stringify({ rows: rows(DT), doc: {} }),
);

addScript(fs.readFileSync(path.join(ROOT, "budget-rows.js"), "utf8"));
addScript(fs.readFileSync(path.join(ROOT, "monthly-plan-core.js"), "utf8"));
addScript(
    [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((s) => s.includes("MonthlyPlan.init")),
);

// На вкладках с вводом текст лежит в поле, на сводной — прямо в ячейке
function cellText(td) {
    const inp = td.querySelector("input");
    return (inp ? inp.value : td.textContent).trim();
}

function table() {
    return [...window.document.querySelectorAll("#mpBody tr")].map((tr) => ({
        code: cellText(tr.cells[1]),
        name: cellText(tr.cells[2]),
        year: cellText(tr.cells[3]),
    }));
}

function openTab(key) {
    const btn = window.document.querySelector(
        `#mpVariants [data-variant="${key}"]`,
    );
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/* ── Специфика по наименованию ──────────────────────────────────── */
console.log("\n── Разбор наименования в специфику");
{
    const codeFor = window.BUDGET_CODE_FOR;
    eq("командировки в пределах РК (с опечаткой)",
       codeFor("Командировки и служебные разъеды в пределах РК филиала г.Алматы"), "161");
    eq("командировки за пределы РК (с опечаткой)",
       codeFor("Командировки и служебные разъеды за пределы РК филиала г.Алматы"), "162");
    eq("пенсионные взносы «за счет средств работодателя»",
       codeFor("Обязательные пенсионные взносы за счет средств работодателя"), "116");
    eq("библиотечный фонд", codeFor("Приобретение прочих основных средств (библиотечный фонд)"), "416");
    eq("доплаты за счёт средств Астаны — тоже 112",
       codeFor("Дополнительные денежные выплаты за счет средств ФНАО РФМШ Астаны"), "112");
    eq("незнакомая строка остаётся без специфики", codeFor("Ремонт кровли"), "");
}

/* ── Вкладка «Подушевое (ПУ)» ───────────────────────────────────── */
console.log("\n── Платный план: специфика проставлена");
{
    openTab("pu");
    const t = table();
    eq("строк столько же, сколько в книге", t.length, PU.length);
    eq("командировки в пределах РК", t[10].code, "161");
    eq("командировки за пределы РК", t[11].code, "162");
    ok(
        "пустых специфик не осталось",
        t.every((r) => r.code !== ""),
        t.filter((r) => !r.code).map((r) => r.name).join("; "),
    );
}

/* ── Вкладка «Свод ПУ + ДТ» ─────────────────────────────────────── */
console.log("\n── Свод ПУ + ДТ");
{
    openTab("svod");
    const t = table();

    eq("строк ровно столько, сколько в ПУ", t.length, PU.length);

    const count = (code) => t.filter((r) => r.code === code).length;
    eq("специфика 116 одной строкой", count("116"), 1);
    eq("специфика 124 одной строкой", count("124"), 1);
    eq("специфика 111 одной строкой", count("111"), 1);

    // 112 в ПУ стоит дважды и складываться между собой не должна
    eq("специфика 112 осталась двумя строками", count("112"), 2);

    const by = (code) => t.filter((r) => r.code === code)[0];
    // в каждом месяце по единице: ПУ + ДТ = 24 за год, только ПУ = 12
    eq("116: сложились ПУ и дотация", by("116").year, "24,00");
    eq("124: сложились ПУ и дотация", by("124").year, "24,00");
    eq("161: только платный план", by("161").year, "12,00");
    eq("414: только платный план", by("414").year, "12,00");
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
