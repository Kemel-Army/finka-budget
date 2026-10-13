/**
 * Сквозная проверка импорта:
 *   реальный .xlsx → конвертер из import-excel.html → localStorage →
 *   загрузка страницей → её расчёт → сверка с итогами Excel.
 *
 *     python tests/dump-sheets.py   # один раз, готовит sheets.json
 *     node tests/import.mjs
 *
 * Отдельно проверяется главное требование: лист пишется в ОДИН выбранный
 * филиал, остальные не трогаются.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDom } from "./dom-stub.mjs";
import jsdomPkg from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const sheetsPath = path.join(HERE, "sheets.json");
if (!fs.existsSync(sheetsPath)) {
    console.error(
        "нет tests/sheets.json — сначала: python tests/dump-sheets.py",
    );
    process.exit(2);
}
const SHEETS_RAW = JSON.parse(fs.readFileSync(sheetsPath, "utf8"));

// В книгах у листов встречаются лишние пробелы по краям («Свод »,
// «График род. оплаты Алматы  ») — ищем по очищенному имени
const SHEETS = new Proxy(SHEETS_RAW, {
    get(t, name) {
        if (name in t) return t[name];
        if (typeof name !== "string") return undefined;
        const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const key = Object.keys(t).find((k) => norm(k) === norm(name));
        return key ? t[key] : undefined;
    },
});

/* ── Достаём конвертеры из import-excel.html ─────────────────────── */
function loadImporter() {
    const html = fs.readFileSync(path.join(ROOT, "import-excel.html"), "utf8");
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((s) => s.includes("TARGETS"));
    if (!code) throw new Error("скрипт импорта не найден");

    const { window, document, ensure } = makeDom();
    // регистрируем все id страницы — иначе addEventListener падает на null
    [...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => ensure(m[1]));

    const sandbox = {
        window, document,
        localStorage: window.localStorage,
        console: { log() {}, error() {}, warn() {} },
        fetch: async () => {
            throw new Error("нет сети в тесте");
        },
        parseFloat, parseInt, isNaN, Number, String, Object, Array, JSON, Math,
        Date, Boolean,
        XLSX: {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // budget-rows.js подключён отдельным тегом, но конвертер плана берёт
    // оттуда специфику по наименованию — грузим его в ту же песочницу
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, "budget-rows.js"), "utf8"),
        sandbox,
    );
    vm.runInContext(
        code +
            "\n;globalThis.__imp = { TARGETS, BRANCHES, guessTarget, guessBranch," +
            " convIncomePu, convFotAlmaty, convGrafik, convKomandir," +
            " convMonthlyPlan, convShtatnoe, convRaw, colName," +
            " excelStats, storedStats, verify, pageOf, showResult," +
            " convSsAlmaty, convSsDotacia, convPuKalkulyacia, convPuSvod," +
            " convIncomeDt, convIncomeDop, convPlanRk, convPlanAbroad, convFzp," +
            " storeImported };",
        sandbox,
    );
    return { imp: sandbox.__imp, storage: window.localStorage, document: document };
}

/* ── Прогон расчётного скрипта страницы поверх импортированных данных ── */
function runPageWithStorage(file, needle, exports, seed) {
    const html = fs.readFileSync(path.join(ROOT, file), "utf8");
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((s) => s.includes(needle));
    if (!code) throw new Error(`${file}: расчётный скрипт не найден`);

    const { window, document, ensure } = makeDom();
    [...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => ensure(m[1]));

    for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);

    const sandbox = {
        window, document,
        localStorage: window.localStorage,
        console: { log() {}, error() {}, warn() {} },
        setTimeout: () => 0, clearTimeout: () => {},
        parseFloat, parseInt, isNaN, Number, String, Object, Array, JSON, Math,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        code + `\n;globalThis.__api = { ${exports.join(", ")} };`,
        sandbox,
    );
    return { api: sandbox.__api, document };
}

const read = (doc, id) => {
    const el = doc.getElementById(id);
    if (!el) return NaN;
    return parseFloat(
        String(el.textContent).replace(/\s| /g, "").replace(",", "."),
    );
};

const { imp, storage, document: storageDoc } = loadImporter();
let failed = 0;
let total = 0;

function pass0(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(44)} ${extra}`);
}

function check(label, got, want) {
    total++;
    const r2 = (n) => Math.round(n * 100) / 100;
    const ok = Number.isFinite(got) && Math.abs(r2(got) - r2(want)) < 1e-9;
    if (!ok) failed++;
    console.log(
        `   ${ok ? "OK  " : "FAIL"} ${label.padEnd(44)} ждём ${String(r2(want)).padStart(12)}   получили ${String(Number.isFinite(got) ? r2(got) : "—").padStart(12)}`,
    );
}

/* ── 1. Лист попадает только в выбранный филиал ──────────────────── */
console.log("\n── Импорт пишет только в выбранный филиал");
{
    const rows = SHEETS["ДОХОДНАЯ ЧАСТЬ ПУ"];
    const data = imp.convIncomePu(rows);
    storage.setItem("pu_income_pu_astana", JSON.stringify(data));

    const others = ["almaty", "uralsk", "nao"].filter((b) =>
        storage.getItem("pu_income_pu_" + b),
    );
    total++;
    const ok = others.length === 0;
    if (!ok) failed++;
    console.log(
        `   ${ok ? "OK  " : "FAIL"} запись в pu_income_pu_astana не задела ${["almaty", "uralsk", "nao"].join(", ")}` +
            (ok ? "" : ` — затронуты: ${others.join(", ")}`),
    );
}

/* ── 2. Автоподбор страницы по имени листа ───────────────────────── */
console.log("\n── Автоподбор целевой страницы по названию листа");
{
    const pairs = [
        ["ДОХОДНАЯ ЧАСТЬ ПУ", "pu_income_pu"],
        ["ДОХОДНАЯ ЧАСТЬ ДТ", "pu_income_dt"],
        ["Свод ФОТ Алматы", "pu_fot_almaty"],
        ["График род. оплаты Алматы ", "pu_grafik_almaty"],
        [" Калькуляция Алматы", "pu_kalkulyacia_almaty"],
        ["План командир 2026", "rb_plan_komandir"],
        ["Сводная общая 2026г.", "rb_svodnaya"],
        ["СВОД ФЗП", "rb_fzp"],
    ];
    pairs.forEach(([sheet, want]) => {
        total++;
        const got = imp.guessTarget(sheet);
        const ok = got === want;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} «${sheet.trim()}»`.padEnd(50) +
                ` → ${got || "—"}`,
        );
    });
}

/* ── 3. Доходная часть ПУ: файл → страница → итоги Excel ─────────── */
console.log("\n── Доходная часть ПУ: из файла в страницу");
{
    const data = imp.convIncomePu(SHEETS["ДОХОДНАЯ ЧАСТЬ ПУ"]);
    const { api, document } = runPageWithStorage(
        "pu-income-pu.html",
        "SHEET_KEY",
        ["ROW_DEFS", "buildTable", "loadData"],
        { pu_income_pu_nao: JSON.stringify(data) },
    );
    api.buildTable();
    api.loadData();

    check("T10 сумма месяцев", read(document, "row-2-total"), 9);
    check("T9  вступ. взнос = E×S", read(document, "row-1-total"), 1);
    check("E17 контингент", read(document, "total-cont"), 3);
    check("T17 всего", read(document, "total-total"), 50);
    check("T18 рентабельность 8%", read(document, "profit-total"), 4);
    check("T19 всего со скидкой", read(document, "net-total"), 46);
}

/* ── 4. Свод ФОТ: файл → страница → итоги Excel ──────────────────── */
console.log("\n── Свод ФОТ Алматы: из файла в страницу");
{
    const data = imp.convFotAlmaty(SHEETS["Свод ФОТ Алматы"]);
    const { api, document } = runPageWithStorage(
        "pu-fot-almaty.html",
        'KEY = "pu_fot_almaty"',
        ["COLS", "ROWS", "buildTable", "load"],
        { pu_fot_almaty_nao: JSON.stringify(data) },
    );
    api.buildTable();
    api.load();

    check("M7  штатное расписание", read(document, "r1-fot"), 6);
    check("M11 иные выплаты (без пособия)", read(document, "r3-fot"), 5);
    check("M13 ВСЕГО", read(document, "grand-fot"), 17);
    check("D13 численность ВСЕГО", read(document, "grand-cnt"), 3);
}

/* ── 5. График род. оплаты: файл → страница → итоги Excel ────────── */
console.log("\n── График род. оплаты: из файла в страницу");
{
    const data = imp.convGrafik(SHEETS["График род. оплаты Алматы "]);
    const { api, document } = runPageWithStorage(
        "pu-grafik-almaty.html",
        'KEY = "pu_grafik_almaty"',
        ["TRANCHES", "buildTable", "load"],
        { pu_grafik_almaty_nao: JSON.stringify(data) },
    );
    api.buildTable();
    api.load();

    check("D11 итог траншей 7 кл", read(document, "tot-d"), 2000000);
    check("E11 итог траншей 8–11", read(document, "tot-e"), 1800000);
    check("G7  поступление транша 1", read(document, "t1-g"), 17940000);
    check("K11 итого по траншам", read(document, "tot-k"), 288512000);
    check("N14 ВСЕГО", read(document, "ref-n14"), 313600000);
    check("N16 ВСЕГО со скидкой", read(document, "ref-n16"), 288512000);
}

/* ── 6. План командировок: файл → страница → итоги Excel ─────────── */
console.log("\n── План командировок РБ: из файла в страницу");
{
    const data = imp.convKomandir(SHEETS["План командир 2026"]);
    const { api, document } = runPageWithStorage(
        "rb-plan-komandir.html",
        'SHEET_KEY = "rb_plan_komandir"',
        ["FIELDS", "rows", "buildTable", "loadData"],
        { rb_plan_komandir_nao: JSON.stringify(data) },
    );
    api.loadData();

    // Excel: строки 18..32 — 15 поездок, в полях единицы, оргвзнос растёт
    // 0,0,0,0,0,1,2,…,10. Итоговая строка 33 даёт E33..R33.
    check("строк прочитано из файла", data.rows.length, 15);
    check("J18 суточные = I×D×F×H", read(document, "r1-perDiem"), 1);
    check("R18 всего = J+M+P+Q", read(document, "r1-total"), 3);
    check("R23 всего (оргвзнос 1)", read(document, "r6-total"), 4);
    check("R32 всего (оргвзнос 10)", read(document, "r15-total"), 13);
    check("E33 итого поездок", read(document, "tot-trips"), 15);
    check("J33 итого суточные", read(document, "tot-perDiem"), 15);
    check("M33 итого проезд", read(document, "tot-tripSum"), 15);
    check("P33 итого проживание", read(document, "tot-staySum"), 15);
    check("Q33 итого оргвзносы", read(document, "tot-fee"), 55);
    check("R33 ВСЕГО", read(document, "totalSum"), 100);
}

/* ── 7. План финансирования: разъезжающиеся шапки книг ───────────── */
// Тут же проверяется главная поломка импорта: раньше первая строка листа
// «съедалась», потому что sheet_to_json шёл по '!ref', а Excel не включает
// в него пустые строки сверху. Диапазон теперь принудительно с A1, поэтому
// шапка стоит там же, где в Excel.
console.log("\n── План финансирования: файл → строки расходов");
{
    const cases = [
        {
            label: "РБ (фин. план в 8-й колонке)",
            sheet: "План РБ 2026г платежи",
            rows: 16,
            first: "Оплата труда",
            year: 2692110888,
            jan: 224342574.00000003,
        },
        {
            label: "ПУ (17 статей, есть отрицательная)",
            sheet: "ПЛАН ПУ 2026 ",
            rows: 17,
            first: "Оплата труда",
            year: 559840000,
            jan: 52460938.24,
        },
        {
            label: "Дотация (фин. план в 7-й колонке)",
            sheet: "План дотация 2026",
            rows: 5,
            first: "Оплата труда",
            year: 145494945,
            jan: 16166105,
        },
    ];

    cases.forEach((c) => {
        const sheet = SHEETS[c.sheet];
        if (!sheet) {
            total++;
            failed++;
            console.log(`   FAIL нет листа «${c.sheet}»`);
            return;
        }
        const data = imp.convMonthlyPlan(sheet);
        const sumAll = data.rows.reduce(
            (a, r) => a + r.m.reduce((x, y) => x + y, 0),
            0,
        );
        const sumJan = data.rows.reduce((a, r) => a + r.m[0], 0);

        check(`${c.label}: строк`, data.rows.length, c.rows);
        total++;
        const nameOk = data.rows[0].name.trim() === c.first;
        if (!nameOk) failed++;
        console.log(
            `   ${nameOk ? "OK  " : "FAIL"} ${c.label}: первая строка`.padEnd(58) +
                ` «${data.rows[0].name.trim()}»`,
        );
        check(`${c.label}: год = сумма месяцев`, sumAll, c.year);
        check(`${c.label}: январь`, sumJan, c.jan);
    });

    // Свод ПУ + ДТ: лист «СВОД ПЛАНА 2026» в Excel — это ровно ПУ + дотация
    const pu = imp.convMonthlyPlan(SHEETS["ПЛАН ПУ 2026 "]);
    const dt = imp.convMonthlyPlan(SHEETS["План дотация 2026"]);
    const svod = imp.convMonthlyPlan(SHEETS["СВОД ПЛАНА 2026"]);
    const tot = (d) => d.rows.reduce((a, r) => a + r.m.reduce((x, y) => x + y, 0), 0);
    check("Свод ПУ + ДТ = лист «СВОД ПЛАНА 2026»", tot(pu) + tot(dt), tot(svod));
}

/* ── 8. Справки на передвижку: два листа с одним именем ──────────── */
console.log("\n── Справка на передвижку: файл → строки");
{
    const rb = SHEETS["План по видам Алматы [Справка на передвижку по платежам г Алматы РБ]"];
    const pu = SHEETS["План по видам Алматы [Справка на передвижку по платежам г Алматы ПУ]"];

    if (rb && pu) {
        const dRb = imp.convMonthlyPlan(rb);
        const dPu = imp.convMonthlyPlan(pu);
        check("РБ: строк", dRb.rows.length, 17);
        check(
            "РБ: передвижка сходится в ноль",
            dRb.rows.reduce((a, r) => a + r.m.reduce((x, y) => x + y, 0), 0),
            0,
        );
        check("ПУ: строк", dPu.rows.length, 20);
        check(
            "ПУ: итог передвижки",
            dPu.rows.reduce((a, r) => a + r.m.reduce((x, y) => x + y, 0), 0),
            16738277.7,
        );
    } else {
        console.log("   — листы справок не выгружены (нужен xlrd), пропуск");
    }

    // Один и тот же лист в двух книгах разводится по имени файла
    total++;
    const g1 = imp.guessTarget(
        "План по видам Алматы",
        "Справка на передвижку по платежам г Алматы ПУ.xls",
    );
    const g2 = imp.guessTarget(
        "План по видам Алматы",
        "Справка на передвижку по платежам г Алматы РБ.xls",
    );
    const ok = g1 === "spravka_peredvizhka_pu" && g2 === "spravka_peredvizhka_rb";
    if (!ok) failed++;
    console.log(
        `   ${ok ? "OK  " : "FAIL"} справка ПУ/РБ различаются по файлу`.padEnd(58) +
            ` → ${g1} / ${g2}`,
    );
}

/* ── 9. Филиал определяется по названию, а не молча «НАО» ────────── */
console.log("\n── Филиал по названию листа и файла");
{
    [
        ["ПЛАН ПУ 2026", "План Алматы ПУ 2026 г.xlsx", "almaty"],
        ["Свод", "Бюджет Астана 2026.xlsx", "astana"],
        ["ШР РБ Алматы", "Бюджет РБ 2026.xlsx", "almaty"],
        ["Свод", "Бюджет Уральск.xlsx", "uralsk"],
        ["Свод", "Бюджет 2026.xlsx", ""],
    ].forEach(([sheet, file, want]) => {
        total++;
        const got = imp.guessBranch(sheet, file);
        const ok = got === want;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} ${file} / «${sheet}»`.padEnd(58) +
                ` → ${got || "— не распознан —"}`,
        );
    });
}

/* ── 10. Короткий алиас «Свод» больше не забирает чужие листы ────── */
console.log("\n── Разбор похожих названий листов");
{
    [
        ["Свод", "rb_svod"],
        ["СВОД ФЗП", "rb_fzp"],
        ["Свод ФОТ Алматы", "pu_fot_almaty"],
        ["СВОД общий 2026", "pu_svod_2026"],
        ["Сводная общая 2026г.", "rb_svodnaya"],
        ["СВОД ПЛАНА 2026", ""],
    ].forEach(([sheet, want]) => {
        total++;
        const got = imp.guessTarget(sheet, "");
        const ok = got === want;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} «${sheet}»`.padEnd(58) +
                ` → ${got || "—"}`,
        );
    });
}

/* ── 11. Штатное расписание: колонки ищутся по заголовкам ────────── */
console.log("\n── Штатное расписание: файл → строки");
{
    const sheet = SHEETS["ШР на 02.02.2026 г."];
    if (!sheet) {
        total++;
        failed++;
        console.log("   FAIL нет листа «ШР на 02.02.2026 г.»");
    } else {
        const data = imp.convShtatnoe(sheet);
        const rows = data.periods[0].rows;
        total++;
        const ok = rows.length > 100;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} строк должностей прочитано`.padEnd(58) +
                ` ${rows.length}`,
        );

        const dir = rows.find((r) => /^Директор$/i.test(String(r.post).trim()));
        total++;
        if (!dir) {
            failed++;
            console.log("   FAIL строка «Директор» не найдена");
        } else {
            console.log("   OK   строка «Директор» найдена");
            check("Директор: должностной оклад", dir.do, 176970);
            check("Директор: доплата 10%", dir.d10, 17697);
            total++;
            const dOk = dir.hired === "2023-08-08";
            if (!dOk) failed++;
            console.log(
                `   ${dOk ? "OK  " : "FAIL"} Директор: дата приёма`.padEnd(58) +
                    ` ${dir.hired}`,
            );
        }
    }
}

/* ── 12. Сырой лист: колонки за пределами Z ─────────────────────── */
// Раньше имя колонки бралось как String.fromCharCode(65 + i), и после 26-й
// получались «[», «\», «]». У штатного расписания 35 колонок, у тарификации
// 90 — больше половины листа уезжало в мусорные ключи.
console.log("\n── Сырой лист: имена колонок и полнота");
{
    [
        [0, "A"], [25, "Z"], [26, "AA"], [27, "AB"], [51, "AZ"],
        [52, "BA"], [89, "CL"],
    ].forEach(([i, want]) => {
        total++;
        const got = imp.colName(i);
        const ok = got === want;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} колонка №${i + 1}`.padEnd(58) + ` → ${got}`,
        );
    });

    const shtat = SHEETS["ШР на 02.02.2026 г."];
    const raw = imp.convRaw(shtat);
    check("ШР: колонок в листе", raw.meta.cols, 35);

    // Ни одна ячейка не должна попасть в ключ с посторонним символом
    const badKeys = Object.keys(raw.cells).filter((k) => !/^[A-Z]+\d+$/.test(k));
    total++;
    if (badKeys.length) failed++;
    console.log(
        `   ${badKeys.length ? "FAIL" : "OK  "} ключи ячеек вида A1/AA1`.padEnd(58) +
            ` ${badKeys.length ? badKeys.slice(0, 3).join(", ") : "все верные"}`,
    );

    // Всё, что есть в листе, есть и в сохранённом виде
    const xl = imp.excelStats(shtat);
    const got = imp.storedStats(raw);
    check("ШР: сумма чисел листа = сумма записанного", got.sum, xl.sum);
}

/* ── 13. Сверка ловит недоехавшие данные ────────────────────────── */
console.log("\n── Сверка после импорта");
{
    const sheet = SHEETS["План РБ 2026г платежи"];

    // Сырой импорт обязан сойтись копейка в копейку
    const rawJob = { sheet: "План РБ 2026г платежи", target: { title: "сырой", exact: false } };
    const rawRes = imp.verify(rawJob, sheet, imp.convRaw(sheet));
    total++;
    const rawOk = rawRes.state === "ok";
    if (!rawOk) failed++;
    console.log(
        `   ${rawOk ? "OK  " : "FAIL"} сырой лист сходится копейка в копейку`.padEnd(58) +
            ` разница ${rawRes.diff}`,
    );

    // Разбор по странице берёт часть колонок — это «часть листа», не ошибка
    const planJob = { sheet: "План РБ", target: { title: "План · РБ", exact: true } };
    const planRes = imp.verify(planJob, sheet, imp.convMonthlyPlan(sheet));
    total++;
    const partOk = planRes.state === "part" || planRes.state === "ok";
    if (!partOk) failed++;
    console.log(
        `   ${partOk ? "OK  " : "FAIL"} разбор страницы помечен как «${planRes.state}»`.padEnd(58) +
            ` в файле ${Math.round(planRes.xlSum)}, в системе ${Math.round(planRes.gotSum)}`,
    );

    // Потерю данных сверка обязана заметить: половина листа не доехала
    const halfJob = { sheet: "половина", target: { title: "битый", exact: false } };
    const half = imp.convRaw(sheet.slice(0, Math.floor(sheet.length / 2)));
    const halfRes = imp.verify(halfJob, sheet, half);
    total++;
    const caught = halfRes.state === "bad" && Math.abs(halfRes.diff) > 1;
    if (!caught) failed++;
    console.log(
        `   ${caught ? "OK  " : "FAIL"} потерю половины листа сверка ловит`.padEnd(58) +
            ` разница ${Math.round(halfRes.diff).toLocaleString("ru-RU")}`,
    );

    // Строки «Всего» не должны попадать в контрольную сумму — иначе она
    // сойдётся с чем угодно
    const withTotals = imp.excelStats(sheet);
    total++;
    const totalsSeparated = withTotals.totals.length > 0;
    if (!totalsSeparated) failed++;
    console.log(
        `   ${totalsSeparated ? "OK  " : "FAIL"} строка «Всего» вынесена из суммы`.padEnd(58) +
            ` найдено итогов: ${withTotals.totals.length}`,
    );
}

/* ── 14. Итог импорта виден ─────────────────────────────────────── */
// Раньше о результате говорил только журнал внизу — по нему было не понять,
// доехало что-нибудь или нет
console.log("\n── Итоговое сообщение после импорта");
{
    [
        ["rb_svodnaya", "rb-svodnaya.html"],
        ["pu_income_pu", "pu-income-pu.html"],
        ["plan_fin_rb", "plan-finansirovaniya.html"],
        ["spravka_peredvizhka_pu", "spravki.html"],
        ["shtat", "shtatnoe.html"],
    ].forEach(([key, want]) => {
        total++;
        const got = imp.pageOf(key);
        const ok = got === want;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} ссылка для «${key}»`.padEnd(58) + ` → ${got}`,
        );
    });

    const box = storageDoc.getElementById("resultBlock");

    function say(label, r, wantState, wantIn) {
        imp.showResult(r);
        total++;
        const cls = String(box.className);
        const html = String(box.innerHTML);
        const ok = cls.indexOf(wantState) !== -1 && html.indexOf(wantIn) !== -1;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} ${label}`.padEnd(58) +
                ` класс «${cls}»`,
        );
    }

    const landed = [
        { sheet: "Сводная общая 2026г.", title: "РБ · Сводная общая",
          branch: "Алматы", page: "rb-svodnaya.html" },
    ];

    say("всё сошлось — зелёный",
        { sheets: 1, rows: 645, errors: 0, mismatched: 0, landed },
        "ok", "всё на месте");

    say("есть расхождения — жёлтый",
        { sheets: 2, rows: 100, errors: 0, mismatched: 1, landed },
        "warn", "расхождения");

    say("были ошибки — красный",
        { sheets: 0, rows: 0, errors: 3, mismatched: 0, landed: [] },
        "bad", "ошибками");

    total++;
    const shown = box.hidden === false;
    if (!shown) failed++;
    console.log(`   ${shown ? "OK  " : "FAIL"} блок показывается`.padEnd(58));

    imp.showResult({ sheets: 1, rows: 10, errors: 0, mismatched: 0, landed });
    total++;
    const hasLink = String(box.innerHTML).indexOf('href="rb-svodnaya.html"') !== -1;
    if (!hasLink) failed++;
    console.log(
        `   ${hasLink ? "OK  " : "FAIL"} в итоге есть ссылка на страницу`.padEnd(58),
    );
}

/* ── «СВОД ФЗП»: колонки по шапке, а не по номерам ───────────────── */
// В книге-заготовке ОПВ стоит в K, в рабочей «Бюджет РБ 2026» — в H, а
// налоги сдвинуты на колонку. С номерами колонок в ОПВ уезжал медстрах,
// но итог ФОТ сходился — поэтому сверяем каждое поле по отдельности.
console.log("\n── «СВОД ФЗП»: каждое поле из своей колонки");
{
    const FIELDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];
    // Синтетический лист: в каждой колонке своё число, поле ↔ колонка
    // задаётся шапкой. want — какое число должно оказаться в c1…c9
    function sheet(head, sr, tr) {
        return [
            [], [], [], [], [], [], [], [], [], [],
            ["№ п/п", "Наименование", ...head],
            [1, "Штатное расписание", ...sr],
            [2, "Тарификация ", ...tr],
            ["", "ИТОГО"],
        ];
    }
    const sameRow = (label, got, want) => {
        total++;
        const bad = FIELDS.filter((f, i) => Number(got[f]) !== want[i]);
        if (bad.length) failed++;
        console.log(
            `   ${bad.length ? "FAIL" : "OK  "} ${label}`.padEnd(58) +
                (bad.length
                    ? " не те поля: " + bad.map((f) => `${f}=${got[f]}`).join(", ")
                    : " c1…c9 на своих местах"),
        );
    };

    // Раскладка книги-заготовки: G пособия, H соцналог, I соцотч, J медстрах, K ОПВ
    const TPL = [
        " Фактическая численность един.", "Кол-во часов ", "Заработная плата за месяц",
        " Годовой ФЗП за  2026 год", "Лечебно оздоровительные пособия",
        "Социальный налог 6%", "Социальные отчисления 5%",
        "Обязательное  социальное медицинское схрахование 3% ", "ОПВ 3,5%",
        " Годовой ФОТ за  2026 года с налогами (соц.налог,соц отч, мед страх, пен.взн)",
    ];
    const tpl = imp.convFzp(sheet(TPL, [1, 2, 3, 4, 5, 7, 8, 9, 6, 99], [11, 12, 13, 14, 15, 17, 18, 19, 16, 99]));
    sameRow("заготовка (ОПВ в K): штатное", tpl.rows.sr1, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    sameRow("заготовка (ОПВ в K): тарификация", tpl.rows.tr1, [11, 12, 13, 14, 15, 16, 17, 18, 19]);

    // Рабочая раскладка + шапка с переносами, неразрывными пробелами и
    // другим регистром: G пособия, H ОПВ, I соцналог, J соцотч, K медстрах
    const WORK = [
        "Фактическая\nчисленность", "КОЛ-ВО ЧАСОВ", "заработная плата\nза месяц",
        "Годовой  ФЗП", "Лечебно-оздоровительные пособия", "опв\n3,5%",
        "СОЦИАЛЬНЫЙ\nналог 6%", "Социальные  отчисления", "ОСМС 3%",
        "Годовой ФОТ с налогами (соц.налог, соц отч, мед страх, пен.взн)",
    ];
    const work = imp.convFzp(sheet(WORK, [1, 2, 3, 4, 5, 6, 7, 8, 9, 99], [11, 12, 13, 14, 15, 16, 17, 18, 19, 99]));
    sameRow("рабочая (ОПВ в H), шапка с переносами", work.rows.sr1, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    sameRow("рабочая (ОПВ в H): тарификация", work.rows.tr1, [11, 12, 13, 14, 15, 16, 17, 18, 19]);

    // Настоящий лист рабочей книги: ОПВ — H12, соцналог — I12, медстрах — K12
    const real = SHEETS["СВОД ФЗП [Бюджет РБ 2026]"];
    if (!real) {
        pass0("лист «СВОД ФЗП [Бюджет РБ 2026]» есть в фикстурах", false);
    } else {
        const d = imp.convFzp(real);
        check("Бюджет РБ 2026: штатное c4 ФЗП = F12", d.rows.sr1.c4, real[11][5]);
        check("Бюджет РБ 2026: штатное c5 пособия = G12", d.rows.sr1.c5, real[11][6]);
        check("Бюджет РБ 2026: штатное c6 ОПВ = H12", d.rows.sr1.c6, real[11][7]);
        check("Бюджет РБ 2026: штатное c7 соцналог = I12", d.rows.sr1.c7, real[11][8]);
        check("Бюджет РБ 2026: штатное c8 соцотч = J12", d.rows.sr1.c8, real[11][9]);
        check("Бюджет РБ 2026: штатное c9 медстрах = K12", d.rows.sr1.c9, real[11][10]);
        check("Бюджет РБ 2026: тарификация c6 ОПВ = H13", d.rows.tr1.c6, real[12][7]);
        check("Бюджет РБ 2026: тарификация c9 медстрах = K13", d.rows.tr1.c9, real[12][10]);
    }

    // Шапки нет — понятная ошибка, а не молча нули или перестановка
    const noHead = [[], [1, "Штатное расписание", 1, 2, 3, 4, 5, 6, 7, 8, 9]];
    let msg = "";
    try {
        imp.convFzp(noHead);
    } catch (e) {
        msg = e.message;
    }
    pass0("нет шапки — ошибка с объяснением", /шапк/.test(msg), msg.slice(0, 60));

    const noOsms = TPL.slice();
    noOsms[7] = "Что-то другое";
    msg = "";
    try {
        imp.convFzp(sheet(noOsms, [1], [1]));
    } catch (e) {
        msg = e.message;
    }
    pass0("нет колонки медстраха — ошибка называет её", /медстрах/.test(msg), msg.slice(0, 70));
}

/* ── План командировок: пустые ночи — ноль, а не одна ночь ────────── */
console.log("\n── План командировок: проживание при пустой колонке ночей");
{
    const row = (no, nights) => [no, "поездка " + no, "", "Астана", 100, 1, 3, 2, 0, 5000, 0, 20000, nights];
    const rows = [["№"], row(1, 3), row(2, ""), ["", "Всего :"]];
    const d = imp.convPlanRk(rows);
    check("ночей 3 → проживание 20000 × 3", d.trips[0].hotel, 60000);
    check("ночей нет → проживание 0", d.trips[1].hotel, 0);
}

/* ── Повторный импорт не стирает введённое на странице ──────────────
   Ключ страницы раньше перезаписывался целиком: повторный импорт «СВОД
   общий» писал fact-N = 0 и note-N = "" и стирал факт и примечания,
   введённые на pu-svod-2026. То же с МРП/БДО «Свода ФЗП», визами плана
   за рубеж, реквизитами планов финансирования, настройками и прошлыми
   периодами штатного расписания. */
console.log("\n── Повторный импорт: введённое вручную остаётся");
{
    const T = (key) => imp.TARGETS.find((t) => t.key === key);
    const ls = storage;
    const get = (k) => JSON.parse(ls.getItem(k));

    // «Свод общий»: факт и примечания переживают импорт, план обновляется
    {
        const key = "pu_svod_2026_merge";
        ls.setItem(key, JSON.stringify({
            "plan-1": "1", "fact-1": "500", "note-1": "оплачено в марте",
            "plan-3": "7", "fact-3": "77", "note-3": "",
        }));
        const data = imp.convPuSvod(SHEETS["СВОД общий 2026"]);
        imp.storeImported(T("pu_svod_2026"), key, data);
        const got = get(key);
        pass0("СВОД общий: fact-1 остался", got["fact-1"] === "500", String(got["fact-1"]));
        pass0("СВОД общий: note-1 остался", got["note-1"] === "оплачено в марте", String(got["note-1"]));
        pass0("СВОД общий: fact-3 остался", got["fact-3"] === "77", String(got["fact-3"]));
        check("СВОД общий: plan-1 — из листа", Number(got["plan-1"]), data["plan-1"]);
        check("СВОД общий: plan-3 — из листа", Number(got["plan-3"]), data["plan-3"]);
        pass0("СВОД общий: конвертер факт не пишет", !("fact-1" in data) && !("note-1" in data));

        // Первый импорт (ключа ещё нет) — просто план
        ls.removeItem(key);
        imp.storeImported(T("pu_svod_2026"), key, data);
        pass0("СВОД общий: первый импорт — только план", !("fact-1" in get(key)));
        ls.removeItem(key);
    }

    // «Свод ФЗП»: МРП и БДО со страницы, строки — из листа
    {
        const key = "rb_fzp_merge";
        ls.setItem(key, JSON.stringify({ mrp: "4500", bdo: "30000", rows: { sr1: { c1: 1 } } }));
        const data = imp.convFzp(SHEETS["СВОД ФЗП [Бюджет РБ 2026]"]);
        imp.storeImported(T("rb_fzp"), key, data);
        const got = get(key);
        pass0("СВОД ФЗП: МРП и БДО остались", got.mrp === "4500" && got.bdo === "30000", `${got.mrp} / ${got.bdo}`);
        check("СВОД ФЗП: строки — из листа", got.rows.sr1.c6, data.rows.sr1.c6);
        ls.removeItem(key);
    }

    // План за рубеж: виза по цели и стране, даже если строки переставлены
    {
        const key = "pu_plan_abroad_merge";
        const data = imp.convPlanAbroad(SHEETS["План команд за пределы РК"]);
        const prevTrips = data.trips
            .map((t, i) => Object.assign({}, t, { visa: String(1000 + i), hotel: -1 }))
            .reverse();
        ls.setItem(key, JSON.stringify({ trips: prevTrips }));
        imp.storeImported(T("pu_plan_abroad"), key, data);
        const got = get(key);
        pass0(
            "План за рубеж: визы остались у своих поездок",
            got.trips.length === data.trips.length &&
                got.trips.every((t, i) => t.visa === String(1000 + i)),
            got.trips.map((t) => t.visa).join(", "),
        );
        pass0("План за рубеж: проживание — из листа", got.trips[0].hotel === data.trips[0].hotel);
        ls.removeItem(key);
    }

    // План финансирования: реквизиты документа со страницы
    {
        const key = "plan_fin_rb_merge";
        ls.setItem(key, JSON.stringify({ rows: [], doc: { head: "Директор И. И. Иванов" } }));
        const data = imp.convMonthlyPlan(SHEETS["План РБ 2026г платежи"]);
        imp.storeImported(T("plan_fin_rb"), key, data);
        const got = get(key);
        pass0("План финансирования: реквизиты остались", !!got.doc && got.doc.head === "Директор И. И. Иванов");
        check("План финансирования: строки — из листа", got.rows.length, data.rows.length);
        ls.removeItem(key);
    }

    // Штатное: настройки и прошлые периоды остаются, свой период заменяется
    {
        const key = "shtat_merge";
        const data = imp.convShtatnoe(SHEETS["ШР на 02.02.2026 г."]);
        const label = data.periods[0].label;
        ls.setItem(key, JSON.stringify({
            periods: [
                { id: "p1", label: "Январь 2020", rows: [{ post: "Старый" }] },
                { id: "p2", label: label, rows: [{ post: "Заменится" }] },
            ],
            settings: { mrp: 4500, deduction: 140000, lopK: 1.5 },
        }));
        imp.storeImported(T("shtat"), key, data);
        const got = get(key);
        pass0("Штатное: настройки остались", got.settings.mrp === 4500 && got.settings.lopK === 1.5);
        pass0(
            "Штатное: прошлый период остался, текущий заменён",
            got.periods.length === 2 &&
                got.periods[0].label === "Январь 2020" &&
                got.periods[1].id === "p2" &&
                got.periods[1].rows.length === data.periods[0].rows.length,
            got.periods.map((p) => `${p.label}: ${p.rows.length}`).join("; "),
        );
        ls.removeItem(key);
    }

    // Цели без merge пишут ключ как раньше — целиком
    {
        const key = "pu_income_pu_merge";
        ls.setItem(key, JSON.stringify({ junk: 1 }));
        imp.storeImported(T("pu_income_pu"), key, imp.convIncomePu(SHEETS["ДОХОДНАЯ ЧАСТЬ ПУ"]));
        pass0("без merge ключ перезаписывается целиком", !("junk" in get(key)));
        ls.removeItem(key);
    }
}

/* ══ Импорт → настоящая страница в jsdom → её сохранение ═════════════
   Раньше часть листов клалась «сырыми ячейками» под ключ страницы, а
   страница этот формат не понимала: показывала пустоту или через секунду
   после открытия пересохраняла ключ своими нулями. Здесь лист проходит
   весь путь: конвертер → localStorage → страница загружается → сохраняет
   сама → в ключе остались те же числа. */
const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;

function pass(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(50)} ${extra}`);
}

const JS_HDR = { headers: { "Content-Type": "application/javascript" } };
const XLSX_STUB =
    "window.XLSX = { utils: { book_new: () => ({}), aoa_to_sheet: () => ({})," +
    " json_to_sheet: () => ({}), book_append_sheet: () => {}, sheet_to_json: () => []," +
    " decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }), encode_cell: () => 'A1' }," +
    " read: () => ({ SheetNames: [], Sheets: {} }), writeFile: () => {} };";

// Свои файлы — с диска; CDN — заглушка; auth.js пропускаем (уводит на вход)
const fromDisk = requestInterceptor((request) => {
    if (/^https?:\/\/(cdn|cdnjs|unpkg)/i.test(request.url)) return new Response(XLSX_STUB, JS_HDR);
    const name = decodeURIComponent(request.url.split("/").pop().split("?")[0]);
    const p = path.join(ROOT, name);
    if (name === "auth.js" || !fs.existsSync(p)) return new Response("", JS_HDR);
    return new Response(fs.readFileSync(p, "utf8"), JS_HDR);
});

async function openPage(file, seed) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), "utf8"), {
        runScripts: "dangerously",
        url: "http://localhost/" + file,
        pretendToBeVisual: true,
        virtualConsole: vc,
        resources: { interceptors: [fromDisk] },
        beforeParse(w) {
            w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
            w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
            for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
        },
    });
    const win = dom.window;
    await new Promise((r) => win.addEventListener("load", r, { once: true }));
    // Страницы пересохраняют ключ через секунду после расчёта — ждём дольше
    await new Promise((r) => win.setTimeout(r, 1300));
    return { win, errors };
}

const sumOf = (data) => imp.storedStats(data);

console.log("\n── Импорт → страница: формат понятен, нулями не затирается");
{
    // Какую часть сохранённого сравнивать: МРП и БДО «Свода ФЗП» листу
    // не принадлежат — их страница подставляет сама
    // cells["undefined"] у «Свода» и «Доходов РБ» — поле без data-cell,
    // которое страница пишет при сохранении (отдельная правка страниц);
    // к листу оно не относится
    const noUndef = (d) => {
        if (!d || !d.cells) return d;
        const cells = { ...d.cells };
        delete cells.undefined;
        return { ...d, cells };
    };
    const PICK = { rb_fzp: (d) => d && d.rows, rb_svod: noUndef, rb_income: noUndef };
    const PAGES = [
        "rb_svod", "rb_income", "rb_kalkulyacia", "rb_fzp",
        "pu_svod_2026", "pu_ss_almaty", "pu_ss_dotacia",
        "pu_income_dt", "pu_income_dop", "pu_kalkulyacia_almaty",
        "pu_plan_rk", "pu_plan_abroad",
    ];
    for (const key of PAGES) {
        const target = imp.TARGETS.find((t) => t.key === key);
        const rows = SHEETS[target.sheets[0]];
        if (!rows) {
            pass(`${key}: лист есть в фикстурах`, false);
            continue;
        }
        const data = await (target.conv || imp.convRaw)(rows);
        const pick = PICK[key] || ((d) => d);
        const want = sumOf(pick(data));

        // Часть страниц открывается на НАО, часть — на Алматы: кладём в оба
        const json = JSON.stringify(data);
        const seed = {};
        seed[key + "_nao"] = json;
        seed[key + "_almaty"] = json;
        const file = imp.pageOf(key);
        const { win, errors } = await openPage(file, seed);

        // Сохранение самой страницей: то, что она поняла, она и запишет
        const save = win.saveData || win.save;
        if (typeof save === "function") save();

        const ls = win.localStorage;
        const stored = ["nao", "almaty"].map((b) => {
            try {
                return sumOf(pick(JSON.parse(ls.getItem(key + "_" + b))));
            } catch (e) {
                return { numbers: 0, sum: 0 };
            }
        });
        const same = stored.every(
            (s) => s.numbers > 0 && Math.abs(s.sum - want.sum) < 0.01,
        );
        pass(
            `${file}`,
            want.numbers > 0 && same && !errors.length,
            errors.length
                ? "ошибка страницы: " + errors[0].slice(0, 60)
                : `чисел ${want.numbers}, Σ ${Math.round(want.sum)} → ` +
                      stored.map((s) => Math.round(s.sum)).join(" / "),
        );

        // Ключ строится из sheet/branch — сырые ячейки их не содержат
        const bad = Object.keys(ls).filter((k) => /undefined/.test(k));
        pass(`${file}: нет ключей с «undefined»`, bad.length === 0, bad.join(", "));
        win.close();
    }
}

console.log("\n── «Свод общий»: факт со страницы переживает повторный импорт");
{
    const target = imp.TARGETS.find((t) => t.key === "pu_svod_2026");
    const data = imp.convPuSvod(SHEETS["СВОД общий 2026"]);
    // Как после работы на странице: план прошлого импорта, факт и
    // примечание введены руками. Повторный импорт кладёт план поверх
    const prev = { ...data, "plan-2": "1", "fact-2": "1234.5", "note-2": "аванс" };
    const merged = JSON.stringify(target.merge(prev, data));
    const { win, errors } = await openPage("pu-svod-2026.html", {
        pu_svod_2026_nao: merged,
        pu_svod_2026_almaty: merged,
    });
    const val = (id) => {
        const el = win.document.getElementById(id);
        return el ? el.value : undefined;
    };
    pass(
        "pu-svod-2026: факт и примечание на месте",
        !errors.length && Number(val("fact-2")) === 1234.5 && val("note-2") === "аванс",
        errors.length ? errors[0].slice(0, 60) : `fact-2 = ${val("fact-2")}, note-2 = «${val("note-2")}»`,
    );
    pass(
        "pu-svod-2026: план — из листа",
        Number(val("plan-2")) === Number(data["plan-2"]),
        `plan-2 = ${val("plan-2")}`,
    );
    win.close();
}

console.log("\n── Сырые ячейки без sheet/branch: ключ сохранения не теряется");
{
    // rb-svod, rb-income, rb-kalkulyacia, fot-almaty делали tableData = data
    // и следующее сохранение уходило в «undefined_undefined» / «fot_undefined»
    const CASES = [
        ["rb-svod.html", "rb_svod", { C10: 5 }],
        ["rb-income.html", "rb_income", { E7: 7 }],
        ["rb-kalkulyacia.html", "rb_kalkulyacia", { C5: 9 }],
        ["fot-almaty.html", "fot", { D7: 3 }],
    ];
    for (const [file, key, cells] of CASES) {
        const raw = JSON.stringify({ lastModified: "2026-01-01T00:00:00Z", cells });
        const seed = {};
        ["nao", "almaty"].forEach((b) => (seed[key + "_" + b] = raw));
        const { win } = await openPage(file, seed);
        win.saveData();
        const ls = win.localStorage;
        const bad = Object.keys(ls).filter((k) => /undefined/.test(k));
        pass(`${file}: сохранение не в «undefined»`, bad.length === 0, bad.join(", "));
        const saved = ["nao", "almaty"]
            .map((b) => JSON.parse(ls.getItem(key + "_" + b)))
            .find((d) => d && d.branch);
        const cell = Object.keys(cells)[0];
        pass(
            `${file}: значение ${cell} на месте`,
            !!saved && Number(saved.cells[cell]) === cells[cell],
            saved ? `${cell} = ${saved.cells[cell]}, филиал ${saved.branch}` : "страница не сохранила",
        );
        win.close();
    }
}

console.log("\n── Статьи СС и калькуляции по номеру статьи, а не по строке");
{
    // Синтетический лист с разными числами: № n → D = 10n, E = n, F = 100n
    const rows = [[], ["№", "", "Наименование расходов", "ВСЕГО"], ["", "", "Контингент учащихся", 0, 159, 164]];
    for (let n = 1; n <= 23; n++) {
        rows.push(["", n, "статья " + n, 10 * n, n, 100 * n]);
        if (n === 9) rows.push(["", "", "ИТОГО ФОТ", 999999, 999999, 999999]);
    }
    rows.push(["", "", "Всего расходов", 888888, 888888, 888888]);

    const ss = imp.convSsAlmaty(rows).cells;
    check("СС Алматы D10 = 111: № 1+2+3", ss.D10, 60);
    check("СС Алматы D11 = 113: № 4+9 (с арендой)", ss.D11, 130);
    check("СС Алматы D12 = 116: № 8 (ОПВ)", ss.D12, 80);
    check("СС Алматы D13 = 121: № 5", ss.D13, 50);
    check("СС Алматы F15 = 124: № 7, финцентр", ss.F15, 700);
    check("СС Алматы D20 = 141: № 10", ss.D20, 100);
    check("СС Алматы E32 = 419: № 22, школа", ss.E32, 22);

    const dt = imp.convSsDotacia(rows);
    check("СС Дотация, контингент школы", dt.contingent.school, 159);
    check("СС Дотация, статья 2 всего", dt.items[2].total, 130);
    check("СС Дотация, статья 19 финцентр", dt.items[19].fc, 2200);

    // В калькуляции нет «ИТОГО ФОТ» — номера те же, строки сдвинуты
    const k = imp.convPuKalkulyacia(rows.filter((r) => r[2] !== "ИТОГО ФОТ"));
    check("Калькуляция i1 = (10+20+30) × 323", k.i1, 60 * 323);
    check("Калькуляция i19 = 220 × 323", k.i19, 220 * 323);
}

console.log(
    `\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`,
);
process.exit(failed ? 1 : 0);
