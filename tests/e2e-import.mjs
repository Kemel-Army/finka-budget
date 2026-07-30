/**
 * Импорт из Excel «как руками»: настоящий файл, настоящая страница импорта,
 * настоящий выбор филиала.
 *
 * Отвечает на три вопроса, которые нельзя закрыть юнит-тестом:
 *   • не съезжает ли лист на строку (тогда все суммы поедут);
 *   • попадают ли данные ровно в выбранный город и не задевают ли соседей;
 *   • подхватывают ли связанные страницы то, что из «Сводной общей»
 *     должно разноситься по логике исходной книги.
 *
 * Плюс отдельно — есть ли итоговая сумма на каждой странице.
 *
 *     node tests/e2e-import.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = process.env.E2E_BASE || "http://localhost:5173";

const loginsPath = path.join(ROOT, "dev-logins.js");
if (!fs.existsSync(loginsPath)) {
    console.log("нет dev-logins.js — прогон пропущен");
    process.exit(0);
}
const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(loginsPath, "utf8"), sb);
const ACC = {};
for (const g of sb.window.FINKA_DEV_LOGINS || []) {
    for (const a of g.accounts) ACC[a.email] = a.password;
}

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

function near(label, got, want, eps = 0.5) {
    const good = Number.isFinite(got) && Math.abs(got - want) <= eps;
    ok(label, good, `ждём ${want}, получили ${Number.isFinite(got) ? got : "—"}`);
}

const num = (s) =>
    parseFloat(String(s).replace(/[\s ]/g, "").replace(",", ".")) || 0;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 90)));

// База в этом прогоне не участвует: иначе пробные данные уедут в рабочую
await page.route("**/db-sync.js", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
);

await page.goto(`${BASE}/login.html`, { waitUntil: "networkidle" });
await page.fill("#loginEmail", "admin@rfmsh.kz");
await page.fill("#loginPassword", ACC["admin@rfmsh.kz"]);
await page.click("#btnLogin");
await page.waitForURL(/index\.html|\/$/, { timeout: 25000 });

/* ══ 1. Импорт настоящего файла в выбранный город ═════════════════ */
console.log("\n══ Импорт «Бюджет РБ 2026.xlsx» в Алматы\n");

const BOOK = path.join(ROOT, "excel", "Бюджет РБ 2026.xlsx");
if (!fs.existsSync(BOOK)) {
    ok("книга на месте", false, BOOK);
} else {
    await page.goto(`${BASE}/import-excel.html`, { waitUntil: "networkidle" });
    // Чистим только данные бюджета: localStorage.clear() снёс бы и сессию
    // Supabase, и страница ушла бы на вход
    await page.evaluate(() => {
        Object.keys(localStorage)
            .filter((k) => /^(rb_|pu_|fot|kb_|plan_|spravka_|shtat|osnovaniya|sheet_edits_)/.test(k))
            .forEach((k) => localStorage.removeItem(k));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(600);

    await page.setInputFiles("#fileInput", BOOK);
    await page.waitForSelector("#mapBlock:not([hidden])", { timeout: 30000 });
    await page.waitForTimeout(800);

    // Оставляем только «Сводная общая 2026г.» и ставим ей Алматы
    const picked = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#mapBody tr")];
        let chosen = null;
        rows.forEach((tr) => {
            const name = tr.children[1].textContent.trim();
            const on = tr.querySelector(".row-on");
            const target = tr.querySelector(".row-target");
            const branch = tr.querySelector(".row-branch");
            if (name === "Сводная общая 2026г.") {
                on.checked = true;
                target.value = "rb_svodnaya";
                branch.value = "almaty";
                chosen = { name, target: target.value, branch: branch.value };
            } else {
                on.checked = false;
            }
        });
        return chosen;
    });
    ok("лист «Сводная общая 2026г.» найден и назначен", !!picked, JSON.stringify(picked));

    await page.click("#importBtn");
    // Ждём по содержимому, а не по «видимости»: блок мог отрисоваться за
    // пределами окна, и это отдельный вопрос — его проверяем ниже
    await page.waitForFunction(
        () => {
            const b = document.getElementById("resultBlock");
            return b && !b.hidden && /imp-result (ok|warn|bad)/.test(b.className);
        },
        { timeout: 90000 },
    );
    await page.waitForTimeout(1500);

    const visible = await page.evaluate(() => {
        const b = document.getElementById("resultBlock");
        const cs = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return {
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            w: Math.round(r.width),
            h: Math.round(r.height),
        };
    });
    ok(
        "итоговый блок видно на странице",
        visible.display !== "none" &&
            visible.visibility !== "hidden" &&
            visible.w > 0 &&
            visible.h > 0,
        `${visible.display} / ${visible.visibility} / ${visible.w}×${visible.h}`,
    );

    const result = await page.evaluate(() => {
        const box = document.getElementById("resultBlock");
        const rows = [...document.querySelectorAll("#checkBody tr")].map((tr) => ({
            sheet: tr.children[0].textContent.trim(),
            xl: tr.children[5].textContent.trim(),
            got: tr.children[6].textContent.trim(),
            diff: tr.children[7].textContent.trim(),
            verdict: tr.children[8].textContent.trim(),
        }));
        return { cls: box.className, text: box.textContent.replace(/\s+/g, " ").trim().slice(0, 120), rows };
    });

    ok("итог импорта — зелёный", /imp-result ok/.test(result.cls), result.text.slice(0, 70));
    ok("сверка показана", result.rows.length > 0, JSON.stringify(result.rows[0] || {}));

    /* Ключевая проверка на «съехавшую строку»: если лист сдвинут хотя бы на
       строку, разнесённые в «Свод расходов» суммы не совпадут с книгой. */
    const stored = await page.evaluate(() => {
        const keys = Object.keys(localStorage);
        return {
            almaty: keys.filter((k) => k.startsWith("rb_svodnaya_almaty")),
            others: keys.filter((k) =>
                /^rb_svodnaya_(astana|uralsk|nao)$/.test(k),
            ),
            svodAlmaty: localStorage.getItem("rb_svod_almaty"),
            svodOthers: ["astana", "uralsk", "nao"].filter((b) =>
                localStorage.getItem("rb_svod_" + b),
            ),
        };
    });

    ok("данные легли в Алматы", stored.almaty.length > 0, stored.almaty.join(", "));
    ok("соседние города не затронуты", stored.others.length === 0, stored.others.join(", ") || "чисто");
    ok("«Свод расходов» заполнился сам", !!stored.svodAlmaty, stored.svodAlmaty ? "да" : "нет");
    ok("свод только для Алматы", stored.svodOthers.length === 0, stored.svodOthers.join(", ") || "чисто");

    // Значения листа «Свод» из книги — сверяем то, что разнеслось
    const WANT = {
        C16: 2510052.91, C17: 565550, C18: 531700, C19: 49098620.95,
        C20: 61221609.39, C21: 11100000, C22: 85576966, C23: 5256583,
        C24: 362880000, C25: 144022.5,
    };
    const cells = JSON.parse(stored.svodAlmaty || "{}").cells || {};
    Object.keys(WANT).forEach((c) => {
        near(`Свод ${c} совпал с книгой`, Number(cells[c]), WANT[c], 0.5);
    });
}

/* ══ 2. Импортированное видно на странице ═════════════════════════ */
console.log("\n══ Что видно на страницах после импорта\n");
{
    await page.goto(`${BASE}/rb-svod.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);

    const shown = await page.evaluate(async () => {
        const pick = async (branch) => {
            const btn = [...document.querySelectorAll(".branch-btn")].find((b) => {
                const m = /switchBranch\(\s*['"]([^'"]+)/.exec(b.getAttribute("onclick") || "");
                return (b.dataset.branch || (m && m[1])) === branch;
            });
            if (btn) btn.click();
            await new Promise((r) => setTimeout(r, 700));
            const v = (c) => {
                const i = document.querySelector(`input[data-cell="${c}"]`);
                return i ? i.value : "";
            };
            return { C16: v("C16"), C24: v("C24") };
        };
        return { almaty: await pick("almaty"), astana: await pick("astana") };
    });

    near("Свод расходов, Алматы: питьевая вода", num(shown.almaty.C16), 2510052.91, 1);
    near("Свод расходов, Алматы: питание", num(shown.almaty.C24), 362880000, 1);
    ok(
        "Астана осталась пустой",
        num(shown.astana.C16) === 0 && num(shown.astana.C24) === 0,
        `${shown.astana.C16} / ${shown.astana.C24}`,
    );
}

/* ══ 3. Итоговая сумма на каждой странице ═════════════════════════ */
console.log("\n══ Итоговая сумма на страницах\n");
{
    const PAGES = [
        "rb-svod.html", "rb-svodnaya.html", "rb-income.html", "rb-fzp.html",
        "rb-kalkulyacia.html", "rb-plan-komandir.html", "plan-fact.html",
        "fot-almaty.html", "fot-consolidation.html", "income-consolidation.html",
        "kb-svod.html", "pu-svod-2026.html", "pu-ss-almaty.html",
        "pu-ss-dotacia.html", "pu-income-pu.html", "pu-income-dt.html",
        "pu-income-dop.html", "pu-fot-almaty.html", "pu-grafik-almaty.html",
        "pu-kalkulyacia-almaty.html", "pu-plan-rk.html", "pu-plan-abroad.html",
        "plan-fact-pu.html", "plan-fact-dt.html", "plan-fact-pu-dt.html",
        "plan-finansirovaniya.html", "spravki.html", "shtatnoe.html",
    ];

    for (const name of PAGES) {
        await page.goto(`${BASE}/${name}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1500);
        const t = await page.evaluate(() => ({
            own: document.querySelectorAll(
                "tr.total-row, tr.summary-row, tr.grand-total-row, tfoot tr",
            ).length,
            mine: document.querySelectorAll("tr.sx-total").length,
            rows: document.querySelectorAll("tbody tr").length,
        }));
        // «Планы командировок» открываются с пустой таблицей — итожить
        // там нечего, пока не заведена первая поездка
        ok(
            name,
            t.own + t.mine > 0 || t.rows === 0,
            `своя итоговая: ${t.own}, добавленная: ${t.mine}, строк: ${t.rows}`,
        );
    }
}

ok("ошибок в консоли за весь прогон нет", errors.length === 0, errors[0] || "");

await browser.close();

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
if (problems.length) {
    console.log("\nчто не сошлось:");
    problems.forEach((p) => console.log("  · " + p));
}
console.log("");
process.exit(failed ? 1 : 0);
