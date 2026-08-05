/**
 * Страница «Сводная общая»: сетка колонок, вид чисел и общий итог.
 *
 * Разделы рисуются скриптом страницы, поэтому проверяем именно его: раньше
 * пустые ячейки при отрисовке пропускались, и строка налога съезжала влево —
 * ставка вставала в колонку суммы, а сумма уходила в «Действия».
 *
 * Данные берём настоящие: лист «Сводная общая 2026г.» книги «Бюджет РБ
 * 2026.xlsx», прогнанный через тот же конвертер, что и страница импорта.
 *
 *     node tests/svodnaya.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { makeDom } from "./dom-stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(46)} ${extra}`);
}

// Разделитель разрядов у Intl — неразрывный пробел, и какой именно
// (U+00A0 или U+202F) зависит от версии ICU. Сравниваем по обычному
const sp = (s) => String(s).replace(/[\s  ]/g, " ");

function eq(label, got, want) {
    total++;
    const good = sp(got) === sp(want);
    if (!good) failed++;
    console.log(
        `   ${good ? "OK  " : "FAIL"} ${String(label).padEnd(46)}` +
            ` ждём ${JSON.stringify(want)}   получили ${JSON.stringify(got)}`,
    );
}

function near(label, got, want) {
    total++;
    const good = Number.isFinite(got) && Math.abs(got - want) < 0.01;
    if (!good) failed++;
    console.log(
        `   ${good ? "OK  " : "FAIL"} ${String(label).padEnd(46)}` +
            ` ждём ${String(Math.round(want * 100) / 100).padStart(16)}` +
            `   получили ${String(Number.isFinite(got) ? Math.round(got * 100) / 100 : "—").padStart(16)}`,
    );
}

const SHEETS = JSON.parse(fs.readFileSync(path.join(HERE, "sheets.json"), "utf8"));
const sectionsJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "svodnaya_sections_full.json"), "utf8"),
);

/* ── Данные филиала: настоящий лист через конвертер импорта ──────── */
const cells = await (async () => {
    const { window, document, ensure } = makeDom();
    const html = fs.readFileSync(path.join(ROOT, "import-excel.html"), "utf8");
    [...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => ensure(m[1]));

    const sandbox = {
        window, document,
        localStorage: window.localStorage,
        console: { log() {}, warn() {}, error() {} },
        fetch: async () => ({ json: async () => sectionsJson }),
        parseFloat, parseInt, isNaN, Number, String, Object, Array, JSON, Math,
        Date, Boolean, Promise, XLSX: {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "budget-rows.js"), "utf8"), sandbox);
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((s) => s.includes("TARGETS"));
    vm.runInContext(code + "\n;globalThis.__conv = convSvodnaya;", sandbox);

    const rows = SHEETS["Сводная общая 2026г. [Бюджет РБ 2026]"];
    if (!rows) {
        console.log("   нет листа в фикстурах — сначала python tests/dump-sheets.py");
        process.exit(2);
    }
    return sandbox.__conv(rows);
})();

/* ── Страница ────────────────────────────────────────────────────── */
const pageHtml = fs.readFileSync(path.join(ROOT, "rb-svodnaya.html"), "utf8");
/* Внешние скрипты страницы (auth.js, db-sync.js, xlsx) jsdom не грузит —
   сеть в тестах не поднимаем. Свои скрипты добавляем руками. */
const dom = new JSDOM(pageHtml, {
    url: "http://localhost/rb-svodnaya.html",
    runScripts: "dangerously",
});
const { window } = dom;
const { document } = window;

function addScript(code) {
    const el = document.createElement("script");
    el.textContent = code;
    document.body.appendChild(el);
}

window.localStorage.setItem("rb_svodnaya_nao", JSON.stringify(cells));
addScript(fs.readFileSync(path.join(ROOT, "derive.js"), "utf8"));
window.fetch = async () => ({ json: async () => sectionsJson });

await window.loadSectionsData();

/* ── Раздел «Фонд Оплаты Труда»: колонки не съезжают ─────────────── */
console.log("\n── Раздел 1: сетка колонок");
{
    const table = document.querySelector("#section-1 table");
    const head = table.rows[0].cells.length;
    const widths = [...table.rows].map((r) => r.cells.length);
    ok(
        "во всех строках столько же ячеек, сколько в шапке",
        widths.every((w) => w === head),
        `шапка ${head}, строки ${[...new Set(widths)].join("/")}`,
    );

    // Строка «Обязательные пенсионные взносы»: ставка в своей колонке,
    // сумма — в колонке суммы, «Действия» остаются кнопкой
    const row = document.getElementById("sec1_row12");
    const rate = document.getElementById("sec1_row12_col6");
    const money = document.getElementById("sec1_row12_col7");
    ok("ставка налога стоит в своей колонке", !!rate && rate.closest("td").dataset.col === "6");
    ok("сумма стоит в колонке суммы", !!money && money.closest("td").dataset.col === "7");
    ok(
        "в «Действиях» только кнопка удаления",
        !!row && row.cells[row.cells.length - 1].querySelector("button.btn-delete-row") !== null &&
            row.cells[row.cells.length - 1].querySelector("input") === null,
    );
}

/* ── Вид чисел ──────────────────────────────────────────────────── */
console.log("\n── Вид чисел");
{
    const NBSP = " ";
    eq(
        "сумма с разрядами и копейками",
        document.getElementById("sec1_row9_col7").value,
        "746" + NBSP + "224" + NBSP + "709,70",
    );
    eq(
        "ставка долей показана процентом",
        document.getElementById("sec1_row12_col6").value,
        "3,5%",
    );
    eq(
        "текст остаётся текстом",
        document.getElementById("sec1_row11_col6").value,
        "в размере ДО",
    );
    eq("номер строки без копеек", document.getElementById("sec1_row9_col1").value, "1");
    eq(
        "хранится число, а не подпись",
        document.getElementById("sec1_row9_col7").dataset.raw,
        "746224709.7",
    );

    // Ввод в человеческом виде превращается в число
    const inp = document.getElementById("sec1_row9_col7");
    inp.value = "1 234 567,89";
    window.cellBlur(inp);
    eq("введённое с пробелами разобралось", inp.dataset.raw, "1234567.89");
    eq("и показано разрядами", inp.value, "1" + NBSP + "234" + NBSP + "567,89");
    inp.value = "746224709.7";
    window.cellBlur(inp);

    // Ставку можно ввести и процентом
    const rate = document.getElementById("sec1_row12_col6");
    rate.value = "3,5";
    window.cellBlur(rate);
    eq("ставка «3,5» сохранена долей", rate.dataset.raw, "0.035");
}

/* ── Общий итог страницы ────────────────────────────────────────── */
console.log("\n── Общий итог");
{
    near("итог = ФОТ + разделы, как в книге", window.grandTotal(), 2692117127.997505);

    const grand = document.querySelector('input[data-grand-total="1"]');
    ok("последняя строка листа считается сама", !!grand && grand.readOnly);
    if (grand) {
        near("и равна общему итогу", window.parseNum(grand.dataset.raw), 2692117127.997505);
        ok(
            "строка итога помечена как итоговая",
            grand.closest("tr").classList.contains("summary-row"),
        );
    }

    const shown = document.getElementById("grand-total-value").textContent;
    ok("итог виден в подвале страницы", /2\s?692\s?117\s?128,00/.test(shown.replace(/ /g, " ")), shown);
}

/* ── Итог по каждому разделу ────────────────────────────────────── */
/* На листе строки «Итого» у разделов нет — её рисует страница. Числа
   должны совпасть с листом «Свод» исходной книги: раньше по разделам
   вообще ничего не показывалось, а в общий итог попадал только ФОТ.

   Отдельно проверяем разделы после пятого: в рабочей книге они стоят на
   строку ниже, чем в книге-заготовке, по которой сделана разметка. Пока
   импорт не искал заголовок раздела, электроэнергия приезжала пустой, а
   командировочные — нулевыми. */
console.log("\n── Итоги разделов");
{
    const WANT = {
        1: 2113232023.2477493,
        2: 2510052.9100529095,
        3: 565550.0000000001,
        4: 531700,
        5: 49098620.95,
        6: 61221609.38970273,
        7: 11100000,
        8: 85576966,
        9: 5256583,
        10: 362880000,
        11: 144022.5,
    };

    const seen = {};
    document.querySelectorAll("[data-section-total]").forEach((cell) => {
        const box = cell.closest(".section-container");
        const title = box.querySelector("h2").textContent.trim();
        const num = Number(title.split(".")[0]);
        // у раздела 6 итог только у него самого, подразделы свои
        if (seen[num]) return;
        seen[num] = true;
        near(title.slice(0, 42), window.parseNum(cell.textContent), WANT[num]);
    });

    const parts = [...document.querySelectorAll("[data-section-total]")]
        .filter((c) => /^6\./.test(c.closest(".section-container")
            .querySelector("h2").textContent.trim()))
        .slice(1) // первый — сам раздел 6
        .reduce((s, c) => s + window.parseNum(c.textContent), 0);
    near("подразделы 6.1–6.3 дают раздел 6", parts, WANT[6]);
}

/* ── Строка «ИТОГО по таблице» ──────────────────────────────────── */
/* Её рисует sheet-edit.js. В разделе ФОТ число должно быть одно: колонка
   ставки (3,5%, 6%) — не слагаемое. */
console.log("\n── ИТОГО по таблице");
{
    addScript(fs.readFileSync(path.join(ROOT, "sheet-edit.js"), "utf8"));

    const table = document.querySelector("#section-1 table");
    const totalRow = table.querySelector("tr.sx-total");
    ok("строка итога добавлена", !!totalRow);
    if (totalRow) {
        const filled = [...totalRow.cells]
            .slice(1)
            .map((c) => c.textContent.trim())
            .filter((t) => t !== "");
        eq("в итоге одно число", filled.length, 1);
        near(
            "и это итог по фонду оплаты труда",
            window.parseNum(filled[0]),
            2113232023.2477493,
        );
    }
}

/* ── Сохранение ─────────────────────────────────────────────────── */
console.log("\n── Сохранение");
{
    window.saveData();
    const saved = JSON.parse(window.localStorage.getItem("rb_svodnaya_nao"));
    eq(
        "в хранилище лежит число, а не «746 224 709,70»",
        saved.sec1_row9_col7,
        "746224709.7",
    );

    // Ради этого всё и затевалось: «Свод» читает эти же ключи
    const res = window.FinkaDerive.fotFromSvodnaya("nao");
    ok("ФОТ разносится из сохранённого", res.ok, res.reason || "");
    near(
        "оплата труда = штатное + тарификация",
        Number(JSON.parse(window.localStorage.getItem("rb_svod_nao")).cells.C10),
        1595622564.3607502,
    );
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
