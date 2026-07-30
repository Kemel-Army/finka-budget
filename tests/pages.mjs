/**
 * Проверка новых страниц: движки запускаются на мини-DOM, значения вводятся
 * так же, как их вводит пользователь, и результат сверяется с исходными
 * книгами Excel.
 *
 *     node tests/pages.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeMiniDom } from "./mini-dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function check(label, got, want, eps = 0.01) {
    total++;
    const ok = Number.isFinite(got) && Math.abs(got - want) <= eps;
    if (!ok) failed++;
    console.log(
        `   ${ok ? "OK  " : "FAIL"} ${String(label).padEnd(46)}` +
            ` ждём ${String(round(want)).padStart(14)}` +
            `   получили ${String(Number.isFinite(got) ? round(got) : "—").padStart(14)}`,
    );
}

function checkEq(label, got, want) {
    total++;
    const ok = got === want;
    if (!ok) failed++;
    console.log(
        `   ${ok ? "OK  " : "FAIL"} ${String(label).padEnd(46)} ${String(got)}`,
    );
}

const round = (n) => Math.round(n * 100) / 100;

const num = (el) =>
    parseFloat(String(el ? el.textContent : "").replace(/\s| /g, "").replace(",", "."));

/* ── Запуск модуля страницы на мини-DOM ──────────────────────────── */
function runModule(files, mountId, boot, seed = {}) {
    const { window, document, storage } = makeMiniDom();
    for (const [k, v] of Object.entries(seed)) storage.setItem(k, v);

    const mount = document.createElement("div");
    mount.id = mountId;
    document.body.appendChild(mount);

    const sandbox = {
        window,
        document,
        localStorage: storage,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => 0,
        clearTimeout: () => {},
        confirm: () => true,
        prompt: (_, def) => def,
        alert: () => {},
        parseFloat,
        parseInt,
        isNaN,
        Number,
        String,
        Object,
        Array,
        JSON,
        Math,
        Date,
        Boolean,
        Promise,
        XLSX: {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    files.forEach((f) => {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox);
    });
    vm.runInContext(boot, sandbox);
    return { window, document, storage, sandbox };
}

/* ── 1. План-Факт: расчёт строки и нарастающий итог ──────────────── */
console.log("\n── План-Факт ПУ: расчёт строки");
{
    const { document, storage } = runModule(
        ["budget-rows.js", "plan-fact-core.js"],
        "pfRoot",
        `window.PlanFact.init({ storageKey: "plan_fact_pu", title: "ПУ", rows: window.BUDGET_ROWS.PU });`,
    );

    checkEq(
        "таблица построена: строк",
        document.querySelectorAll("#pfBody tr").length,
        17,
    );

    const set = (id, col, v) => {
        const inp = document.querySelector(
            `#pfBody input[data-row="${id}"][data-col="${col}"]`,
        );
        inp.value = String(v);
        inp.dispatch("input");
    };

    // Январь: план 100, справка 20, факт 90 по «Оплате труда»
    set("111", "finPlan", 1200);
    set("111", "plan", 100);
    set("111", "spravka", 20);
    set("111", "fact", 90);

    check("План с остатками = план + справка", num(document.getElementById("pfCell_111_planOst")), 120);
    check("Остатки = план с остатками − факт", num(document.getElementById("pfCell_111_ostatki")), 30);
    check("Факт нарастающим (январь)", num(document.getElementById("pfCell_111_factCum")), 90);
    check("Итого по колонке ФАКТ", num(document.getElementById("pfTFact")), 90);
    check("Строка ФОТ подхватила статью 111", num(document.getElementById("pfFotFact")), 90);

    // Сохранение и нарастающий итог: февраль должен видеть январь
    document.getElementById("pfSaveBtn").dispatch("click");
    const saved = JSON.parse(storage.getItem("plan_fact_pu_nao"));
    checkEq("сохранено в plan_fact_pu_nao, январь", saved.m0["111"].fact, 90);

    const feb = document.querySelectorAll("#pfMonths .month-btn")[1];
    feb.dispatch("click");
    set("111", "plan", 200);
    set("111", "fact", 150);
    check(
        "февраль: план нарастающим = 120 + 200",
        num(document.getElementById("pfCell_111_planCum")),
        320,
    );
    check(
        "февраль: факт нарастающим = 90 + 150",
        num(document.getElementById("pfCell_111_factCum")),
        240,
    );
    check(
        "февраль: остатки нарастающим",
        num(document.getElementById("pfCell_111_ostCum")),
        80,
    );
}

/* ── 2. Сводная ПУ + ДТ складывает два отчёта ────────────────────── */
console.log("\n── План-Факт ПУ + ДТ: суммирование двух источников");
{
    const seed = {
        plan_fact_pu_almaty: JSON.stringify({
            m0: { 111: { finPlan: 1000, plan: 100, spravka: 0, fact: 80 } },
        }),
        plan_fact_dt_almaty: JSON.stringify({
            m0: { 111: { finPlan: 400, plan: 40, spravka: 0, fact: 30 } },
        }),
    };
    const { document } = runModule(
        ["budget-rows.js", "plan-fact-core.js"],
        "pfRoot",
        `window.PlanFact.init({ storageKey: "plan_fact_pu_dt", title: "Свод",
                         rows: window.BUDGET_ROWS.PU,
                         sum: ["plan_fact_pu", "plan_fact_dt"] });`,
        seed,
    );

    checkEq(
        "полей ввода нет — страница расчётная",
        document.querySelectorAll("#pfBody input").length,
        0,
    );

    document
        .querySelectorAll("#pfBranches .branch-btn")
        .filter((b) => b.dataset.branch === "almaty")[0]
        .dispatch("click");

    check("ПУ 100 + ДТ 40 = план", num(document.getElementById("pfCell_111_plan")), 140);
    check("ПУ 80 + ДТ 30 = факт", num(document.getElementById("pfCell_111_fact")), 110);
    check("остатки = 140 − 110", num(document.getElementById("pfCell_111_ostatki")), 30);
    check("фин. план 1000 + 400", num(document.getElementById("pfCell_111_finPlan")), 1400);
}

/* ── 3. План финансирования: год = сумма месяцев, строки правятся ── */
console.log("\n── План финансирования: таблица на 12 месяцев");
{
    const { document, storage } = runModule(
        ["budget-rows.js", "monthly-plan-core.js"],
        "mpRoot",
        `window.MonthlyPlan.init({
             storageKey: "plan_fin", title: "План",
             variants: [
                 { key: "rb", label: "РБ", rows: window.BUDGET_ROWS.PLAN_RB },
                 { key: "pu", label: "ПУ", rows: window.BUDGET_ROWS.PU },
                 { key: "dt", label: "ДТ", rows: window.BUDGET_ROWS.DT },
             ],
             sumVariant: { key: "svod", label: "Свод", of: ["pu", "dt"] },
         });`,
    );

    checkEq(
        "типовой состав РБ подставлен",
        document.querySelectorAll("#mpBody tr").length,
        16,
    );

    const monthInput = (rowIdx, m) =>
        document.querySelector(`#mpBody input[data-idx="${rowIdx}"][data-m="${m}"]`);

    const put = (rowIdx, m, v) => {
        const inp = monthInput(rowIdx, m);
        inp.value = String(v);
        inp.dispatch("input");
    };

    put(0, 0, 1000);
    put(0, 1, 2000);
    put(1, 0, 500);

    check("год по строке = сумма месяцев", num(document.getElementById("mpYear_0")), 3000);
    check("итог за январь по таблице", num(document.getElementById("mpTotM0")), 1500);
    check("итог за год по таблице", num(document.getElementById("mpTotYear")), 3500);

    // Добавление и удаление строк
    document.getElementById("mpAddBtn").dispatch("click");
    checkEq(
        "после «Добавить строку»",
        document.querySelectorAll("#mpBody tr").length,
        17,
    );
    document.querySelectorAll("#mpBody .btn-delete-row")[16].dispatch("click");
    checkEq(
        "после удаления строки",
        document.querySelectorAll("#mpBody tr").length,
        16,
    );

    document.getElementById("mpSaveBtn").dispatch("click");
    const saved = JSON.parse(storage.getItem("plan_fin_rb_almaty"));
    checkEq("сохранено в plan_fin_rb_almaty", saved.rows[0].m[1], 2000);

    // Свод ПУ + ДТ складывает одноимённые статьи двух видов бюджета
    storage.setItem(
        "plan_fin_pu_almaty",
        JSON.stringify({
            rows: [{ code: "111", name: "Оплата труда", m: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
        }),
    );
    storage.setItem(
        "plan_fin_dt_almaty",
        JSON.stringify({
            rows: [{ code: "111", name: "Оплата труда", m: [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
        }),
    );
    document
        .querySelectorAll("#mpVariants .branch-btn")
        .filter((b) => b.dataset.variant === "svod")[0]
        .dispatch("click");

    checkEq(
        "свод: одноимённые статьи слиты в одну строку",
        document.querySelectorAll("#mpBody tr").length,
        1,
    );
    check("свод: 10 + 7 за январь", num(document.getElementById("mpTotM0")), 17);
    checkEq(
        "свод: поля ввода отключены",
        document.querySelectorAll("#mpBody input").length,
        0,
    );
}

/* ── 4. Штатное расписание: формулы сверены с книгой ─────────────── */
console.log("\n── Штатное расписание: формулы строки «Директор»");
{
    // Значения из «Штатное расписание.xlsx», лист «ШР на 02.02.2026 г.»,
    // строка 19: должностной оклад 176 970, доплата 10 % — 17 697.
    const html = fs.readFileSync(path.join(ROOT, "shtatnoe.html"), "utf8");
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((s) => s.includes("SHTAT") || s.includes("Штатное расписание"));

    const { window, document, storage } = makeMiniDom();
    [...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => {
        const el = document.createElement(
            /Mrp|Deduction|LopK|Search/.test(m[1]) ? "input" : "div",
        );
        el.id = m[1];
        document.body.appendChild(el);
    });
    document.getElementById("shMrp").value = "4325";
    document.getElementById("shDeduction").value = "129750";
    document.getElementById("shLopK").value = "2";

    storage.setItem(
        "shtat_almaty",
        JSON.stringify({
            periods: [
                {
                    id: "p1",
                    label: "Февраль 2026",
                    rows: [{ post: "Директор", do: 176970, d10: 17697, units: 1 }],
                },
            ],
            settings: { mrp: 4325, deduction: 129750, lopK: 2 },
        }),
    );

    const sandbox = {
        window,
        document,
        localStorage: storage,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => 0,
        clearTimeout: () => {},
        confirm: () => true,
        prompt: (_, d) => d,
        parseFloat,
        parseInt,
        isNaN,
        Number,
        String,
        Object,
        Array,
        JSON,
        Math,
        Date,
        Boolean,
        XLSX: {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const cell = (k) => num(document.getElementById("shC_0_" + k));

    check("Итого доплаты", cell("addTotal"), 17697);
    check("Всего ФЗП за месяц", cell("fzpMonth"), 194667);
    check("ОПВ 10%", cell("opv"), 19466.7);
    check("ИПН", cell("ipn"), 4155.7);
    check("ВОСМС", cell("vosms"), 3893.34);
    check("Итого на руки", cell("net"), 167151.26);
    check("Всего ФЗП в год", cell("fzpYear"), 2336004);
    check("Лечебно-оздоровительное пособие", cell("lop"), 353940);
    check("Всего ФЗП с пособием", cell("fzpLop"), 2689944);
    check("ОПВР 3,5%", cell("opvr"), 94148.04);
    check("Социальный налог 6%", cell("socTax"), 142453.77);
    check("Социальные отчисления 5%", cell("socOtch"), 121047.48);
    check("ОСМС 3%", cell("osms"), 70080.12);
    check("ВСЕГО ФОТ", cell("fot"), 3117673.41);

    // Добавление месяца копирует состав должностей
    document.getElementById("shAddRow").dispatch("click");
    const model = JSON.parse(storage.getItem("shtat_almaty"));
    checkEq("периодов в хранилище", model.periods.length, 1);
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
