/**
 * Юнит-тесты чистых функций.
 *
 * Здесь только то, что можно проверить без страницы: разбор и форматирование
 * чисел, раскладка колонок с объединениями, подписи формул. Расчёты страниц
 * проверяются в tests/run.mjs, поведение в браузере — в tests/e2e.mjs.
 *
 *     node tests/unit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsdomPkg from "jsdom";

const { JSDOM, VirtualConsole } = jsdomPkg;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(50)} ${extra}`);
}

function eq(label, got, want) {
    ok(label, Object.is(got, want), Object.is(got, want) ? "" : `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
}

/* ── Загрузка модуля в чистую страницу ───────────────────────────── */
function load(files, html = "<!doctype html><html><body></body></html>") {
    const dom = new JSDOM(html, {
        runScripts: "dangerously",
        url: "http://localhost/rb-svod.html",
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    for (const f of files) {
        const s = dom.window.document.createElement("script");
        s.textContent = fs.readFileSync(path.join(ROOT, f), "utf8");
        dom.window.document.body.appendChild(s);
    }
    return dom.window;
}

/* ══ Разбор чисел ═════════════════════════════════════════════════ */
console.log("\n══ Разбор чисел: что считается числом, а что нет\n");
{
    const win = load(["ui-kit.js"]);
    const { toNumber, money } = win.finkaUi;
    const NBSP = " ";

    [
        ["1000000", 1000000],
        ["1 000 000", 1000000],
        [`1${NBSP}000${NBSP}000,50`, 1000000.5],
        ["0,33", 0.33],
        ["-5000", -5000],
        ["0", 0],
        [`2${NBSP}000 ₸`, 2000],
    ].forEach(([raw, want]) => {
        eq(`«${raw}» → ${want}`, toNumber(raw), want);
    });

    /* Не числа — их трогать нельзя, иначе на странице появятся нули.
       Проценты сюда же намеренно: если считать «12,5%» числом, ui-kit
       перепишет ячейку в «12,50» и знак процента пропадёт. */
    [
        "", "—", "нет данных", "1.2.3", "abc", "2026-07-30",
        "1 000 000 тг и ещё", "12,5%", "8%",
    ].forEach((raw) => {
        eq(`«${raw}» числом не считается`, toNumber(raw), null);
    });

    // Форматирование
    eq("1000000 → разряды и два знака", money(1000000), `1${NBSP}000${NBSP}000,00`);
    eq("0,3333 округляется до 0,33", money(0.3333), "0,33");
    eq("отрицательное сохраняет знак", money(-1234.5), `-1${NBSP}234,50`);
    eq("ноль", money(0), "0,00");

    win.close();
}

/* ══ Раскладка ключей базы ════════════════════════════════════════ */
console.log("\n══ Ключ localStorage ↔ строка базы\n");
{
    const win = load(["db-sync.js"]);
    const { _split: split, _join: join, _encode: enc, _decode: dec } = win.finkaSync;

    // Обход туда-обратно: любой ключ должен вернуться самим собой
    [
        "rb_svodnaya_almaty",
        "rb_svod_nao",
        "pu_income_pu_astana",
        "plan_fact_pu_dt_uralsk",
        "sheet_edits_rb-svod.html_astana",
        "rb_svodnaya_almaty_full",
        "budget_year",
        "budget_year_end",
    ].forEach((key) => {
        const p = split(key);
        eq(`«${key}» переживает разбор и сборку`, join(p.key, p.branch), key);
    });

    // Значение тоже должно вернуться прежним
    [
        '{"a":1}',
        "[]",
        "2026",
        "true",
        "не json",
        "",
    ].forEach((raw) => {
        const back = dec(enc(raw));
        const same =
            back === raw ||
            (() => {
                try {
                    return JSON.stringify(JSON.parse(back)) === JSON.stringify(JSON.parse(raw));
                } catch (e) {
                    return false;
                }
            })();
        ok(`значение «${raw.slice(0, 20) || "(пусто)"}» не искажается`, same, same ? "" : back);
    });

    win.close();
}

/* ══ Колонки с объединениями ══════════════════════════════════════ */
console.log("\n══ Итоги по колонкам при объединённых ячейках\n");
{
    // Строка с colspan не должна сдвигать суммы вправо
    const html = `<!doctype html><html><body>
      <div class="table-container"><table>
        <thead><tr><th>№</th><th>Статья</th><th>2026</th><th>2027</th></tr></thead>
        <tbody>
          <tr><td class="label-cell">1</td><td class="label-cell">Оплата труда</td>
              <td class="editable"><input type="number" value="100"></td>
              <td class="editable"><input type="number" value="200"></td></tr>
          <tr><td class="label-cell">2</td><td class="label-cell">Налоги</td>
              <td class="editable"><input type="number" value="10"></td>
              <td class="editable"><input type="number" value="20"></td></tr>
          <tr><td colspan="2" class="label-cell">Объединённая подпись</td>
              <td class="editable"><input type="number" value="1"></td>
              <td class="editable"><input type="number" value="2"></td></tr>
        </tbody>
      </table></div></body></html>`;

    const win = load(["sheet-edit.js"], html);
    // sheet-edit стартует сам, даём ему отработать
    await new Promise((r) => win.setTimeout(r, 400));

    const totals = win.document.querySelector("tr.sx-total");
    ok("строка итогов построена", !!totals);
    if (totals) {
        const cells = [...totals.cells].map((c) => c.textContent.trim());
        const NBSP = " ";
        eq("колонка 2026: 100 + 10 + 1", cells[2], "111,00");
        eq("колонка 2027: 200 + 20 + 2", cells[3], "222,00");
        eq("текстовые колонки не суммируются", cells[1], "");
    }
    win.close();
}

/* ══ Подписи формул ═══════════════════════════════════════════════ */
console.log("\n══ Формула объясняется по заголовку колонки\n");
{
    const html = `<!doctype html><html><body>
      <div class="table-container"><table>
        <thead><tr><th>Статья</th><th>ОПВ 10%</th><th>Социальный налог 6%</th>
        <th>Итого на руки</th><th>Всего ФОТ</th><th>Примечание</th></tr></thead>
        <tbody><tr><td class="label-cell">Директор</td>
          <td class="formula-cell">0,00</td><td class="formula-cell">0,00</td>
          <td class="formula-cell">0,00</td><td class="formula-cell">0,00</td>
          <td class="label-cell">—</td></tr></tbody>
      </table></div></body></html>`;

    const win = load(["formulas.js"], html);
    await new Promise((r) => win.setTimeout(r, 400));

    const marked = win.document.querySelectorAll("td.fx");
    ok("расчётные ячейки помечены", marked.length >= 4, `помечено: ${marked.length}`);

    ok(
        "ставки отдаются странице",
        win.finkaRates.get("opv") === 10 && win.finkaRates.get("socTax") === 6,
        `ОПВ ${win.finkaRates.get("opv")} %, соцналог ${win.finkaRates.get("socTax")} %`,
    );

    win.finkaRates.set("opv", 12);
    eq("ставка меняется", win.finkaRates.get("opv"), 12);
    win.finkaRates.reset();
    eq("сброс возвращает типовую", win.finkaRates.get("opv"), 10);

    win.close();
}

/* ══ Состав строк расходов ════════════════════════════════════════ */
console.log("\n══ Типовой состав строк\n");
{
    const win = load(["budget-rows.js"]);
    const R = win.BUDGET_ROWS;

    ok("наборы строк на месте", !!(R.PU && R.DT && R.PLAN_RB && R.SPR_RB && R.SPR_PU));
    eq("ПУ: строк", R.PU.length, 17);
    eq("Дотация: строк", R.DT.length, 5);
    eq("План РБ: строк", R.PLAN_RB.length, 16);

    // Идентификаторы дотации входят в ПУ — на этом держится свод ПУ + ДТ
    const puIds = new Set(R.PU.map((r) => r.id));
    ok(
        "строки дотации есть среди строк ПУ",
        R.DT.every((r) => puIds.has(r.id)),
        R.DT.filter((r) => !puIds.has(r.id)).map((r) => r.id).join(", ") || "все совпали",
    );

    // Идентификаторы внутри набора уникальны, иначе строки затрут друг друга
    const dup = R.PU.map((r) => r.id).filter((v, i, a) => a.indexOf(v) !== i);
    ok("идентификаторы ПУ не повторяются", dup.length === 0, dup.join(", "));

    win.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
