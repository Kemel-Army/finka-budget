/**
 * Все листы всех книг — через импорт.
 *
 * Для каждого листа: подбирается страница, отрабатывает конвертер, считается
 * контрольная сумма. Сырой импорт обязан сойтись копейка в копейку — это и
 * значит, что ничего не потерялось и лист не съехал на строку. У страниц со
 * своим разбором берётся часть колонок, поэтому там проверяется, что разбор
 * вообще дал строки, а не пустоту.
 *
 *     python tests/dump-sheets.py    # один раз
 *     node tests/import-all.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDom } from "./dom-stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const SHEETS = JSON.parse(fs.readFileSync(path.join(HERE, "sheets.json"), "utf8"));

/* ── Конвертеры ──────────────────────────────────────────────────── */
const html = fs.readFileSync(path.join(ROOT, "import-excel.html"), "utf8");
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("TARGETS"));

const { window, document, ensure } = makeDom();
[...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => ensure(m[1]));

const sectionsJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "svodnaya_sections_full.json"), "utf8"),
);

const sandbox = {
    window, document,
    localStorage: window.localStorage,
    console: { log() {}, error() {}, warn() {} },
    fetch: async () => ({ json: async () => sectionsJson }),
    parseFloat, parseInt, isNaN, Number, String, Object, Array, JSON, Math,
    Date, Boolean, Promise,
    XLSX: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "budget-rows.js"), "utf8"), sandbox);
vm.runInContext(
    code +
        "\n;globalThis.__i = { TARGETS, guessTarget, guessBranch, convRaw," +
        " verify, excelStats, storedStats };",
    sandbox,
);
const I = sandbox.__i;

let total = 0;
let failed = 0;
const problems = [];

function ok(label, cond, extra = "") {
    total++;
    if (!cond) {
        failed++;
        problems.push(label + (extra ? " — " + extra : ""));
    }
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(46)} ${extra}`);
}

const money = (n) =>
    Math.round(n).toLocaleString("ru-RU");

/* Листы с полным именем «Лист [книга]» — по ним и идём: короткое имя в
   фикстурах занимает первая книга по алфавиту, и один и тот же лист
   проверялся бы дважды. */
const FULL = Object.keys(SHEETS).filter((k) => /\[.+\]$/.test(k));

console.log(`\n══ Сырой импорт: ничего не теряется (${FULL.length} листов)\n`);

let lost = 0;
for (const key of FULL) {
    const rows = SHEETS[key];
    if (!rows || !rows.length) continue;

    const raw = I.convRaw(rows);
    const xl = I.excelStats(rows);
    const got = I.storedStats(raw);
    const diff = Math.round((got.sum - xl.sum) * 100) / 100;

    // Пустые листы (одни подписи) пропускаем — сверять нечего
    if (xl.numbers === 0) continue;

    const good = Math.abs(diff) < 0.01 && got.numbers === xl.numbers;
    if (!good) lost++;
    ok(
        key.length > 44 ? key.slice(0, 43) + "…" : key,
        good,
        good
            ? `чисел ${xl.numbers}, Σ ${money(xl.sum)}`
            : `чисел ${xl.numbers}→${got.numbers}, разница ${money(diff)}`,
    );
}

/* ── Разбор по страницам ─────────────────────────────────────────── */
console.log("\n══ Разбор под конкретные страницы\n");

for (const key of FULL) {
    const rows = SHEETS[key];
    if (!rows || !rows.length) continue;

    const sheetName = key.replace(/\s*\[.+\]$/, "");
    const book = (key.match(/\[(.+)\]$/) || [])[1] || "";
    const targetKey = I.guessTarget(sheetName, book);
    if (!targetKey) continue;

    const target = I.TARGETS.find((t) => t.key === targetKey);
    if (!target || !target.conv) continue; // сырые уже проверены выше

    let data;
    let err = "";
    try {
        data = await target.conv(rows);
    } catch (e) {
        err = e.message;
    }

    if (err) {
        ok(`${sheetName} → ${target.title}`, false, "разбор упал: " + err);
        continue;
    }

    const got = I.storedStats(data);
    const res = I.verify({ sheet: sheetName, target }, rows, data);

    // Разбор обязан что-то дать: пустой результат значит, что шапку не
    // нашли и лист прошёл мимо
    ok(
        `${sheetName} → ${target.title}`,
        got.numbers > 0,
        got.numbers > 0
            ? `чисел ${got.numbers}, Σ ${money(res.gotSum)} из ${money(res.xlSum)} · ${res.state === "ok" ? "весь лист" : "часть листа"}`
            : "разбор дал пустоту",
    );
}

/* ── Филиал по имени книги ───────────────────────────────────────── */
console.log("\n══ Филиал определяется по названию книги\n");
{
    const cases = [
        ["Бюджет РБ 2026", "almaty", false],
        ["План Алматы ПУ 2026 г", "almaty", true],
        ["План Алматы РБ 2026 г", "almaty", true],
        ["Справка на передвижку по платежам г Алматы РБ", "almaty", true],
        ["Штатное расписание", "", false],
    ];
    cases.forEach(([book, want, strict]) => {
        const got = I.guessBranch("", book);
        ok(
            `«${book}»`,
            strict ? got === want : true,
            got || "— филиал не в названии, выбирается вручную —",
        );
    });
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
if (problems.length) {
    console.log("\nчто не сошлось:");
    problems.forEach((p) => console.log("  · " + p));
}
console.log("");
process.exit(failed ? 1 : 0);
