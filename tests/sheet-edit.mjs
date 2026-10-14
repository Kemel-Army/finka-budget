/**
 * Прогон всех страниц бюджета в настоящем DOM (jsdom) вместе с sheet-edit.js.
 *
 * Модуль подключён к 22 страницам сразу, поэтому одна ошибка в нём кладёт
 * весь раздел. Здесь проверяется, что на каждой странице он:
 *   • не роняет скрипты страницы,
 *   • не зацикливает MutationObserver (страница перестаёт перерисовываться),
 *   • добавляет строку «ИТОГО по таблице» и панель с кнопками,
 *   • добавляет и удаляет строки, запоминает переименования.
 *
 *     node tests/sheet-edit.mjs
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

const PAGES = [
    "rb-svod.html", "rb-svodnaya.html", "rb-income.html", "rb-fzp.html",
    "rb-kalkulyacia.html", "rb-plan-komandir.html",
    "pu-svod-2026.html", "pu-ss-almaty.html", "pu-ss-dotacia.html",
    "pu-income-pu.html", "pu-income-dt.html", "pu-income-dop.html",
    "pu-fot-almaty.html", "pu-grafik-almaty.html", "pu-kalkulyacia-almaty.html",
    "pu-plan-rk.html", "pu-plan-abroad.html",
    "fot-almaty.html", "fot-consolidation.html", "income-consolidation.html",
    "kb-svod.html", "plan-fact.html",
];

// Заглушка SheetJS: сети в тесте нет, а экспорт вызывается со страниц
const XLSX_STUB = `
window.XLSX = {
    utils: {
        book_new: () => ({}), aoa_to_sheet: () => ({}), json_to_sheet: () => ({}),
        book_append_sheet: () => {}, sheet_to_json: () => [], sheet_to_html: () => "",
        decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
        encode_cell: () => "A1",
    },
    read: () => ({ SheetNames: [], Sheets: {} }),
    writeFile: () => {},
};
window.html2pdf = () => ({ from: () => ({ save: () => {} }) });
`;

/* Локальные файлы отдаём с диска — тогда скрипты страницы выполняются в том
   же порядке, что и в браузере, включая shared-export.js и sheet-edit.js.
   Внешние CDN подменяются заглушкой, auth.js пропускается: он уводит на
   страницу входа и тянет SDK по сети. */
const JS = { headers: { "Content-Type": "application/javascript" } };

const localFiles = requestInterceptor((request) => {
    const url = request.url;
    if (/^https?:\/\/(cdn|cdnjs|unpkg)/i.test(url)) {
        return new Response(XLSX_STUB, JS);
    }
    // SheetJS лежит в vendor/ — в тесте его заменяет та же заглушка
    if (/\/vendor\/xlsx[^/]*\.js$/i.test(url.split("?")[0])) {
        return new Response(XLSX_STUB, JS);
    }
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    if (name === "auth.js") return new Response("", JS);
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
        return new Response(fs.readFileSync(p, "utf8"), JS);
    }
    return new Response("", JS);
});

/* matchMedia и fetch страницам даёт браузер. Ставятся в beforeParse — до
   первого скрипта, иначе страница успевает позвать fetch раньше подмены. */
function installStubs(window) {
    if (!window.matchMedia) {
        window.matchMedia = () => ({
            matches: false, addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {},
        });
    }
    // Сводная общая тянет состав разделов через fetch — отдаём файл с диска
    window.fetch = async (url) => {
        const name = String(url).split("/").pop().split("?")[0];
        const p = path.join(ROOT, decodeURIComponent(name));
        if (!fs.existsSync(p)) {
            return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        }
        const text = fs.readFileSync(p, "utf8");
        return {
            ok: true, status: 200,
            text: async () => text,
            json: async () => JSON.parse(text),
        };
    };
}

// seed — данные в localStorage до первого скрипта страницы
async function load(file, seed = {}) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    vc.on("error", (...a) => errors.push(String(a[0])));

    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), "utf8"), {
        runScripts: "dangerously",
        url: "http://localhost/" + file,
        pretendToBeVisual: true,
        virtualConsole: vc,
        resources: { interceptors: [localFiles] },
        beforeParse(w) {
            installStubs(w);
            for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
        },
    });

    const win = dom.window;
    await new Promise((r) => win.addEventListener("load", r, { once: true }));
    await tick(win, 400);
    return { dom, win, errors };
}

function tick(win, ms) {
    return new Promise((r) => win.setTimeout(r, ms));
}

/* ── Прогон всех страниц ─────────────────────────────────────────── */
console.log("\n── Страницы бюджета в jsdom: sheet-edit.js не ломает расчёты");

for (const page of PAGES) {
    let win, errors, dom;
    try {
        ({ dom, win, errors } = await load(page));
    } catch (e) {
        ok(page, false, "не загрузилась: " + e.message);
        continue;
    }

    const doc = win.document;
    const totals = doc.querySelectorAll("tr.sx-total").length;
    const bars = doc.querySelectorAll(".sx-bar").length;
    const hard = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));

    // Планы командировок открываются с пустой таблицей — строк ещё нет,
    // значит и итожить нечего; панель с кнопками должна быть всё равно
    const hasData = [...doc.querySelectorAll("tbody tr")].some(
        (tr) =>
            !tr.classList.contains("sx-total") &&
            tr.querySelector("input, .formula-cell, .auto-cell"),
    );

    ok(
        page,
        hard.length === 0 && bars > 0 && (totals > 0 || !hasData),
        `итогов: ${totals}, панелей: ${bars}` +
            (hasData ? "" : ", таблица пуста") +
            (hard.length ? ` · ошибки: ${hard.slice(0, 2).join(" | ").slice(0, 160)}` : ""),
    );

    dom.window.close();
}

/* ── Подробная проверка на одной странице ────────────────────────── */
console.log("\n── Правки: переименование, добавление и удаление строки");
{
    const { win } = await load("rb-svod.html");
    const doc = win.document;
    const table = doc.querySelector("table");
    const store = win.localStorage;

    // Сумма по колонке считается по строкам с данными, без строки итогов
    // самой страницы — иначе удвоится
    const firstInput = table.querySelector('tbody input[type="number"]');
    firstInput.value = "1000";
    firstInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(win, 250);

    const totalRow = doc.querySelector("tr.sx-total");
    ok("строка «ИТОГО по таблице» построена", !!totalRow);

    const totalHasValue = [...totalRow.cells].some((td) =>
        /1\s?000/.test(td.textContent),
    );
    ok("введённая 1000 попала в итог", totalHasValue, totalRow.textContent.trim().slice(0, 70));

    // Переименование строки
    const nameCell = doc.querySelector('td.sx-name[data-sx-name]');
    ok("наименования сделаны редактируемыми", !!nameCell);
    if (nameCell) {
        // Щелчок без ввода — не правка
        nameCell.dispatchEvent(new win.Event("blur", { bubbles: true }));
        await tick(win, 50);
        ok(
            "щелчок по названию без ввода ничего не сохраняет",
            !Object.keys(JSON.parse(store.getItem("sheet_edits_rb-svod.html_nao") || "{}").names || {}).length,
        );
        nameCell.textContent = "Оплата труда (изменено)";
        nameCell.dispatchEvent(new win.Event("input", { bubbles: true }));
        nameCell.dispatchEvent(new win.Event("blur", { bubbles: true }));
        await tick(win, 100);
        const saved = JSON.parse(store.getItem("sheet_edits_rb-svod.html_nao") || "{}");
        ok(
            "переименование сохранено",
            Object.values(saved.names || {}).includes("Оплата труда (изменено)"),
        );
    }

    // Добавление строки
    const before = doc.querySelectorAll("tr.sx-extra").length;
    doc.querySelector(".sx-bar .sx-add").dispatchEvent(
        new win.Event("click", { bubbles: true }),
    );
    await tick(win, 250);
    const after = doc.querySelectorAll("tr.sx-extra").length;
    ok("«Добавить строку» добавляет строку", after === before + 1, `${before} → ${after}`);

    const extra = doc.querySelector("tr.sx-extra");
    const extraNum = extra && extra.querySelector('input[type="number"]');
    ok("в добавленной строке есть числовые поля", !!extraNum);
    if (extraNum) {
        extraNum.value = "777";
        extraNum.dispatchEvent(new win.Event("input", { bubbles: true }));
        await tick(win, 200);
        const t = doc.querySelector("tr.sx-total").textContent;
        ok("сумма добавленной строки попала в итог", /777|1\s?777/.test(t), t.slice(0, 70));
    }

    // Удаление
    win.confirm = () => true;
    extra.querySelector(".sx-del").dispatchEvent(new win.Event("click", { bubbles: true }));
    await tick(win, 250);
    ok(
        "«✕» удаляет добавленную строку",
        doc.querySelectorAll("tr.sx-extra").length === before,
    );

    win.close();
}

/* ── Итоги самой страницы не попадают в «ИТОГО по таблице» ───────── */
/* Строки sub-row («Итого по тарификации», «Рентабельность 8%») и grand-row
   («ВСЕГО») — расчётные итоги страницы. Пока они считались строками данных,
   «ИТОГО по таблице» складывал их вместе с исходными строками: введённая
   1000 превращалась в итоге в 2000–3000. */
console.log("\n── «ИТОГО по таблице» без промежуточных итогов страницы");
for (const [page, inputId, value, label] of [
    ["pu-fot-almaty.html", "r1-fzp", 1000, "ФЗП: 1000 в строке 1"],
    ["pu-income-pu.html", "row-2-m1", 1000, "январь: 1000 в строке 2"],
]) {
    const { win, errors } = await load(page);
    const doc = win.document;
    const inp = doc.getElementById(inputId);
    ok(`${page}: поле ${inputId} есть`, !!inp);
    if (!inp) {
        win.close();
        continue;
    }
    inp.value = String(value);
    inp.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(win, 300);

    const table = inp.closest("table");
    const sx = table.querySelectorAll("tr.sx-total");
    ok(`${page}: одна строка «ИТОГО по таблице»`, sx.length === 1, `строк: ${sx.length}`);

    // Колонка поля в строке итога — с учётом colspan в первой ячейке
    const col = (tr, cell) => {
        let c = 0;
        for (const td of tr.cells) {
            if (td === cell) return c;
            c += parseInt(td.getAttribute("colspan"), 10) || 1;
        }
        return -1;
    };
    const at = (tr, idx) => {
        let c = 0;
        for (const td of tr.cells) {
            const span = parseInt(td.getAttribute("colspan"), 10) || 1;
            if (idx >= c && idx < c + span) return td;
            c += span;
        }
        return null;
    };
    const idx = col(inp.closest("tr"), inp.closest("td"));
    const cell = sx.length ? at(sx[0], idx) : null;
    const got = cell
        ? parseFloat(cell.textContent.replace(/[\s ]/g, "").replace(",", "."))
        : NaN;
    ok(`${page}: ${label} → в итоге ${value}`, got === value, `получили ${cell ? cell.textContent.trim() : "—"}`);

    const hard = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    ok(`${page}: без ошибок`, hard.length === 0, hard.slice(0, 1).join("").slice(0, 120));
    win.close();
}

/* ── Старые ключи переименований остаются на своих строках ───────── */
/* Ключ переименования — t{таблица}r{номер строки данных}c{колонка}, и такие
   ключи уже лежат в базе (sheet_edits_*). Строки итогов страницы (sub-row,
   grand-row, row-total, mega-row) исключены только из «ИТОГО по таблице»;
   выкинь их из нумерации — сохранённые наименования съехали бы на чужие
   строки. Нумерацию здесь считаем по прежнему правилу (как в main). */
console.log("\n── Старые ключи переименований — на тех же строках");
{
    const SUBTOTAL = ["sub-row", "grand-row", "row-total", "mega-row"];
    // Прежнее правило isServiceRow — без классов итогов
    const oldService = (tr) =>
        ["sx-total", "total-row", "summary-row", "grand-total-row", "fot-row"]
            .some((c) => tr.classList.contains(c)) || !!tr.querySelector(".title-cell");
    const oldData = (tr) =>
        !oldService(tr) && !!tr.querySelector("input, .formula-cell, .auto-cell");
    const sheetTables = (doc) =>
        [...doc.querySelectorAll("table")].filter(
            (t) => !t.hasAttribute("data-no-sheet-edit") && !t.closest(".finka-nav") && t.tBodies.length,
        );
    const isText = (td) =>
        !td.querySelector("input") &&
        !td.classList.contains("formula-cell") &&
        !td.classList.contains("auto-cell");
    const MARK = "ПРОВЕРКА старого ключа";

    for (const page of ["pu-fot-almaty.html", "rb-fzp.html", "fot-consolidation.html", "pu-grafik-almaty.html"]) {
        // Первый проход: находим строку данных ниже строки итога
        let { win } = await load(page);
        let doc = win.document;
        let found = null;
        sheetTables(doc).forEach((table, tIdx) => {
            if (found) return;
            const rows = [...table.tBodies].flatMap((b) => [...b.rows]).filter(oldData);
            let afterSub = false;
            rows.forEach((tr, ri) => {
                if (found) return;
                if (SUBTOTAL.some((c) => tr.classList.contains(c))) {
                    afterSub = true;
                    return;
                }
                if (!afterSub) return;
                const c = [...tr.cells].findIndex((td) => isText(td) && td.textContent.trim());
                if (c < 0) return;
                const all = [...table.querySelectorAll("tr")];
                found = { tIdx, ri, c, rowPos: all.indexOf(tr), orig: tr.cells[c].textContent.trim() };
            });
        });
        const branchBtn = doc.querySelector(".branch-btn.active");
        const m = branchBtn && /switchBranch\(['"]([^'"]+)/.exec(branchBtn.getAttribute("onclick") || "");
        const branch = (branchBtn && branchBtn.getAttribute("data-branch")) || (m && m[1]) || "nao";
        win.close();

        ok(`${page}: есть строка данных ниже строки итога`, !!found);
        if (!found) continue;

        // Второй проход: правка по старому ключу уже лежит в localStorage
        const key = `t${found.tIdx}r${found.ri}c${found.c}`;
        ({ win } = await load(page, {
            [`sheet_edits_${page}_${branch}`]: JSON.stringify({ names: { [key]: MARK } }),
        }));
        doc = win.document;
        const table = sheetTables(doc)[found.tIdx];
        const tr = table && [...table.querySelectorAll("tr")][found.rowPos];
        const got = tr && tr.cells[found.c] ? tr.cells[found.c].textContent.trim() : "—";
        const where = [...doc.querySelectorAll("td")].filter((td) => td.textContent.trim() === MARK).length;
        ok(
            `${page}: ${key} → «${found.orig.slice(0, 20)}»`,
            got === MARK && where === 1,
            `в ячейке: «${got.slice(0, 30)}», совпадений: ${where}`,
        );
        win.close();
    }
}

/* ── Ячейки rb-income / rb-svod: только поля с data-cell ─────────── */
/* Сохранение собирало все <input> страницы, и поля добавленных строк
   sheet-edit.js (у них нет data-cell) ложились в cells["undefined"]. */
console.log('\n── Сохранение ячеек без мусорного ключа cells["undefined"]');
for (const [page, sheet] of [
    ["rb-income.html", "rb_income"],
    ["rb-svod.html", "rb_svod"],
]) {
    // Филиал, в который страница сохраняет при открытии, — дело ключей
    // хранения; здесь важны только ячейки, поэтому мусор кладём во все
    const seed = {};
    for (const b of ["nao", "almaty", "astana", "uralsk"]) {
        seed[sheet + "_" + b] = JSON.stringify({ sheet, branch: b, cells: { undefined: "5" } });
    }
    const { win } = await load(page, seed);
    const doc = win.document;
    doc.querySelector(".sx-bar .sx-add").dispatchEvent(new win.Event("click", { bubbles: true }));
    await tick(win, 200);
    const extra = doc.querySelector("tr.sx-extra input");
    const cellInput = doc.querySelector("input[data-cell]");
    if (extra) {
        extra.value = "77";
        extra.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    cellInput.value = "123";
    cellInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(win, 1300);
    let cells = null;
    for (const b of ["nao", "almaty", "astana", "uralsk"]) {
        const c = JSON.parse(win.localStorage.getItem(sheet + "_" + b) || "{}").cells || {};
        if (c[cellInput.dataset.cell] === "123") cells = c;
    }
    ok(`${page}: ячейка сохранена`, !!cells);
    ok(`${page}: нет ключа cells["undefined"]`, !!cells && !("undefined" in cells),
        cells ? Object.keys(cells).slice(0, 5).join(",") : "");
    win.close();
}

/* ── КБ: поле ввода не округляется ───────────────────────────────── */
/* fmt() показывает целые тенге — для итогов это нормально, но им же
   заполнялись поля ввода: после перерисовки 1234,56 превращалось в «1 235»,
   и любая правка поля сохраняла уже округлённое число. */
console.log("\n── КБ: копейки в поле ввода сохраняются");
{
    const { win } = await load("kb-svod.html", {
        kb_svod_v3: JSON.stringify({ extraYears: [], rows: { r1: { vals: { y2026: 1234.56 } } } }),
    });
    const inp = win.document.getElementById("inp_r1_2026");
    const shown = inp ? inp.value.replace(/[\s\u00a0\u202f]/g, "") : "";
    ok("в поле 1234,56, а не 1235", shown === "1234,56", inp ? inp.value : "нет поля");
    const total = win.document.getElementById("tv_2026");
    ok("итог округлён только на экране", total && /1\s?235/.test(total.textContent), total ? total.textContent : "");
    win.close();
}

/* ── Добавленная строка принадлежит своей таблице ────────────────── */
/* Список добавленных строк был один на страницу и накладывался на каждую
   таблицу: строка, заведённая под «Водоотведением», появлялась во всех
   четырнадцати разделах «Сводной общей». */
console.log("\n── Добавленная строка не расползается по разделам");
{
    const { win } = await load("rb-svodnaya.html");
    const doc = win.document;
    const bars = doc.querySelectorAll(".sx-bar");
    ok("на странице несколько таблиц", bars.length > 1, `панелей: ${bars.length}`);

    const target = 2; // третий раздел, не первый и не последний
    bars[target]
        .querySelector(".sx-add")
        .dispatchEvent(new win.Event("click", { bubbles: true }));
    await tick(win, 300);

    const withExtra = [...doc.querySelectorAll("table")]
        .map((t, i) => [i, t.querySelectorAll("tr.sx-extra").length])
        .filter(([, n]) => n > 0);

    ok(
        "строка появилась ровно в одной таблице",
        withExtra.length === 1,
        withExtra.length === 1
            ? `таблица №${withExtra[0][0]}`
            : `таблиц со строкой: ${withExtra.length}`,
    );

    const saved = JSON.parse(
        win.localStorage.getItem("sheet_edits_rb-svodnaya.html_nao") || "{}",
    );
    ok(
        "в хранилище строки разложены по таблицам",
        saved.extra && !Array.isArray(saved.extra),
        JSON.stringify(saved.extra || null).slice(0, 60),
    );

    win.close();
}

/* ── Единообразие страниц ────────────────────────────────────────── */
// Раньше КБ носил собственную навигацию и собственные её стили, а страницы
// ПУ получали шапку другой формы, чем страницы РБ. Здесь это закреплено,
// чтобы оформление снова не разъехалось.
console.log("\n── Все страницы бюджета выглядят одинаково");
{
    const CHROME = [...PAGES, "plan-fact-pu.html", "plan-fact-dt.html",
        "plan-fact-pu-dt.html", "plan-finansirovaniya.html", "spravki.html",
        "shtatnoe.html", "osnovaniya.html", "dogovory.html", "forma-4-20.html",
        "deposit.html"];

    for (const page of CHROME) {
        const src = fs.readFileSync(path.join(ROOT, page), "utf8");
        const { win } = await load(page);
        const doc = win.document;

        const css = /href="shared\.css"/.test(src);
        const navScript = /src="shared-nav\.js"/.test(src);
        const navInjected = !!doc.querySelector("nav.finka-nav");
        // собственная <nav> помимо общей — как раз то, что разъезжалось
        const ownNav = [...doc.querySelectorAll("nav")].filter(
            (n) => !n.classList.contains("finka-nav"),
        ).length;
        // ссылка «на главную» ровно одна и рисуется навигацией
        const backs = doc.querySelectorAll(".back-link");
        const back = backs.length === 1 && !!backs[0].closest("nav.finka-nav");
        // панель выгрузки одна, рисует shared-export.js: Excel → PDF → Печать
        const bars = doc.querySelectorAll(".export-bar");
        const order = bars.length
            ? [...bars[0].querySelectorAll("[data-export-action]")]
                  .map((b) => b.getAttribute("data-export-action"))
                  .join(",")
            : "";
        const exportOk = bars.length === 1 && order === "excel,pdf,print";
        // SheetJS — один раз и из vendor/, без CDN
        const xlsxTags = src.match(/<script[^>]+xlsx[^>]*><\/script>/g) || [];
        const xlsxOk = xlsxTags.length === 1 && /src="vendor\//.test(xlsxTags[0]);

        const good = css && navScript && navInjected && ownNav === 0 && back &&
            exportOk && xlsxOk;
        ok(
            page,
            good,
            [
                css ? "" : "нет shared.css",
                navScript ? "" : "нет shared-nav.js",
                navInjected ? "" : "навигация не встроилась",
                ownNav ? `своя <nav>: ${ownNav}` : "",
                back ? "" : `ссылок «на главную»: ${backs.length}, нужна одна в навигации`,
                exportOk ? "" : `панелей выгрузки: ${bars.length}, кнопки: ${order || "—"}`,
                xlsxOk ? "" : `SheetJS подключён ${xlsxTags.length} раз(а) или не из vendor/`,
            ]
                .filter(Boolean)
                .join(", ") || "шапка, навигация и стили общие",
        );
        win.close();
    }
}

/* ── Числа, значки и формулы ─────────────────────────────────────── */
console.log("\n── Оформление: разряды, два знака, значки, формулы");
{
    const { win } = await load("rb-svod.html");
    const doc = win.document;
    const NBSP = " ";

    // Разряды и ровно два знака после запятой
    const cell = doc.querySelector("td.formula-cell, td.auto-cell");
    if (cell) {
        cell.textContent = "1000000";
        win.finkaUi.apply();
        ok(
            "1000000 → 1 000 000,00",
            cell.textContent === "1" + NBSP + "000" + NBSP + "000,00",
            JSON.stringify(cell.textContent),
        );

        cell.textContent = "0,3333";
        win.finkaUi.apply();
        ok("0,3333 → 0,33", cell.textContent === "0,33", cell.textContent);

        cell.textContent = "—";
        win.finkaUi.apply();
        ok("прочерк не трогается", cell.textContent === "—", cell.textContent);
    } else {
        ok("расчётные ячейки найдены", false);
    }

    // Значки вместо эмодзи. Стрелки и «гамбургер» в навигации — обычная
    // типографика, а не эмодзи, их не трогаем
    const NAV = ".finka-nav-btn, .finka-nav-mobile-btn, .back-link, .finka-user-logout";
    const withEmoji = [...doc.querySelectorAll("button, .btn")].filter(
        (b) =>
            !b.closest(".finka-nav") &&
            !b.matches(NAV) &&
            /[\u{1F300}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{FE0F}]/u.test(
                b.textContent,
            ),
    );
    ok(
        "эмодзи на кнопках заменены значками",
        withEmoji.length === 0,
        withEmoji.length ? withEmoji.map((b) => b.textContent.trim()).join(" | ").slice(0, 70) : "",
    );
    ok(
        "значки нарисованы",
        doc.querySelectorAll("button .uk-ico, .btn .uk-ico").length > 0,
        `${doc.querySelectorAll(".uk-ico").length} шт.`,
    );

    // Подпись поверх поля ввода: значение самого поля не меняется
    const inp = doc.querySelector('td.editable input[type="number"]');
    if (inp) {
        inp.value = "2500000";
        win.finkaUi.apply();
        const shadow = inp.parentNode.querySelector(".uk-shadow");
        ok(
            "поверх поля показаны разряды",
            !!shadow && shadow.textContent === "2" + NBSP + "500" + NBSP + "000,00",
            shadow ? JSON.stringify(shadow.textContent) : "подписи нет",
        );
        ok(
            "значение поля осталось машинным",
            inp.value === "2500000" && win.parseFloat(inp.value) === 2500000,
            inp.value,
        );
    } else {
        ok("поля ввода найдены", false);
    }

    // Формулы: панель ставок и подсказка на ячейке
    ok("панель «Ставки и формулы» построена", !!doc.querySelector(".fx-panel"));
    ok(
        "ставки доступны странице",
        win.finkaRates && win.finkaRates.get("opv") === 10,
        `ОПВ = ${win.finkaRates && win.finkaRates.get("opv")} %`,
    );

    win.finkaRates.set("opv", 12);
    ok("ставка меняется и сохраняется", win.finkaRates.get("opv") === 12);
    win.finkaRates.reset();
    ok("сброс возвращает типовую", win.finkaRates.get("opv") === 10);

    // Масштаб таблиц
    ok("масштаб появился", !!doc.querySelector(".uk-zoom"));
    ok("по умолчанию 100 %", win.finkaUi.zoom() === 100, `${win.finkaUi.zoom()} %`);

    const box = doc.querySelector(".table-container, .table-wrap");
    win.finkaUi.setZoom(80);
    ok(
        "уменьшение применяется к таблице",
        win.finkaUi.zoom() === 80 && String(box.style.zoom) === "0.8",
        `zoom = ${box.style.zoom || "(нет)"}`,
    );

    win.finkaUi.setZoom(100);
    ok(
        "возврат к 100 % убирает масштаб",
        !box.style.zoom,
        `zoom = ${box.style.zoom || "(нет)"}`,
    );

    // Масштаб помнится для каждой страницы отдельно
    win.finkaUi.setZoom(125);
    ok(
        "масштаб запомнился для этой страницы",
        win.localStorage.getItem("zoom_rb-svod.html") === "125",
        win.localStorage.getItem("zoom_rb-svod.html"),
    );
    win.finkaUi.setZoom(100);

    const fx = doc.querySelector("td.fx");
    ok(
        "расчётные ячейки помечены как объяснимые",
        !!fx,
        fx ? `первая: «${fx.textContent.trim().slice(0, 20)}»` : "нет ни одной",
    );

    win.close();
}

/* ── Ширины колонок фиксируются, чтобы цифры не плыли ────────────── */
console.log("\n── Ширины колонок не пересчитываются при вводе");
{
    const { win } = await load("plan-fact.html");
    const doc = win.document;

    // jsdom ничего не отрисовывает и отдаёт нулевые размеры — подставляем
    // замеры, иначе проверять было бы нечего
    const widthOf = (el) =>
        el.tagName === "TH" || el.tagName === "TD" ? 120 : 0;
    win.Element.prototype.getBoundingClientRect = function () {
        const w = widthOf(this);
        return { width: w, height: 24, top: 0, left: 0, right: w, bottom: 24, x: 0, y: 0 };
    };

    win.finkaUi.apply();

    const table = doc.getElementById("pfTable");
    const group = table.querySelector("colgroup");

    // Столько колонок в строке данных — столько и должно быть замеров.
    // Мерить по шапке нельзя: у «План-Факта» её нижняя строка это три
    // ячейки на тринадцать колонок, и таблицу бы перекосило
    const dataRow = table.tBodies[0].rows[0];
    const cols = [...dataRow.cells].reduce(
        (n, c) => n + (parseInt(c.getAttribute("colspan"), 10) || 1),
        0,
    );
    ok(
        "замеров столько же, сколько колонок",
        !!group && group.children.length === cols,
        `${group ? group.children.length : 0} из ${cols}`,
    );
    ok(
        "таблица переведена в фиксированные колонки",
        table.style.tableLayout === "fixed",
        table.style.tableLayout || "(не задано)",
    );
    ok(
        "ширина каждой колонки задана в пикселях",
        !!group && [...group.children].every((c) => /^\d+px$/.test(c.style.width)),
        group ? group.children[0].style.width : "",
    );

    // Повторный проход ничего не переделывает
    const before = table.querySelector("colgroup").children.length;
    win.finkaUi.apply();
    ok(
        "повторный проход не пересобирает colgroup",
        table.querySelectorAll("colgroup").length === 1 &&
            table.querySelector("colgroup").children.length === before,
        `colgroup: ${table.querySelectorAll("colgroup").length}`,
    );

    win.close();
}

/* ── Число замеров всегда совпадает с числом колонок ─────────────── */
// Записать в colgroup меньше значений, чем колонок в таблице, — значит
// перекосить её. Проверяем это на страницах со сложной шапкой.
console.log("\n── Ни одна таблица не перекошена фиксацией ширин");
for (const page of ["rb-svod.html", "plan-fact.html", "pu-ss-almaty.html",
    "rb-svodnaya.html", "pu-grafik-almaty.html"]) {
    const { win } = await load(page);
    const doc = win.document;
    win.Element.prototype.getBoundingClientRect = function () {
        return { width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0 };
    };
    win.finkaUi.apply();

    const span = (tr) =>
        [...tr.cells].reduce(
            (n, c) => n + (parseInt(c.getAttribute("colspan"), 10) || 1),
            0,
        );

    const wrong = [...doc.querySelectorAll("table")]
        .filter((t) => t.querySelector("colgroup") && t.tBodies[0])
        .filter((t) => {
            const cols = Math.max(
                0,
                ...[...t.tBodies].flatMap((b) => [...b.rows]).map(span),
            );
            return t.querySelector("colgroup").children.length !== cols;
        });

    ok(
        page,
        wrong.length === 0,
        wrong.length
            ? `перекошено таблиц: ${wrong.length}`
            : `таблиц зафиксировано: ${doc.querySelectorAll("table colgroup").length}`,
    );
    win.close();
}

/* ── Ставка меняет расчёт, а не только подпись ───────────────────── */
console.log("\n── Изменение ставки пересчитывает штатное расписание");
{
    const { win } = await load("shtatnoe.html");
    const doc = win.document;

    // Порядок полей в строке повторяет порядок колонок без расчётных:
    // должность, ФИО, единицы, по факту, коэффициент, дата, коэф. оклада,
    // должностной оклад — то есть восьмое поле
    const inputs = doc.querySelectorAll("#shBody tr input");
    ok("строка штатного расписания построена", inputs.length > 8, `${inputs.length} полей`);

    const salary = inputs[7];
    salary.value = "176970";
    salary.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(win, 150);

    const opvCell = () => doc.getElementById("shC_0_opv");
    const before = opvCell().textContent;
    ok("ОПВ при ставке 10 % = 17 697", /17\s?697,00/.test(before), before);

    win.finkaRates.set("opv", 20);
    doc.dispatchEvent(new win.CustomEvent("finka:rates", { detail: {} }));
    await tick(win, 200);
    const after = opvCell().textContent;
    ok("ставка 20 % даёт 35 394", /35\s?394,00/.test(after), `${before} → ${after}`);

    win.finkaRates.reset();
    win.close();
}

/* ── Отсутствие бесконечной перерисовки ──────────────────────────── */
console.log("\n── MutationObserver не зацикливается");
{
    const { win } = await load("rb-svodnaya.html");
    const doc = win.document;

    // Сводная общая строит ~500 строк из подгружаемого JSON, и ui-kit потом
    // расставляет значки почти пятистам кнопок. Это разовая волна — даём ей
    // пройти, иначе меряем не зацикливание, а обычную отрисовку.
    await tick(win, 1500);

    let mutations = 0;
    const mo = new win.MutationObserver((recs) => {
        mutations += recs.length;
    });
    mo.observe(doc.body, { childList: true, subtree: true, characterData: true });

    await tick(win, 800);
    mo.disconnect();

    ok(
        "страница перестала перерисовываться в покое",
        mutations < 50,
        `мутаций за 0,8 с: ${mutations}`,
    );
    win.close();
}

/* ── Escape и колесо мыши ────────────────────────────────────────── */
console.log("\n── Escape отменяет правку, колесо не меняет число");
{
    const { win } = await load("rb-svod.html");
    const doc = win.document;
    const inp = doc.querySelector('tbody input[type="number"]');
    const totalText = () => doc.querySelector("tr.sx-total").textContent;

    inp.focus();
    const start = inp.value;
    const before = totalText();
    inp.value = "4321";
    inp.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(win, 250);
    ok("введённое попало в итог", totalText() !== before);

    inp.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(win, 250);
    ok("Escape вернул исходное значение", inp.value === start, JSON.stringify(inp.value));
    ok("и итог пересчитан обратно", totalText() === before);
    ok("поле вышло из фокуса", doc.activeElement !== inp);

    inp.focus();
    inp.dispatchEvent(new win.WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    ok("колесо над полем снимает фокус", doc.activeElement !== inp);
    win.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
