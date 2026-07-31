/**
 * Разнесение «Сводной общей» по страницам.
 *
 * Проверяется главное: числа, попавшие в «Свод расходов», совпадают с тем,
 * что стоит в этом листе у самой книги «Бюджет РБ 2026.xlsx». Формулы там
 * простые ссылки, поэтому расхождение означает, что перенос берёт не ту
 * ячейку — а это ошибка, которую глазами не увидишь.
 *
 *     node tests/derive.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDom } from "./dom-stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const SHEETS = JSON.parse(
    fs.readFileSync(path.join(HERE, "sheets.json"), "utf8"),
);

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(48)} ${extra}`);
}

function eq(label, got, want) {
    total++;
    const r = (n) => Math.round(n * 100) / 100;
    const good = Number.isFinite(got) && Math.abs(r(got) - r(want)) < 0.01;
    if (!good) failed++;
    console.log(
        `   ${good ? "OK  " : "FAIL"} ${String(label).padEnd(48)}` +
            ` ждём ${String(r(want)).padStart(16)}   получили ${String(Number.isFinite(got) ? r(got) : "—").padStart(16)}`,
    );
}

/* ── Песочница: конвертер импорта + модуль разнесения ────────────── */
const { window, document, ensure } = makeDom();
const html = fs.readFileSync(path.join(ROOT, "import-excel.html"), "utf8");
[...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => ensure(m[1]));

const sectionsJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "svodnaya_sections_full.json"), "utf8"),
);

const sandbox = {
    window,
    document,
    localStorage: window.localStorage,
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ json: async () => sectionsJson }),
    parseFloat, parseInt, isNaN, Number, String, Object, Array, JSON, Math,
    Date, Boolean, Promise,
    XLSX: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "budget-rows.js"), "utf8"), sandbox);

const impCode = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("TARGETS"));
vm.runInContext(impCode + "\n;globalThis.__conv = convSvodnaya; globalThis.__raw = convRaw;", sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "derive.js"), "utf8"), sandbox);

const Derive = window.FinkaDerive;

/* ── Импортируем настоящий лист и разносим ───────────────────────── */
console.log("\n── «Сводная общая» → «Свод расходов»");

/* Именно из рабочей книги, а не из книги-заготовки: короткое имя листа в
   фикстурах занимает первая книга по алфавиту, а там вместо сумм единицы */
const SHEET = "Сводная общая 2026г. [Бюджет РБ 2026]";
const rows = SHEETS[SHEET];
if (!rows) {
    console.log(`   нет листа «${SHEET}» — сначала python tests/dump-sheets.py`);
    process.exit(2);
}

const data = await sandbox.__conv(rows);
window.localStorage.setItem("rb_svodnaya_almaty", JSON.stringify(data));

const res = Derive.toSvod("almaty");
ok("разнесение отработало", res.ok, res.reason || "");
ok(
    "все десять строк нашлись",
    res.missing.length === 0,
    res.missing.length ? "не нашлось: " + res.missing.join(", ") : "",
);

/* Значения листа «Свод» из книги «Бюджет РБ 2026.xlsx» — на них
   и должен выйти перенос */
const WANT = {
    C16: 2510052.9100529095,
    C17: 565550.0000000001,
    C18: 531700,
    C19: 49098620.95,
    C20: 61221609.38970273,
    C21: 11100000,
    C22: 85576966,
    C23: 5256583,
    C24: 362880000,
    C25: 144022.5,
};

const svod = JSON.parse(window.localStorage.getItem("rb_svod_almaty"));
Derive.MAP.forEach((m) => {
    eq(`${m.to} · ${m.name.slice(0, 34)}`, Number(svod.cells[m.to]), WANT[m.to]);
});

/* ── Итог ────────────────────────────────────────────────────────── */
console.log("\n── Итог «Свода»");
{
    // Строки 10–15 приходят из «СВОД ФЗП» и переносом не трогаются —
    // подставляем их значения из книги и сверяем общий итог
    const FZP = {
        C10: 1595622564.3607502,
        C11: 182000770.4325,
        C12: 66216816.71776375,
        C13: 136070121.62724182,
        C14: 79993050.06569627,
        C15: 53328700.04379751,
    };
    const cur = JSON.parse(window.localStorage.getItem("rb_svod_almaty"));
    Object.assign(cur.cells, FZP);
    window.localStorage.setItem("rb_svod_almaty", JSON.stringify(cur));

    const again = Derive.toSvod("almaty");
    const after = JSON.parse(window.localStorage.getItem("rb_svod_almaty"));
    eq("Итого = сумма строк 10..25", Number(after.cells.C26), 2692117127.997505);
    ok(
        "повторный перенос ничего не переписал",
        again.moved.length === 0,
        `изменено строк: ${again.moved.length}`,
    );
}

/* ── «Свод» → «Калькуляция» ──────────────────────────────────────── */
console.log("\n── «Свод расходов» → «Калькуляция»");
{
    const kalk = Derive.toKalkulyacia("almaty", { contingent: 1186 });
    ok("разнесение отработало", kalk.ok, kalk.reason || `контингент ${kalk.contingent}`);

    const got = JSON.parse(window.localStorage.getItem("rb_kalkulyacia_almaty"));

    /* Значения листа «Калькуляция 2026» из книги. Обратите внимание на
       строки 12 и 13: в книге подписи ГСМ и медикаментов стоят наоборот
       относительно «Свода», а формулы ссылаются подряд — переносим по
       формулам, поэтому и сверяем по ним. */
    const WANT = {
        C5: 1595622564.3607502, C6: 182000770.4325, C7: 66216816.71776375,
        C8: 136070121.62724182, C9: 79993050.06569627, C10: 53328700.04379751,
        C11: 2510052.9100529095, C12: 565550.0000000001, C13: 531700,
        C14: 49098620.95, C15: 61221609.38970273, C16: 11100000,
        C17: 85576966, C18: 5256583, C19: 362880000, C20: 144022.5,
    };
    Object.keys(WANT).forEach((c) => {
        eq(`Калькуляция ${c}`, Number(got.cells[c]), WANT[c]);
    });

    eq("Итого по году", Number(got.cells.C21), 2692117127.997505);
    eq("На одного в год, оплата труда", Number(got.cells.D5), 1345381.5888370576);
    eq("На одного в месяц, оплата труда", Number(got.cells.E5), 112115.13240308814);
    eq("Итого на одного в год", Number(got.cells.D21), 2269913.261380696);
    eq("Итого на одного в месяц", Number(got.cells.E21), 189159.43844839133);
}

/* ── «СВОД ФЗП» → строки 10–15 «Свода» ───────────────────────────── */
console.log("\n── «СВОД ФЗП» → «Свод расходов», строки 10–15");
{
    // Итог четырнадцатой строки «СВОД ФЗП» из книги
    window.localStorage.setItem(
        "rb_fzp_uralsk",
        JSON.stringify({
            sheet: "rb_fzp",
            branch: "uralsk",
            cells: {
                F14: 1595622564.3607502, G14: 182000770.4325,
                H14: 66216816.71776375, I14: 136070121.62724182,
                J14: 79993050.06569627, K14: 53328700.04379751,
            },
        }),
    );

    const res = Derive.fzpToSvod("uralsk");
    ok("разнесение отработало", res.ok, res.reason || `перенесено строк: ${res.moved.length}`);
    ok("все шесть строк нашлись", res.missing.length === 0, res.missing.join(", "));

    const svod = JSON.parse(window.localStorage.getItem("rb_svod_uralsk"));
    eq("Свод C10 · оплата труда", Number(svod.cells.C10), 1595622564.3607502);
    eq("Свод C13 · социальный налог", Number(svod.cells.C13), 136070121.62724182);
    eq("Свод C15 · медстрахование", Number(svod.cells.C15), 53328700.04379751);

    // Здесь заполнены только строки 10–15, поэтому итог — их сумма
    eq(
        "итог по заполненным строкам",
        Number(svod.cells.C26),
        1595622564.3607502 + 182000770.4325 + 66216816.71776375 +
            136070121.62724182 + 79993050.06569627 + 53328700.04379751,
    );
}

/* ── Вся цепочка разом ───────────────────────────────────────────── */
console.log("\n── Цепочка: ФЗП → Свод → Сводная общая → Калькуляция");
{
    window.localStorage.setItem(
        "rb_fzp_almaty",
        JSON.stringify({
            sheet: "rb_fzp", branch: "almaty",
            cells: {
                F14: 1595622564.3607502, G14: 182000770.4325,
                H14: 66216816.71776375, I14: 136070121.62724182,
                J14: 79993050.06569627, K14: 53328700.04379751,
            },
        }),
    );

    const steps = Derive.chain("almaty", { contingent: 1186 });
    ok("отработали все три звена", steps.length === 3, steps.map((s) => s.target).join(" → "));

    const svod = JSON.parse(window.localStorage.getItem("rb_svod_almaty"));
    eq("Свод: итог совпал с книгой", Number(svod.cells.C26), 2692117127.997505);

    const kalk = JSON.parse(window.localStorage.getItem("rb_kalkulyacia_almaty"));
    eq("Калькуляция: итог совпал с книгой", Number(kalk.cells.C21), 2692117127.997505);
}

/* ── Путь без тарификации: «СВОД ФЗП» импортируется листом ───────── */
/* Страницы «Тарификация» в системе нет, поэтому собрать «СВОД ФЗП» из
   тарификации и штатного расписания нельзя. Но в книге этот лист уже
   посчитан — его импортируют напрямую, и дальше цепочка работает целиком.
   Проверяем именно этот путь, на настоящем листе. */
console.log("\n── «СВОД ФЗП» листом из книги → Свод → Калькуляция");
{
    const fzpRows = SHEETS["СВОД ФЗП [Бюджет РБ 2026]"];
    if (!fzpRows) {
        ok("лист «СВОД ФЗП» есть в фикстурах", false);
    } else {
        // Импорт «сырым» листом — так его и грузят через страницу импорта
        const raw = sandbox.__raw(fzpRows);
        window.localStorage.setItem("rb_fzp_astana", JSON.stringify(raw));

        // Строка 14 — итог по штатному расписанию и тарификации вместе
        eq("ФЗП F14 · оплата труда", Number(raw.cells.F14), 1595622564.3607502);
        eq("ФЗП K14 · медстрахование", Number(raw.cells.K14), 53328700.04379751);

        // Сводную общую этому филиалу тоже подкладываем — иначе половина
        // «Свода» останется пустой
        window.localStorage.setItem("rb_svodnaya_astana", JSON.stringify(data));

        const steps = Derive.chain("astana", { contingent: 1186 });
        ok("цепочка отработала", steps.length === 3, steps.map((s) => s.target).join(" → "));

        const svod = JSON.parse(window.localStorage.getItem("rb_svod_astana"));
        eq("Свод: итог как в книге", Number(svod.cells.C26), 2692117127.997505);

        const kalk = JSON.parse(window.localStorage.getItem("rb_kalkulyacia_astana"));
        eq("Калькуляция: итог как в книге", Number(kalk.cells.C21), 2692117127.997505);
        eq("Калькуляция: на одного в год", Number(kalk.cells.D21), 2269913.261380696);
    }
}

/* ── ФОТ из «Сводной общей», когда «СВОД ФЗП» не загружали ───────── */
/* На страницу «Свод» филиал часто приходит без листа «СВОД ФЗП»: тогда
   строки 10–15 оставались нулями, хотя те же суммы стоят в первом разделе
   «Сводной общей». Проверяем запасной путь на настоящем листе. */
console.log("\n── Раздел «Фонд Оплаты Труда» → «Свод расходов», строки 10–15");
{
    const B = "fottest"; // отдельный ключ: «СВОД ФЗП» тут намеренно не заводим
    window.localStorage.setItem("rb_svodnaya_" + B, JSON.stringify(data));

    const noFzp = Derive.fzpToSvod(B);
    ok("без «СВОД ФЗП» прямой путь отказывается", noFzp.ok === false, noFzp.reason || "");

    const res = Derive.fotFromSvodnaya(B);
    ok("разнесение отработало", res.ok, res.reason || `перенесено строк: ${res.moved.length}`);
    ok("все шесть строк нашлись", res.missing.length === 0, res.missing.join(", "));

    const svod = JSON.parse(window.localStorage.getItem("rb_svod_" + B));
    eq("Свод C10 · оплата труда (ШР + тарификация)", Number(svod.cells.C10), 1595622564.3607502);
    eq("Свод C11 · компенсационные", Number(svod.cells.C11), 182000770.4325);
    eq("Свод C12 · пенсионные взносы", Number(svod.cells.C12), 66216816.71776375);
    eq("Свод C13 · социальный налог", Number(svod.cells.C13), 136070121.62724182);
    eq("Свод C14 · социальные отчисления", Number(svod.cells.C14), 79993050.06569627);
    eq("Свод C15 · медстрахование", Number(svod.cells.C15), 53328700.04379751);

    // Ставка налога (0,035 и подобные) в суммы попасть не должна
    eq(
        "строки 10–15 = итог раздела ФОТ",
        ["C10", "C11", "C12", "C13", "C14", "C15"].reduce(
            (s, c) => s + Number(svod.cells[c]),
            0,
        ),
        2113232023.2477493,
    );

    // Дальше цепочка целиком: ФОТ отсюда, разделы — из «Сводной общей»
    const steps = Derive.chain(B, { contingent: 1186 });
    ok("цепочка отработала без «СВОД ФЗП»", steps.length === 3,
       steps.map((s) => s.target).join(" → "));

    const after = JSON.parse(window.localStorage.getItem("rb_svod_" + B));
    eq("Свод: итог как в книге", Number(after.cells.C26), 2692117127.997505);
}

/* ── Чужие филиалы не задеты ─────────────────────────────────────── */
console.log("\n── Другие филиалы не затронуты");
{
    // Уральск выше использован намеренно — там проверялась связь с «ФЗП»
    // Астана и Уральск использованы выше намеренно
    const others = ["nao"].filter((b) =>
        window.localStorage.getItem("rb_svod_" + b),
    );
    ok(
        "запись только в свой филиал",
        others.length === 0,
        others.length ? "затронуты: " + others.join(", ") : "",
    );

    const empty = Derive.toSvod("nao");
    ok(
        "без «Сводной общей» перенос отказывается",
        empty.ok === false,
        empty.reason || "",
    );
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
