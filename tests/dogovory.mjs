/**
 * Реестр договоров и форма 4-20.
 *
 * Обе страницы читают план из «Свода расходов» (ячейки C10..C25) и считают
 * остальное формулами, поэтому проверяем именно арифметику: что план
 * подтянулся, что суммы по договорам сложились в специфику, что экономия
 * считается от плана, и что выгрузка 1С разбирается по филиалам.
 *
 * Выгрузка берётся настоящая — excel/12345.xlsx через tests/sheets.json.
 *
 *     node tests/dogovory.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(48)} ${extra}`);
}

function near(label, got, want) {
    total++;
    const good = Number.isFinite(got) && Math.abs(got - want) < 0.01;
    if (!good) failed++;
    console.log(
        `   ${good ? "OK  " : "FAIL"} ${String(label).padEnd(48)}` +
            ` ждём ${String(Math.round(want * 100) / 100).padStart(15)}` +
            `   получили ${String(Number.isFinite(got) ? Math.round(got * 100) / 100 : "—").padStart(15)}`,
    );
}

/* Свод расходов филиала: те же шестнадцать строк, что и в реестре.
   Числа — из книги «Бюджет РБ 2026», как их видит пользователь. */
const SVOD_NAO = {
    C10: "1595622564.36", C11: "182000770.43", C12: "66216816.72",
    C13: "136070121.63", C14: "79993050.07", C15: "53328700.04",
    C16: "2510052.91", C17: "565550", C18: "531700",
    C19: "49098620.95", C20: "61221609.39", C21: "11100000",
    C22: "85576966", C23: "5256583", C24: "362880000", C25: "137782.5",
};

function load(file, seed) {
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), "utf8"), {
        url: "http://localhost/" + file,
        runScripts: "dangerously",
    });
    const { window } = dom;
    // Внешние скрипты (auth.js, db-sync.js, xlsx) jsdom не грузит — сети в
    // тестах нет. Страницам они и не нужны: расчёт свой.
    Object.keys(seed || {}).forEach((k) =>
        window.localStorage.setItem(k, JSON.stringify(seed[k])),
    );
    return window;
}

function fire(window) {
    window.dispatchEvent(new window.Event("load"));
}

/* ── Реестр договоров ────────────────────────────────────────────── */
console.log("\n── Договоры: план из «Свода», суммы по договорам");
{
    const win = load("dogovory.html", {
        rb_svod_nao: { cells: SVOD_NAO },
        // Ровно тот пример, что в «Лист Microsoft Excel.xlsx»:
        // по 149-й специфике два договора
        rb_dogovory_nao: {
            149: [
                { name: "Канцтовары", num: "№3", oblig: 8000000, paid: 4000000 },
                { name: "Мыло-моющие", num: "№4", oblig: 5000000, paid: 3000000 },
            ],
        },
    });
    fire(win);
    const doc = win.document;
    const num = (id) => win.parseNum(doc.getElementById(id).textContent);

    near("план 149 подтянулся из «Свода»", num("plan-149"), 49098620.95);
    near("обязательства = сумма договоров", num("oblig-149"), 13000000);
    near("оплачено = сумма договоров", num("paid-149"), 7000000);
    near("остаток обязательств = 13 − 7 млн", num("rest-149"), 6000000);
    near("экономия = план − обязательства", num("saving-149"), 36098620.95);
    near("у договора свой остаток", num("rest-149-0"), 4000000);
    near("и у второго", num("rest-149-1"), 2000000);

    // Специфика без договоров: экономия равна всему плану
    near("142 без договоров: план", num("plan-142"), 565550);
    near("142 без договоров: экономия = план", num("saving-142"), 565550);

    ok(
        "договорные специфики подсвечены",
        doc.querySelectorAll("tr.spec-contract").length === 8,
        String(doc.querySelectorAll("tr.spec-contract").length),
    );
    ok(
        "видны все шестнадцать специфик",
        doc.querySelectorAll("tr.spec-row").length === 16,
        String(doc.querySelectorAll("tr.spec-row").length),
    );

    near(
        "итог плана = итог «Свода»",
        num("tot-plan"),
        Object.values(SVOD_NAO).reduce((s, v) => s + Number(v), 0),
    );

    // Новый договор считается сразу
    win.addDeal("142");
    doc.getElementById("oblig-142-0").value = "100000";
    doc.getElementById("paid-142-0").value = "40000";
    win.onEdit();
    near("новый договор попал в специфику", num("oblig-142"), 100000);
    near("и уменьшил экономию", num("saving-142"), 465550);
    near("остаток по договору", num("rest-142-0"), 60000);

    // Пустые специфики в базу не уезжают
    win.saveData();
    const saved = JSON.parse(win.localStorage.getItem("rb_dogovory_nao"));
    ok(
        "хранятся только заполненные специфики",
        Object.keys(saved).sort().join(",") === "142,149",
        Object.keys(saved).join(","),
    );

    win.close();
}

/* ── Форма 4-20 ──────────────────────────────────────────────────── */
console.log("\n── Форма 4-20: формулы 9 = 6 − 7, 11 = 4 − 6, 12 = 5 − 7");
{
    // Строка 141 из настоящей выгрузки (excel/12345.xlsx)
    const win = load("forma-4-20.html", {
        rb_svod_nao: { cells: SVOD_NAO },
        rb_forma420_nao: {
            141: {
                planOblig: 2510052.91,
                planPay: 2510052.91,
                taken: 2510052.91,
                paidYear: 339300,
                paidMonth: 0,
            },
        },
    });
    fire(win);
    const doc = win.document;
    const num = (id) => win.parseNum(doc.getElementById(id).textContent);

    near("план на год — из «Свода»", num("planYear-141"), 2510052.91);
    near("неоплаченные = 6 − 7", num("unpaid-141"), 2170752.91);
    near("остаток по обязательствам = 4 − 6", num("restOblig-141"), 0);
    near("остаток по платежам = 5 − 7", num("restPay-141"), 2170752.91);
    ok("строк ровно шестнадцать", doc.querySelectorAll("tbody tr").length === 16);

    win.close();
}

/* ── Разбор выгрузки 1С ──────────────────────────────────────────── */
console.log("\n── Форма 4-20: разбор выгрузки из 1С");
{
    const sheets = JSON.parse(
        fs.readFileSync(path.join(HERE, "sheets.json"), "utf8"),
    );
    const rows = sheets["Лист_1 [12345]"] || sheets["Лист_1"];
    if (!rows) {
        console.log("   нет листа в фикстурах — сначала python tests/dump-sheets.py");
        process.exit(2);
    }

    const win = load("forma-4-20.html", { rb_svod_nao: { cells: SVOD_NAO } });
    fire(win);

    const res = win.parseReport(rows);
    ok("выгрузка разобралась", !res.error, res.error || "");

    if (!res.error) {
        const almaty = res.data.almaty || {};
        ok(
            "нашёлся филиал Алматы",
            Object.keys(almaty).length === 16,
            "специфик: " + Object.keys(almaty).length,
        );

        // Строка «141 - Приобретение продуктов питания» из файла
        const r141 = almaty["141"] || {};
        near("141: план с начала года по обязательствам", r141.planOblig, 2510052.91);
        near("141: план по платежам", r141.planPay, 2510052.91);
        near("141: принятые обязательства", r141.taken, 2510052.91);
        near("141: оплачено с начала года", r141.paidYear, 339300);

        // Формула отчёта должна сойтись с колонкой 9 файла
        near("141: 6 − 7 = колонка 9 файла", r141.taken - r141.paidYear, 2170752.91);

        const r111 = almaty["111"] || {};
        near("111: принятые обязательства", r111.taken, 374223126.5);
        near("111: оплачено с начала года", r111.paidYear, 349858482.23);
        near("111: оплачено на текущий месяц", r111.paidMonth, 122747694.25);
        near("111: 6 − 7 = колонка 9 файла", r111.taken - r111.paidYear, 24364644.27);

        // Блок «ПО ОРГАНИЗАЦИИ» не должен попасть в филиалы: это сумма,
        // её страница считает сама
        ok(
            "в разборе только подразделения",
            Object.keys(res.data).every((b) =>
                ["nao", "almaty", "astana", "uralsk"].includes(b),
            ),
            Object.keys(res.data).join(", "),
        );
    }

    win.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
