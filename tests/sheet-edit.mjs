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

async function load(file) {
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
        beforeParse: installStubs,
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
        nameCell.textContent = "Оплата труда (изменено)";
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

/* ── Единообразие страниц ────────────────────────────────────────── */
// Раньше КБ носил собственную навигацию и собственные её стили, а страницы
// ПУ получали шапку другой формы, чем страницы РБ. Здесь это закреплено,
// чтобы оформление снова не разъехалось.
console.log("\n── Все страницы бюджета выглядят одинаково");
{
    const CHROME = [...PAGES, "plan-fact-pu.html", "plan-fact-dt.html",
        "plan-fact-pu-dt.html", "plan-finansirovaniya.html", "spravki.html",
        "shtatnoe.html", "osnovaniya.html"];

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
        const back = !!doc.querySelector(".back-link");

        const good = css && navScript && navInjected && ownNav === 0 && back;
        ok(
            page,
            good,
            [
                css ? "" : "нет shared.css",
                navScript ? "" : "нет shared-nav.js",
                navInjected ? "" : "навигация не встроилась",
                ownNav ? `своя <nav>: ${ownNav}` : "",
                back ? "" : "нет ссылки «на главную»",
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

    // Сводная общая строит 641 строку из подгружаемого JSON, и ui-kit потом
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

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
