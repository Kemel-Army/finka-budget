/**
 * Проверка расчётов страниц против исходных Excel.
 *
 *     node tests/run.mjs
 *
 * Каждый кейс: подставляем во входные поля страницы те же числа, что стоят
 * в Excel, выполняем расчётный скрипт страницы в песочнице и сверяем
 * результат с вычисленными значениями листа. Эталон — файлы «Бюджет РБ
 * 2026 (1).xlsx» и «Бюджет ПУ 2026 (1).xlsx» в корне проекта.
 *
 * Важно: в этих файлах лежат заглушки (единицы), поэтому сверяются
 * формулы, а не суммы реального бюджета.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDom } from "./dom-stub.mjs";
import { CASES } from "./cases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadPage(file, needle) {
    const html = fs.readFileSync(path.join(ROOT, file), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => m[1],
    );
    const code = scripts.find((s) => s.includes(needle));
    if (!code) throw new Error(`${file}: расчётный скрипт не найден`);
    // id из статической разметки — заглушка сама их не разберёт
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    return { code, ids };
}

function runPage(file, needle, exports, prepare) {
    const { code, ids } = loadPage(file, needle);
    const { window, document, ensure } = makeDom();
    ids.forEach(ensure);

    const sandbox = {
        window,
        document,
        localStorage: window.localStorage,
        console: { log() {}, error() {}, warn() {} },
        setTimeout: () => 0,
        clearTimeout: () => {},
        parseFloat,
        parseInt,
        Array,
        JSON,
        Math,
        Number,
        String,
        Object,
        isNaN,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    ensure("saveStatus");
    ensure("tableBody");

    vm.runInContext(
        code + `\n;globalThis.__api = { ${exports.join(", ")} };`,
        sandbox,
    );

    const api = sandbox.__api;
    prepare(api, ensure, document);
    return { api, document, ensure };
}

let failed = 0;
let total = 0;

for (const c of CASES) {
    console.log(`\n── ${c.title}`);
    console.log(`   Excel: ${c.sheet}`);
    let ctx;
    try {
        ctx = runPage(c.file, c.needle, c.exports, c.prepare);
    } catch (e) {
        console.log(`   ОШИБКА ЗАПУСКА: ${e.message}`);
        failed++;
        continue;
    }

    const read = (id) => {
        const el = ctx.document.getElementById(id);
        if (!el) return NaN;
        const t = String(el.textContent).replace(/\s| /g, "").replace(",", ".");
        return parseFloat(t);
    };

    // Страница показывает два знака после запятой — сверяем на этой же
    // точности, иначе тест придирается к округлению вывода, а не к формуле
    const round2 = (n) => Math.round(n * 100) / 100;

    for (const [label, id, want] of c.checks) {
        total++;
        const got = read(id);
        const ok =
            Number.isFinite(got) && Math.abs(round2(got) - round2(want)) < 1e-9;
        if (!ok) failed++;
        console.log(
            `   ${ok ? "OK  " : "FAIL"} ${label.padEnd(38)} ждём ${String(round2(want)).padStart(12)}   получили ${String(Number.isFinite(got) ? got : "—").padStart(12)}`,
        );
    }
}

console.log(
    `\n${"=".repeat(72)}\nпроверок: ${total}, расхождений: ${failed}\n`,
);
process.exit(failed ? 1 : 0);
