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
            " excelStats, storedStats, verify, pageOf, showResult };",
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

console.log(
    `\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`,
);
process.exit(failed ? 1 : 0);
