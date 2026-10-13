/**
 * «Депозит»: расчёт листа и круг доступа.
 *
 * Лист «Депозит» из «За счет средств Депозита (доход и расход).xlsx» —
 * шаблон без чисел, и его итоги собраны с пропусками (см. deposit-core.js).
 * Поэтому сверяются не числа книги, а правила: итог расходов — все три
 * статьи, стратегические — строки 17, 18, 20, консолидация — сумма
 * филиалов.
 *
 * Доступ: страницу видит только главный бухгалтер ЦА (limited + nao) и
 * администратор, всем остальным — экран «Страница недоступна».
 *
 *     node tests/deposit.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsdomPkg from "jsdom";

const { JSDOM, VirtualConsole } = jsdomPkg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(56)} ${extra}`);
}

function eq(label, got, want) {
    ok(label, got === want, got === want ? String(got) : `${got} ≠ ${want}`);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "deposit-core.js"), "utf8"), ctx);
const D = ctx.DepositCore;

console.log("\n── Один филиал: строки и итоги");
{
    const v = D.compute({
        r9: { d: "1000000" },
        r10: { d: "250000,50" }, // запятая — как вводят в Excel
        r17: { f: 300000, g: 0 },
        r18: { f: 200000, g: 0 },
        r20: { f: 100000, g: 12000 },
        r23: { f: 17300, g: 0 },
        r24: { f: 50000, g: 6000 },
    });
    eq("доход: остатки + депозит", v.r11.d, 1250000.5);
    eq("расход строки = без НДС + НДС", v.r20.d, 112000);
    eq("ФОТ = 17 + 18", v.r16.d, 500000);
    eq("159 = строка 20", v.r19.d, 112000);
    eq("169 = нотариальные + непредвиденные", v.r22.d, 73300);
    eq("итого расход = ФОТ + 159 + 169", v.r30.d, 685300);
    eq("НДС в итоге расхода", v.r30.g, 18000);
    eq("стратегические: 17, 18, 20", v.r30.e, 612000);
    eq("нотариальные не стратегические", v.r23.e, 0);
    eq("в т.ч. стратегические = 16 + 19 (как строка 31 книги)", v.r31.d, 612000);
    eq("остаток = доход − расход", v.r32.d, 564700.5);
    eq("у итога дохода нет колонки НДС", v.r11.g, null);
}

console.log("\n── Пустой лист");
{
    const v = D.compute({});
    eq("итого расход", v.r30.d, 0);
    eq("остаток", v.r32.d, 0);
    eq("мусор во вводе — ноль", D.compute({ r9: { d: "abc" } }).r11.d, 0);
}

console.log("\n── Консолидация");
{
    const all = {
        nao: { r9: { d: 500 }, r24: { f: 100, g: 12 }, r17: { f: 1000 } },
        almaty: { r10: { d: 300 }, r24: { f: 40 } },
        astana: { r24: { f: 30, g: 3.6 } },
        uralsk: { r20: { f: 200 }, r24: { f: 10 } },
    };
    const c = D.consolidate(all);
    eq("доход: сумма филиалов", c.r11.d, 800);
    eq("непредвиденные: сумма филиалов", c.r24.d, 195.6);
    eq("итого расход", c.r30.d, 1395.6);

    const sumOfBranches = D.BRANCHES.reduce(
        (acc, b) => acc + D.compute(all[b]).r30.d,
        0,
    );
    eq("итог консолидации = сумма итогов филиалов", c.r30.d, Math.round(sumOfBranches * 100) / 100);

    const split = D.splitRows(all, "r24");
    eq("разбивка непредвиденных: 4 строки (25–28 книги)", split.length, 4);
    eq("ЦА в разбивке", split[0].value.d, 112);
    eq("Уральск в разбивке", split[3].value.d, 10);
}

console.log("\n── Лимит непредвиденных 10 000 МРП — на НАО целиком");
{
    const limit = 10000 * 4325;
    let l = D.limitCheck({ nao: { r24: { f: limit } } }, 2026);
    eq("лимит 2026 года", l.limit, limit);
    ok("ровно лимит — не превышение", !l.over);
    l = D.limitCheck(
        { nao: { r24: { f: limit / 2 } }, uralsk: { r24: { f: limit / 2 + 1 } } },
        2026,
    );
    ok("ЦА + Уральск вместе превысили лимит", l.over, `${l.used} > ${l.limit}`);
}

/* ── Доступ ───────────────────────────────────────────────────────── */
// Страница целиком в jsdom: auth.js с подставным клиентом Supabase
function inline(html) {
    html = html.replace(/<script src="https?:[^"]+"><\/script>/g, "");
    html = html.replace(/<link rel="stylesheet"[^>]*>/g, "");
    return html.replace(/<script src="([^":]+\.js)"><\/script>/g, (m, src) => {
        const file = path.join(ROOT, src);
        if (!fs.existsSync(file)) return "";
        const code = fs.readFileSync(file, "utf8").split("</script>").join("<\\/script>");
        return "<script>" + code + "</script>";
    });
}

async function open(page, role, branch, seed = {}) {
    const html = inline(fs.readFileSync(path.join(ROOT, page), "utf8"));
    const vc = new VirtualConsole();
    const session = {
        access_token: "t",
        user: { id: `${role}-${branch}`, email: `${role}.${branch}@rfmsh.kz`, app_metadata: { role, branch } },
    };
    const dom = new JSDOM(html, {
        url: "http://localhost/" + page,
        runScripts: "dangerously",
        virtualConsole: vc,
        pretendToBeVisual: true,
        beforeParse(win) {
            win.localStorage.setItem("finka-auth", JSON.stringify(session));
            win.localStorage.setItem("finka_cache_owner", session.user.id);
            Object.entries(seed).forEach(([k, v]) => win.localStorage.setItem(k, v));
            const q = () => {
                const p = Promise.resolve({ data: [], error: null });
                p.select = q; p.eq = q; p.upsert = q; p.delete = q;
                return p;
            };
            win.supabase = {
                createClient: () => ({
                    auth: {
                        getSession: async () => ({ data: { session } }),
                        onAuthStateChange() {},
                        signOut: async () => {},
                    },
                    schema: () => ({ from: () => ({ select: q, upsert: q, delete: q }) }),
                }),
            };
            win.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
        },
    });
    await new Promise((r) => setTimeout(r, 400));
    return dom.window;
}

const denied = (win) => !!win.document.querySelector(".finka-denied");

console.log("\n── Кто открывает страницу «Депозит»");
// Депозит ведут все: ЦА и филиалы, каждый свой лист. Инициатору — нет:
// у него только заявки (главная, сводка, страницы ПУ).
for (const [role, branch, want] of [
    ["limited", "nao", true],
    ["admin", "nao", true],
    ["view", "nao", true],
    ["edit", "nao", true],
    ["limited", "almaty", true],
    ["edit", "astana", true],
    ["view", "uralsk", true],
    ["initiator", "nao", false],
]) {
    const win = await open("deposit.html", role, branch);
    eq(`${role} / ${branch}`, !denied(win), want);
    win.close();
}

console.log("\n── Ссылка на «Депозит» на главной");
for (const [role, branch] of [
    ["limited", "nao"],
    ["edit", "nao"],
    ["limited", "uralsk"],
]) {
    const win = await open("index.html", role, branch);
    const link = win.document.querySelector('a[href="deposit.html"]');
    ok(`карточка видна: ${role} / ${branch}`, !!link && link.style.display !== "none");
    win.close();
}

const out = (d, id, c) => d.querySelector(`[data-out="${id}-${c}"]`)?.textContent.replace(/\s/g, "");
const input = (win, row, col, value) => {
    const inp = win.document.querySelector(`input[data-row="${row}"][data-col="${col}"]`);
    inp.value = value;
    inp.dispatchEvent(new win.Event("input", { bubbles: true }));
};
const sheetOf = (rows) => JSON.stringify({ v: 2, rows });

console.log("\n── Главбух ЦА: свой лист, листы филиалов, консолидация");
{
    const win = await open("deposit.html", "limited", "nao", {
        deposit_nao: sheetOf({ r9: { d: "1000" }, r24: { f: "100" } }),
        deposit_uralsk: sheetOf({ r24: { f: "50", g: "6" } }),
    });
    const d = win.document;

    eq("ЦА: итого доход из сохранённого", out(d, "r11", "d"), "1000,00");
    eq("открытие ничего не пишет", win.localStorage.getItem("deposit_almaty"), null);

    input(win, "r10", "d", "500");
    eq("ввод пересчитывает итог сразу", out(d, "r11", "d"), "1500,00");
    eq("остаток", out(d, "r32", "d"), "1400,00");

    d.querySelector('.branch-btn[data-branch="uralsk"]').click();
    eq("Уральск: свои непредвиденные", out(d, "r24", "d"), "56,00");
    eq("Уральск: свой доход пустой", out(d, "r11", "d"), "0,00");

    d.querySelector('.branch-btn[data-branch="consolidated"]').click();
    eq("консолидация: доход", out(d, "r11", "d"), "1500,00");
    eq("консолидация: непредвиденные", out(d, "r24", "d"), "156,00");
    eq("консолидация без полей ввода", d.querySelectorAll("#depBody input").length, 0);
    eq("разбивка по ЦА и филиалам", d.querySelectorAll("tr.split").length, 4);

    const saved = JSON.parse(win.localStorage.getItem("deposit_nao"));
    eq("ввод ЦА сохранён в свой ключ", saved.rows.r10.d, "500");
    eq("лист Уральска не пересохранён", JSON.parse(win.localStorage.getItem("deposit_uralsk")).v, 2);
    eq("переход по вкладкам без правок не пишет", win.localStorage.getItem("deposit_almaty"), null);
    win.close();
}

console.log("\n── Филиал ведёт свой лист");
{
    const win = await open("deposit.html", "edit", "uralsk");
    await new Promise((r) => setTimeout(r, 300));
    const d = win.document;
    ok("активна кнопка Уральска", d.querySelector('.branch-btn.active')?.dataset.branch === "uralsk");
    input(win, "r9", "d", "777");
    d.querySelector('.branch-btn[data-branch="uralsk"]').click();
    eq("правка Уральска — в deposit_uralsk", JSON.parse(win.localStorage.getItem("deposit_uralsk") || "{}").rows?.r9?.d, "777");
    eq("строку ЦА филиал не трогает", win.localStorage.getItem("deposit_nao"), null);
    win.close();
}

console.log("\n── Первая версия: все города одним ключом в строке ЦА");
{
    const old = JSON.stringify({ v: 1, branches: { nao: { r9: { d: "300" } }, uralsk: { r9: { d: "9" } } } });
    const win = await open("deposit.html", "limited", "nao", { deposit_nao: old });
    eq("свой лист ЦА читается из старого формата", out(win.document, "r11", "d"), "300,00");
    win.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}\n`);
process.exit(failed ? 1 : 0);
