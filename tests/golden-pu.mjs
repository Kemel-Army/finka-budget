/**
 * Сверка страниц ПУ (и калькуляции РБ) с формулами «Бюджет ПУ 2026 (1).xlsx»
 * и «Бюджет РБ 2026 (1).xlsx» — тех страниц, что не покрыты tests/run.mjs.
 *
 *     node tests/golden-pu.mjs
 *
 * Как и tests/run.mjs: во входные поля страницы ставятся те же числа, что
 * стоят во входных ячейках листа, и результат сверяется с вычисленными
 * значениями листа. Отличие — страница целиком работает в jsdom со всеми
 * своими скриптами, а числа вводятся событием input, как их вводит
 * пользователь.
 *
 * В книге заглушки (единицы), поэтому сверяются формулы, а не суммы
 * бюджета. Формулы листов выписаны в комментариях к кейсам (снимались
 * openpyxl с data_only=False).
 *
 * Где у страницы нет строки, которая есть в листе, ожидание = значение
 * листа минус эта строка — так в тесте видно, чего на странице нет.
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

const round2 = (n) => Math.round(n * 100) / 100;

function check(label, got, want) {
    total++;
    const ok = Number.isFinite(got) && Math.abs(round2(got) - round2(want)) < 1e-9;
    if (!ok) failed++;
    console.log(
        `   ${ok ? "OK  " : "FAIL"} ${label.padEnd(54)} ждём ${String(round2(want)).padStart(8)}` +
            `   получили ${String(Number.isFinite(got) ? got : "—").padStart(8)}`,
    );
}

/* ── Страница в jsdom ────────────────────────────────────────────── */
const JS = { headers: { "Content-Type": "application/javascript" } };
const XLSX_STUB = "window.XLSX = { utils: {}, read: () => ({ SheetNames: [], Sheets: {} }), writeFile: () => {} };";

const localFiles = requestInterceptor((request) => {
    const url = request.url;
    if (/^https?:\/\/(cdn|cdnjs|unpkg)/i.test(url)) return new Response(XLSX_STUB, JS);
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    // вход и синхронизация с базой ходят в сеть — в расчёте не участвуют
    if (name === "auth.js" || name === "db-sync.js") return new Response("", JS);
    const p = path.join(ROOT, name);
    return new Response(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "", JS);
});

async function open(file) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), "utf8"), {
        runScripts: "dangerously",
        url: "http://localhost/" + file,
        pretendToBeVisual: true,
        virtualConsole: vc,
        resources: { interceptors: [localFiles] },
        beforeParse(w) {
            w.matchMedia = () => ({
                matches: false, addListener() {}, removeListener() {},
                addEventListener() {}, removeEventListener() {},
            });
        },
    });
    const win = dom.window;
    await new Promise((r) => win.addEventListener("load", r, { once: true }));
    await new Promise((r) => win.setTimeout(r, 100));

    const doc = win.document;
    const field = (sel) => {
        const el = doc.querySelector(sel);
        if (!el) throw new Error(`${file}: нет поля ${sel}`);
        return el;
    };
    return {
        win,
        errors,
        // ввод как у пользователя: значение + событие input
        type(sel, v) {
            const el = field(sel);
            el.value = String(v);
            el.dispatchEvent(new win.Event("input", { bubbles: true }));
        },
        read(id) {
            const el = doc.getElementById(id);
            if (!el) return NaN;
            return parseFloat(
                String(el.textContent).replace(/[\s  ₸]/g, "").replace(",", "."),
            );
        },
        close() {
            win.close();
        },
    };
}

/* ── Лист «СС Алматы» и «СС Дотация» ─────────────────────────────── */
/* Оба листа одинаковы. Формулы:
     D9  = F9                       контингент «всего» = контингент ФЦ
     E10..E18 = D − F               школа = всего − финансовый центр
     D19/E19/F19 = SUM(10:18)       итого ФОТ
     строки 22..32: D и E вводятся отдельно, F пусто
     D34/E34/F34 = SUM(19:33)       всего расходов
   Входные значения листа (заглушки):
     строка: 10  11  12  13  14  15  16  17  18 | 20 21 | 22..32 | 33
     D:      1   —   0   1   1   1   1   1   1  | 0  0  | 1      | 0
     F:      1   —   —   —   1   1   1   1   —  | —  —  | —      | —
   Итоги листа: D19=7 E19=2 F19=5, D34=18 E34=13 F34=5, D9=164 (E9=159, F9=164).

   На страницах ФОТ — шесть строк по специфике: 111 (стр. 10),
   113 (стр. 13), 116 (стр. 17), 121 (стр. 14), 122 (стр. 15), 124 (стр. 16).
   Строк 11 «иностранные специалисты», 12 «доп. выплаты», 18 «аренда
   жилья» и 33 «непредвиденные» на страницах нет. */
const SS_FOT = [
    // [строка листа, D, F]
    [10, 1, 1], // 111
    [13, 1, 0], // 113 — F пусто
    [17, 1, 1], // 116
    [14, 1, 1], // 121
    [15, 1, 1], // 122
    [16, 1, 1], // 124
];
const XL_SS = { D19: 7, E19: 2, F19: 5, D34: 18, E34: 13, F34: 5, D18: 1, E18: 1, F18: 0, D33: 0, E33: 0 };
// строки 20..32 листа → 13 строк товаров и услуг страницы
const SS_GOODS = [
    [20, 0, 0], [21, 0, 0], [22, 1, 1], [23, 1, 1], [24, 1, 1], [25, 1, 1], [26, 1, 1],
    [27, 1, 1], [28, 1, 1], [29, 1, 1], [30, 1, 1], [31, 1, 1], [32, 1, 1],
];

console.log("\n── СС Алматы (pu-ss-almaty.html) ↔ лист «СС Алматы»");
{
    const p = await open("pu-ss-almaty.html");
    // ФОТ: поля D/F строк 10..15 страницы
    SS_FOT.forEach(([, d, f], i) => {
        p.type(`input[data-cell="D${10 + i}"]`, d);
        p.type(`input[data-cell="F${10 + i}"]`, f);
    });
    SS_GOODS.forEach(([, d, e], i) => {
        p.type(`input[data-cell="D${20 + i}"]`, d);
        p.type(`input[data-cell="E${20 + i}"]`, e);
    });
    check("E10 школа = D10 − F10 (111)", p.read("E10"), 0);
    check("E13 школа = D13 − F13, F пусто (113)", p.read("E11"), 1);
    check("D19 итого ФОТ = SUM(D10:D18) без стр. 18", p.read("D16"), XL_SS.D19 - XL_SS.D18);
    check("E19 итого ФОТ (школа) без стр. 18", p.read("E16"), XL_SS.E19 - XL_SS.E18);
    check("F19 итого ФОТ (ФЦ)", p.read("F16"), XL_SS.F19 - XL_SS.F18);
    check("D34 всего = SUM(D19:D33) без стр. 18, 33", p.read("totalD"), XL_SS.D34 - XL_SS.D18 - XL_SS.D33);
    check("E34 всего (школа) без стр. 18, 33", p.read("totalE"), XL_SS.E34 - XL_SS.E18 - XL_SS.E33);
    check("F34 всего (ФЦ)", p.read("totalF"), XL_SS.F34);
    check("ошибок скриптов", p.errors.length, 0);
    p.close();
}

console.log("\n── СС Дотация (pu-ss-dotacia.html) ↔ лист «СС Дотация»");
{
    const p = await open("pu-ss-dotacia.html");
    p.type("#contingent-school", 159); // E9
    p.type("#contingent-fc", 164); // F9
    SS_FOT.forEach(([, d, f], i) => {
        p.type(`#item-${i + 1}-total`, d);
        p.type(`#item-${i + 1}-fc`, f);
    });
    // товары: «всего» и «школа» в листе равны, ФЦ пусто — на странице
    // школа = всего − ФЦ, вводим только «всего»
    SS_GOODS.forEach(([, d], i) => {
        p.type(`#item-${i + 7}-total`, d);
        p.type(`#item-${i + 7}-fc`, 0);
    });
    check("D9 контингент всего = F9", p.read("total-contingent"), 164);
    check("E10 школа = D10 − F10 (111)", p.read("item-1-school"), 0);
    check("E13 школа, F пусто (113)", p.read("item-2-school"), 1);
    check("E22 товары: школа = всего", p.read("item-9-school"), 1);
    check("D19 итого ФОТ без стр. 18", p.read("fot-total"), XL_SS.D19 - XL_SS.D18);
    check("E19 итого ФОТ (школа) без стр. 18", p.read("fot-school"), XL_SS.E19 - XL_SS.E18);
    check("F19 итого ФОТ (ФЦ)", p.read("fot-fc"), XL_SS.F19 - XL_SS.F18);
    check("D34 всего без стр. 18, 33", p.read("grand-total"), XL_SS.D34 - XL_SS.D18 - XL_SS.D33);
    check("E34 всего (школа) без стр. 18, 33", p.read("grand-school"), XL_SS.E34 - XL_SS.E18 - XL_SS.E33);
    check("F34 всего (ФЦ)", p.read("grand-fc"), XL_SS.F34);
    check("ошибок скриптов", p.errors.length, 0);
    p.close();
}

/* ── Лист «ДОХОДНАЯ ЧАСТЬ ДТ», раздел 2 ──────────────────────────── */
/* T8 = F8+…+Q8 (сумма месяцев), то же T9;
   E10 = SUM(E6:E9) — контингент; F10..Q10 = SUM(8:9); T10 = SUM(T8:T9).
   Заглушки: E8 = E9 = 1, месяцы январь–май и сентябрь–декабрь по 1.
   Итоги листа: T8 = T9 = 9, E10 = 2, F10 = 2, K10 = 0, T10 = 18. */
console.log("\n── Доходная часть ДТ (pu-income-dt.html) ↔ «ДОХОДНАЯ ЧАСТЬ ДТ»");
{
    const p = await open("pu-income-dt.html");
    const MONTHS = [1, 2, 3, 4, 5, 9, 10, 11, 12];
    for (const r of [1, 2]) {
        p.type(`#r${r}-cont`, 1);
        for (let m = 1; m <= 12; m++) p.type(`#r${r}-m${m}`, MONTHS.includes(m) ? 1 : 0);
    }
    check("T8 сумма месяцев, 5–9 кл", p.read("r1-total"), 9);
    check("T9 сумма месяцев, 10–11 кл", p.read("r2-total"), 9);
    check("E10 контингент", p.read("total-cont"), 2);
    check("F10 январь", p.read("total-m1"), 2);
    check("K10 июнь (пусто)", p.read("total-m6"), 0);
    check("T10 всего", p.read("grand-total"), 18);
    check("ошибок скриптов", p.errors.length, 0);
    p.close();
}

/* ── Лист «ДОХОДНАЯ ЧАСТЬ доп» ───────────────────────────────────── */
/* R10 = F10+…+Q10, R11 = F11+…+Q11 — суммы месяцев по строке.
   Заглушки: строка 10 — все 12 месяцев по 1 (R10 = 12), строка 11 —
   февраль–декабрь (R11 = 11).
   Строку «Итого» лист считает как F12 = F10, R12 = R10 — только по
   первой строке, без аренды койко-мест. Страница складывает обе строки;
   это расхождение с листом не проверяется — вынесено в отчёт как вопрос. */
console.log("\n── Доходная часть доп (pu-income-dop.html) ↔ «ДОХОДНАЯ ЧАСТЬ доп»");
{
    const p = await open("pu-income-dop.html");
    for (let m = 1; m <= 12; m++) {
        p.type(`#r1-m${m}`, 1);
        p.type(`#r2-m${m}`, m === 1 ? 0 : 1);
    }
    check("R10 сумма месяцев строки 1", p.read("r1-total"), 12);
    check("R11 сумма месяцев строки 2", p.read("r2-total"), 11);
    check("ошибок скриптов", p.errors.length, 0);
    p.close();
}

/* ── «Бюджет РБ 2026 (1).xlsx», лист «Калькуляция 2026» ──────────── */
/* D5 = C5/1186 (на одного учащегося в год), E5 = D5/12 (в месяц), так же
   строки 6..20; C21/D21/E21 = SUM(5:20). В листе C = 1 (заглушка), но
   страница показывает два знака, и 1/1186 видно как 0,00 — поэтому здесь
   те же формулы на входе C = 1186 × 1000 (D = 1000, E = 83,33).
   Строки 5..20 листа = строки C5..C20 страницы один в один. */
console.log("\n── Калькуляция РБ (rb-kalkulyacia.html) ↔ «Калькуляция 2026»");
{
    const p = await open("rb-kalkulyacia.html");
    const C = 1186000;
    for (let r = 5; r <= 20; r++) p.type(`input[data-cell="C${r}"]`, r === 5 ? C : r === 6 ? C * 2 : 0);
    check("D5 = C5 / 1186", p.read("D5"), C / 1186);
    check("E5 = D5 / 12", p.read("E5"), C / 1186 / 12);
    check("D6 = C6 / 1186", p.read("D6"), (2 * C) / 1186);
    check("C21 = SUM(C5:C20)", p.read("totalC"), 3 * C);
    check("D21 = SUM(D5:D20)", p.read("totalD"), (3 * C) / 1186);
    check("E21 = SUM(E5:E20)", p.read("totalE"), (3 * C) / 1186 / 12);
    check("ошибок скриптов", p.errors.length, 0);
    p.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
process.exit(failed ? 1 : 0);
