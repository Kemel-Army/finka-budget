/**
 * Сквозной прогон в настоящем браузере.
 *
 * Проверяет то, чего не видно ни в jsdom, ни в юнит-тестах: реальный вход
 * каждой учётной записью, что кому видно, привязку к филиалу, режим только
 * чтения, расчёты на страницах и консолидацию.
 *
 * Нужен запущенный dev-сервер и локальный dev-logins.js (в git его нет):
 *     pnpm dev
 *     node tests/e2e.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = process.env.E2E_BASE || "http://localhost:5173";

/* ── Учётные записи ──────────────────────────────────────────────── */
const loginsPath = path.join(ROOT, "dev-logins.js");
if (!fs.existsSync(loginsPath)) {
    console.log("нет dev-logins.js — сквозной прогон пропущен");
    process.exit(0);
}
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(loginsPath, "utf8"), sandbox);

const ACCOUNTS = {};
for (const group of sandbox.window.FINKA_DEV_LOGINS || []) {
    for (const a of group.accounts) ACCOUNTS[a.email] = a.password;
}

// Кто есть кто: роль, филиал, ожидаемая подпись роли
const WHO = [
    ["admin@rfmsh.kz", "Администратор", "nao", { edit: true, denied: [] }],
    ["view@rfmsh.kz", "Просмотр", "nao", { edit: false, denied: [] }],
    ["view.ala@rfmsh.kz", "Просмотр", "almaty", { edit: false, denied: [] }],
    ["view.ast@rfmsh.kz", "Просмотр", "astana", { edit: false, denied: [] }],
    ["view.ura@rfmsh.kz", "Просмотр", "uralsk", { edit: false, denied: [] }],
    ["edit@rfmsh.kz", "Работа", "nao", { edit: true, denied: [] }],
    ["edit.ala@rfmsh.kz", "Работа", "almaty", { edit: true, denied: [] }],
    ["edit.ast@rfmsh.kz", "Работа", "astana", { edit: true, denied: [] }],
    ["edit.ura@rfmsh.kz", "Работа", "uralsk", { edit: true, denied: [] }],
    ["lim@rfmsh.kz", "Работа (огранич.)", "nao", { edit: true, denied: ["kb-svod.html"] }],
    ["lim.ala@rfmsh.kz", "Работа (огранич.)", "almaty", { edit: true, denied: ["kb-svod.html"] }],
    ["lim.ast@rfmsh.kz", "Работа (огранич.)", "astana", { edit: true, denied: ["kb-svod.html"] }],
    ["lim.ura@rfmsh.kz", "Работа (огранич.)", "uralsk", { edit: true, denied: ["kb-svod.html"] }],
    ["init@rfmsh.kz", "Инициатор", "nao", { edit: false, denied: ["rb-svod.html", "kb-svod.html"] }],
    ["init.ala@rfmsh.kz", "Инициатор", "almaty", { edit: false, denied: ["rb-svod.html"] }],
    ["init.ast@rfmsh.kz", "Инициатор", "astana", { edit: false, denied: ["rb-svod.html"] }],
    ["init.ura@rfmsh.kz", "Инициатор", "uralsk", { edit: false, denied: ["rb-svod.html"] }],
];

/* ── Учёт результатов ────────────────────────────────────────────── */
let total = 0;
let failed = 0;
const problems = [];

function ok(label, cond, extra = "") {
    total++;
    if (!cond) {
        failed++;
        problems.push(label + (extra ? " — " + extra : ""));
    }
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(52)} ${extra}`);
}

function near(label, got, want, eps = 0.01) {
    const good = Number.isFinite(got) && Math.abs(got - want) <= eps;
    ok(label, good, `ждём ${want}, получили ${Number.isFinite(got) ? got : "—"}`);
}

const num = (s) =>
    parseFloat(String(s).replace(/[\s ]/g, "").replace(",", ".")) || 0;

/* ── Браузер ─────────────────────────────────────────────────────── */
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function freshPage({ noSync = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 90)));
    if (noSync) {
        // Синхронизация перетирает подготовленные данные и перезагружает
        // страницу — для проверки расчётов она мешает
        await page.route("**/db-sync.js", (r) =>
            r.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
        );
    }
    return { ctx, page, errors };
}

async function signIn(page, email) {
    await page.goto(`${BASE}/login.html`, { waitUntil: "networkidle" });
    await page.fill("#loginEmail", email);
    await page.fill("#loginPassword", ACCOUNTS[email]);
    await page.click("#btnLogin");
    await page.waitForURL(/index\.html|\/$/, { timeout: 25000 });
    await page.waitForTimeout(900);
}

/* ══ 1. Вход каждой учётной записью ═══════════════════════════════ */
console.log("\n══ Вход всеми учётными записями\n");

for (const [email, roleLabel, branch, expect] of WHO) {
    const { ctx, page, errors } = await freshPage();
    try {
        await signIn(page, email);

        const badge = await page.evaluate(() => {
            const b = document.querySelector(".finka-user");
            return b
                ? {
                      email: (b.querySelector(".finka-user-email") || {}).textContent || "",
                      role: (b.querySelector(".finka-user-role") || {}).textContent || "",
                  }
                : null;
        });

        const good =
            badge &&
            badge.email.trim() === email &&
            badge.role.indexOf(roleLabel) !== -1;

        ok(
            `${email} · ${roleLabel}`,
            good && errors.length === 0,
            good
                ? errors.length
                    ? "ошибка: " + errors[0]
                    : badge.role.replace(/\s+/g, " ").trim()
                : "бейдж: " + JSON.stringify(badge),
        );
    } catch (e) {
        ok(`${email} · ${roleLabel}`, false, String(e.message).slice(0, 70));
    }
    await ctx.close();
}

/* ══ 2. Привязка к своему городу ══════════════════════════════════ */
console.log("\n══ Каждый город видит только свой\n");

for (const [email, , branch] of WHO.filter((w) => w[2] !== "nao")) {
    const { ctx, page } = await freshPage();
    try {
        await signIn(page, email);
        // «Инициатор» видит только раздел ПУ — проверяем на доступной ему
        // странице, иначе упрёмся в экран «страница недоступна»
        const where = email.startsWith("init")
            ? "pu-income-pu.html"
            : "plan-fact.html";
        await page.goto(`${BASE}/${where}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1500);

        // Часть страниц размечена data-branch, часть зовёт switchBranch()
        // из onclick — учитываем оба вида, иначе проверка ничего не поймает
        const shown = await page.evaluate(() =>
            [...document.querySelectorAll(".branch-btn")]
                .filter((b) => b.offsetParent !== null)
                .map((b) => {
                    if (b.dataset.branch) return b.dataset.branch;
                    const m = /switchBranch\(\s*['"]([^'"]+)/.exec(
                        b.getAttribute("onclick") || "",
                    );
                    return m ? m[1] : "";
                })
                .filter(Boolean),
        );

        ok(
            `${email} видит филиалы`,
            shown.length === 1 && shown[0] === branch,
            shown.join(", ") || "(ни одного)",
        );
    } catch (e) {
        ok(`${email} видит филиалы`, false, String(e.message).slice(0, 60));
    }
    await ctx.close();
}

/* ══ 3. Закрытые страницы и режим просмотра ═══════════════════════ */
console.log("\n══ Закрытые страницы и режим только чтения\n");

for (const [email, roleLabel, , expect] of WHO) {
    if (!expect.denied.length && expect.edit) continue;
    const { ctx, page } = await freshPage();
    try {
        await signIn(page, email);

        for (const denied of expect.denied) {
            await page.goto(`${BASE}/${denied}`, { waitUntil: "networkidle" });
            await page.waitForTimeout(1200);
            const blocked = await page.evaluate(
                () => !!document.querySelector(".finka-denied"),
            );
            ok(`${email}: ${denied} закрыта`, blocked, blocked ? "" : "страница открылась");
        }

        if (!expect.edit) {
            const where = email.startsWith("init")
                ? "pu-income-pu.html"
                : "plan-fact.html";
            await page.goto(`${BASE}/${where}`, { waitUntil: "networkidle" });
            await page.waitForTimeout(2200);
            const ro = await page.evaluate(() => ({
                banner: !!document.querySelector(".finka-ro-banner"),
                enabled: [...document.querySelectorAll("table input")].filter(
                    (i) => !i.disabled && i.type !== "hidden",
                ).length,
            }));
            // Пометки мало: страницы включают поля обратно своими расчётами,
            // и режим просмотра переставал действовать
            ok(
                `${email}: только чтение`,
                ro.banner && ro.enabled === 0,
                ro.banner ? `полей открыто: ${ro.enabled}` : "нет пометки о просмотре",
            );
        }
    } catch (e) {
        ok(`${email}: доступы`, false, String(e.message).slice(0, 60));
    }
    await ctx.close();
}

/* ══ 4. Расчёты на страницах ══════════════════════════════════════ */
console.log("\n══ Расчёты\n");
{
    const { ctx, page, errors } = await freshPage({ noSync: true });
    await signIn(page, "admin@rfmsh.kz");

    /* План-Факт: план с остатками = план + справка, остатки = минус факт */
    await page.goto(`${BASE}/plan-fact.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const pf = await page.evaluate(async () => {
        const set = (col, v) => {
            const i = document.querySelector(
                `input[data-row="111"][data-col="${col}"]`,
            );
            i.value = String(v);
            i.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("plan", 100);
        set("spravka", 20);
        set("fact", 90);
        await new Promise((r) => setTimeout(r, 300));
        const cell = (c) => document.getElementById("cell_111_" + c).textContent;
        return { planOst: cell("planOst"), ostatki: cell("ostatki"), total: document.getElementById("tFact").textContent };
    });
    near("План-Факт: план с остатками = 100 + 20", num(pf.planOst), 120);
    near("План-Факт: остатки = 120 − 90", num(pf.ostatki), 30);
    near("План-Факт: итог по факту", num(pf.total), 90);

    /* Штатное расписание: оклад → ОПВ, соцналог, ФОТ */
    await page.goto(`${BASE}/shtatnoe.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const sh = await page.evaluate(async () => {
        const inputs = document.querySelectorAll("#shBody tr input");
        inputs[7].value = "176970";
        inputs[7].dispatchEvent(new Event("input", { bubbles: true }));
        inputs[8].value = "17697";
        inputs[8].dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 350));
        const c = (k) => document.getElementById("shC_0_" + k).textContent;
        return { fzp: c("fzpMonth"), opv: c("opv"), ipn: c("ipn"), fot: c("fot") };
    });
    near("ШР: ФЗП за месяц = 176 970 + 17 697", num(sh.fzp), 194667);
    near("ШР: ОПВ 10 %", num(sh.opv), 19466.7);
    near("ШР: ИПН", num(sh.ipn), 4155.7, 0.05);
    near("ШР: ВСЕГО ФОТ", num(sh.fot), 3117673.41, 0.5);

    /* План финансирования: год = сумма месяцев */
    await page.goto(`${BASE}/plan-finansirovaniya.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const mp = await page.evaluate(async () => {
        const put = (m, v) => {
            const i = document.querySelector(`#mpBody input[data-idx="0"][data-m="${m}"]`);
            i.value = String(v);
            i.dispatchEvent(new Event("input", { bubbles: true }));
        };
        put(0, 1000);
        put(1, 2000);
        put(2, 3000);
        await new Promise((r) => setTimeout(r, 350));
        return {
            year: document.getElementById("mpYear_0").textContent,
            totalYear: document.getElementById("mpTotYear").textContent,
        };
    });
    near("План: год по строке = 1000 + 2000 + 3000", num(mp.year), 6000);
    near("План: итог по таблице", num(mp.totalYear), 6000);

    ok("расчётные страницы без ошибок", errors.length === 0, errors[0] || "");
    await ctx.close();
}

/* ══ 5. Консолидация ══════════════════════════════════════════════ */
console.log("\n══ Консолидация\n");
{
    const { ctx, page, errors } = await freshPage({ noSync: true });
    await signIn(page, "admin@rfmsh.kz");

    // Алматы и Астана заполнили своё — сводная должна сложить
    await page.goto(`${BASE}/plan-fact-pu-dt.html`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
        const m0 = (plan, fact) => ({ m0: { 111: { finPlan: plan * 10, plan, spravka: 0, fact } } });
        localStorage.setItem("plan_fact_pu_almaty", JSON.stringify(m0(100, 80)));
        localStorage.setItem("plan_fact_dt_almaty", JSON.stringify(m0(40, 30)));
        localStorage.setItem("plan_fact_pu_astana", JSON.stringify(m0(7, 5)));
        localStorage.setItem("plan_fact_dt_astana", JSON.stringify(m0(3, 2)));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);

    const byBranch = await page.evaluate(async () => {
        const pick = async (branch) => {
            const btn = [...document.querySelectorAll("#pfBranches .branch-btn")].find(
                (b) => b.dataset.branch === branch,
            );
            btn.click();
            await new Promise((r) => setTimeout(r, 500));
            return {
                plan: document.getElementById("pfCell_111_plan").textContent,
                fact: document.getElementById("pfCell_111_fact").textContent,
            };
        };
        return {
            almaty: await pick("almaty"),
            astana: await pick("astana"),
            svod: await pick("consolidated"),
        };
    });

    near("свод ПУ+ДТ, Алматы: план 100 + 40", num(byBranch.almaty.plan), 140);
    near("свод ПУ+ДТ, Алматы: факт 80 + 30", num(byBranch.almaty.fact), 110);
    near("свод ПУ+ДТ, Астана: план 7 + 3", num(byBranch.astana.plan), 10);
    near("сводный вид: план всех филиалов", num(byBranch.svod.plan), 150);
    near("сводный вид: факт всех филиалов", num(byBranch.svod.fact), 117);

    ok("страница свода без ошибок", errors.length === 0, errors[0] || "");
    await ctx.close();
}

/* ══ 6. Все страницы: ошибки и вёрстка ════════════════════════════ */
console.log("\n══ Обход всех страниц\n");
{
    const PAGES = [
        "index.html", "kb-svod.html", "rb-svod.html", "rb-svodnaya.html",
        "rb-income.html", "rb-fzp.html", "rb-kalkulyacia.html",
        "rb-plan-komandir.html", "plan-fact.html", "fot-almaty.html",
        "fot-consolidation.html", "income-consolidation.html",
        "pu-svod-2026.html", "pu-ss-almaty.html", "pu-ss-dotacia.html",
        "pu-income-pu.html", "pu-income-dt.html", "pu-income-dop.html",
        "pu-fot-almaty.html", "pu-grafik-almaty.html",
        "pu-kalkulyacia-almaty.html", "pu-plan-rk.html", "pu-plan-abroad.html",
        "plan-fact-pu.html", "plan-fact-dt.html", "plan-fact-pu-dt.html",
        "plan-finansirovaniya.html", "spravki.html", "shtatnoe.html",
        "osnovaniya.html", "import-excel.html", "dashboard.html",
        "business-process.html",
    ];

    const { ctx, page } = await freshPage();
    await signIn(page, "admin@rfmsh.kz");

    for (const name of PAGES) {
        const errs = [];
        page.removeAllListeners("pageerror");
        page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 70)));

        await page.goto(`${BASE}/${name}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1400);

        const look = await page.evaluate(() => {
            const out = { overlap: 0, spill: 0, hidden: false, tables: 0 };
            out.hidden =
                getComputedStyle(document.body).visibility === "hidden";
            document.querySelectorAll("table").forEach((t) => {
                out.tables++;
                const rows = [
                    ...(t.tHead ? t.tHead.rows : []),
                    ...[...t.tBodies].flatMap((b) => [...b.rows]),
                ];
                rows.forEach((tr) => {
                    const cells = [...tr.cells];
                    for (let i = 1; i < cells.length; i++) {
                        const a = cells[i - 1].getBoundingClientRect();
                        const c = cells[i].getBoundingClientRect();
                        if (a.width && c.width && c.left < a.right - 1) out.overlap++;
                    }
                });
            });
            document.querySelectorAll(".uk-shadow").forEach((s) => {
                const td = s.parentNode.getBoundingClientRect();
                const r = s.getBoundingClientRect();
                if (r.right > td.right + 1 || r.left < td.left - 1) out.spill++;
            });
            return out;
        });

        const good =
            errs.length === 0 && look.overlap === 0 && look.spill === 0 && !look.hidden;
        ok(
            name,
            good,
            [
                errs.length ? "ошибка: " + errs[0] : "",
                look.overlap ? `наезды ячеек: ${look.overlap}` : "",
                look.spill ? `подписи вне ячеек: ${look.spill}` : "",
                look.hidden ? "страница скрыта" : "",
                good ? `таблиц: ${look.tables}` : "",
            ]
                .filter(Boolean)
                .join(", "),
        );
    }
    await ctx.close();
}

await browser.close();

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
if (problems.length) {
    console.log("\nчто не сошлось:");
    problems.forEach((p) => console.log("  · " + p));
}
console.log("");
process.exit(failed ? 1 : 0);
