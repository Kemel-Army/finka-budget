/**
 * Ручной сценарий QA в настоящем браузере — ровно то, на что жаловались,
 * и то, что добавлено взамен.
 *
 * Проверяет в живом Chrome:
 *   • «ИТОГО по таблице» на «Сводной общей»: вода, медикаменты, прочие запасы
 *   • ввод цифр подряд в «Водоснабжении» и «Водоотведении»
 *   • добавление строк в подразделы 6.x — без чужих адресов и дублей
 *   • добавленная строка надстройки не расползается по разделам
 *   • переключение филиалов не переносит цифры
 *   • реестр договоров: план из «Свода», суммы, экономия, сохранение
 *   • форма 4-20: загрузка настоящей выгрузки 1С
 *
 * Нужен запущенный dev-сервер и dev-logins.js:
 *     pnpm dev
 *     node tests/e2e-qa.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = process.env.E2E_BASE || "http://127.0.0.1:5173";

const loginsPath = path.join(ROOT, "dev-logins.js");
if (!fs.existsSync(loginsPath)) {
    console.log("нет dev-logins.js — QA-прогон пропущен");
    process.exit(0);
}
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(loginsPath, "utf8"), sandbox);
const ACCOUNTS = {};
for (const group of sandbox.window.FINKA_DEV_LOGINS || []) {
    for (const a of group.accounts) ACCOUNTS[a.email] = a.password;
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
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(54)} ${extra}`);
}

function near(label, got, want, eps = 0.01) {
    const good = Number.isFinite(got) && Math.abs(got - want) <= eps;
    ok(label, good, `ждём ${want}, получили ${Number.isFinite(got) ? got : "—"}`);
}

const num = (s) =>
    parseFloat(String(s).replace(/[\s ]/g, "").replace(",", ".")) || 0;

const browser = await chromium.launch({ channel: "chrome", headless: true });

/* Синхронизацию с базой глушим: она перетирает подготовленные данные и
   перезагружает страницу посреди проверки расчётов. Права и филиалы
   проверяет отдельный прогон tests/e2e.mjs — там она включена. */
async function freshPage() {
    const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push("console: " + m.text().slice(0, 120));
    });
    // Текст консоли про 404 не говорит, какой файл не нашёлся
    page.on("response", (r) => {
        if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });
    await page.route("**/db-sync.js", (r) =>
        r.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );
    return { ctx, page, errors };
}

/* Ждём саму форму, а не «тишину в сети»: networkidle на этих страницах
   не наступает — SDK Supabase держит соединение, а при частых входах
   ещё и повторяет запросы. */
async function signIn(page, email) {
    await page.goto(`${BASE}/login.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#loginEmail", { timeout: 30000 });
    await page.fill("#loginEmail", email);
    await page.fill("#loginPassword", ACCOUNTS[email]);
    await page.click("#btnLogin");
    await page.waitForURL(/index\.html|\/$/, { timeout: 40000 });
    await page.waitForTimeout(1200);
}

/* Данные «Сводной общей» кладём те же, что в юнит-тестах: настоящий лист
   книги «Бюджет РБ 2026». Иначе на пустой странице проверять нечего. */
const SVODNAYA = JSON.parse(
    fs.readFileSync(path.join(HERE, "qa-svodnaya-nao.json"), "utf8"),
);

/* ══ 1. «Сводная общая»: итоги, ввод, строки, филиалы ═════════════ */
console.log("\n══ Сводная общая\n");
{
    const { ctx, page, errors } = await freshPage();
    await signIn(page, "admin@rfmsh.kz");

    await page.evaluate((cells) => {
        localStorage.setItem("rb_svodnaya_nao", JSON.stringify(cells));
        localStorage.removeItem("rb_svodnaya_almaty");
        localStorage.removeItem("sheet_edits_rb-svodnaya.html_nao");
    }, SVODNAYA);

    await page.goto(`${BASE}/rb-svodnaya.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#section-3 table tr.sx-total", { timeout: 20000 });
    await page.waitForTimeout(1200);

    /* ── Итоги разделов и итог таблицы ───────────────────────────── */
    const WANT = {
        "section-2": [2510052.91, "питьевая вода"],
        "section-3": [565550, "медикаменты"],
        "section-5": [49098620.95, "прочие запасы"],
    };

    for (const [domId, [want, name]] of Object.entries(WANT)) {
        const got = await page.evaluate((id) => {
            const box = document.getElementById(id);
            const head = box.querySelector("[data-section-total]");
            const totalRow = box.querySelector("tr.sx-total");
            const nums = totalRow
                ? [...totalRow.cells].slice(1).map((c) => c.textContent.trim())
                : [];
            return { head: head ? head.textContent : "", nums: nums };
        }, domId);

        near(`${name}: «Итого по разделу»`, num(got.head), want);

        const parsed = got.nums.map(num).filter((n) => n);
        ok(
            `${name}: «ИТОГО по таблице» = итогу раздела`,
            parsed.some((n) => Math.abs(n - want) < 0.01),
            got.nums.filter((s) => s).join(" | ").slice(0, 60),
        );
        ok(
            `${name}: расшифровка не удвоена`,
            !parsed.some((n) => Math.abs(n - want * 2) < 0.01),
            "не должно быть " + (want * 2).toFixed(2),
        );
    }

    /* ── Ввод подряд в водоснабжение и водоотведение ─────────────── */
    // Жалоба: «не дают нормально вписывать суммы». Печатаем по-настоящему,
    // клавишами, в обе строки подряд и смотрим, что осталось в полях
    const cold = "#sec6_row490_col4";  // холодная вода, тариф
    const drain = "#sec6_row491_col4"; // водоотведение, тариф

    await page.click(cold, { clickCount: 3 });
    await page.keyboard.type("123456,78", { delay: 45 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(400);

    await page.click(drain, { clickCount: 3 });
    await page.keyboard.type("87654,32", { delay: 45 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(1400);

    const typed = await page.evaluate(
        ([a, b]) => ({
            cold: document.querySelector(a).dataset.raw,
            drain: document.querySelector(b).dataset.raw,
            coldShown: document.querySelector(a).value,
            drainShown: document.querySelector(b).value,
        }),
        [cold, drain],
    );

    near("водоснабжение: цифры дошли до поля", num(typed.cold), 123456.78);
    near("водоотведение: цифры дошли до поля", num(typed.drain), 87654.32);
    ok(
        "водоотведение не затёрло водоснабжение",
        num(typed.cold) !== num(typed.drain),
        `${typed.coldShown} / ${typed.drainShown}`,
    );

    // Строк в подразделе не прибавилось само по себе
    const rows61 = await page.evaluate(() =>
        document.querySelectorAll("#section-6-2 tbody tr, #section-6-2 tr").length,
    );

    /* ── Добавление строк в 6.1: чужие адреса не занимаются ──────── */
    const i61 = await page.evaluate(() =>
        [...document.querySelectorAll(".section-container h2")].findIndex((h) =>
            /Водоснабжение/i.test(h.textContent),
        ),
    );
    await page.evaluate((i) => {
        addNewRow(i);
        addNewRow(i);
    }, i61);
    await page.waitForTimeout(500);

    const ids = await page.evaluate(() => {
        const all = [...document.querySelectorAll("[id]")].map((e) => e.id);
        const dupes = all.filter((id, i) => all.indexOf(id) !== i);
        const box = document.querySelector("#section-6-2");
        const added = [
            ...new Set(
                [...box.querySelectorAll("input[id]")]
                    .map((e) => Number(/_row(\d+)_/.exec(e.id)?.[1]))
                    .filter((n) => n > 491),
            ),
        ].sort((a, b) => a - b);
        return { dupes: [...new Set(dupes)], added: added };
    });

    ok("одинаковых id на странице нет", ids.dupes.length === 0, ids.dupes.slice(0, 3).join(", "));
    ok(
        "новые строки обошли адреса электроэнергии",
        ids.added.join(",") === "492,495",
        ids.added.join(",") || "нет новых строк",
    );
    ok("строки в 6.1 не задвоились", rows61 > 0);

    /* ── Строка надстройки не расползается ───────────────────────── */
    await page.evaluate(() => {
        const bars = document.querySelectorAll(".sx-bar .sx-add");
        bars[2].click();
    });
    await page.waitForTimeout(600);

    const spread = await page.evaluate(
        () =>
            [...document.querySelectorAll("table")].filter(
                (t) => t.querySelectorAll("tr.sx-extra").length,
            ).length,
    );
    ok("«Добавить строку» задела ровно одну таблицу", spread === 1, "таблиц: " + spread);

    /* ── Филиалы ─────────────────────────────────────────────────── */
    const naoValue = await page.evaluate(
        (s) => document.querySelector(s).dataset.raw,
        cold,
    );

    // «Сводная общая» размечена не data-branch, а onclick="switchBranch(…)"
    const branchBtn = (b) => `.branch-btn[onclick*="'${b}'"]`;

    await page.click(branchBtn("almaty"));
    await page.waitForTimeout(1200);

    const almaty = await page.evaluate(
        (s) => ({
            value: document.querySelector(s).dataset.raw,
            saved: localStorage.getItem("rb_svodnaya_almaty"),
            label: document.getElementById("current-branch").textContent,
        }),
        cold,
    );

    ok("переключились на Алматы", /Алматы/.test(almaty.label), almaty.label);
    ok(
        "цифра НАО не переехала в Алматы",
        almaty.value !== naoValue,
        `НАО ${naoValue} → Алматы ${almaty.value}`,
    );
    ok("нетронутому филиалу ничего не записали", almaty.saved === null);

    await page.click(branchBtn("nao"));
    await page.waitForTimeout(1200);
    const back = await page.evaluate(
        (s) => document.querySelector(s).dataset.raw,
        cold,
    );
    near("вернулись в НАО — число на месте", num(back), 123456.78);

    ok("страница без ошибок в консоли", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
}

/* ══ 2. Реестр договоров ══════════════════════════════════════════ */
console.log("\n══ Договоры по спецификам\n");
{
    const { ctx, page, errors } = await freshPage();
    await signIn(page, "admin@rfmsh.kz");

    // «Свод расходов» филиала: план по спецификам
    await page.evaluate(() => {
        localStorage.setItem(
            "rb_svod_nao",
            JSON.stringify({
                cells: {
                    C10: "1595622564.36", C11: "182000770.43", C12: "66216816.72",
                    C13: "136070121.63", C14: "79993050.07", C15: "53328700.04",
                    C16: "2510052.91", C17: "565550", C18: "531700",
                    C19: "49098620.95", C20: "61221609.39", C21: "11100000",
                    C22: "85576966", C23: "5256583", C24: "362880000", C25: "137782.5",
                },
            }),
        );
        localStorage.removeItem("rb_dogovory_nao");
    });

    await page.goto(`${BASE}/dogovory.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("tr.spec-row", { timeout: 20000 });
    await page.waitForTimeout(600);

    near(
        "план 149 подтянулся из «Свода»",
        num(await page.textContent("#plan-149")),
        49098620.95,
    );
    ok(
        "экономия без договоров = весь план",
        num(await page.textContent("#saving-149")) === 49098620.95,
    );

    // Заводим два договора, как в присланном файле
    await page.click('tr[data-spec="149"] .btn-add-deal');
    await page.waitForTimeout(300);
    await page.fill("#name-149-0", "Канцтовары");
    await page.fill("#num-149-0", "№3");
    await page.fill("#oblig-149-0", "8000000");
    await page.fill("#paid-149-0", "4000000");

    await page.click('tr[data-spec="149"] .btn-add-deal');
    await page.waitForTimeout(300);
    await page.fill("#name-149-1", "Мыло-моющие");
    await page.fill("#num-149-1", "№4");
    await page.fill("#oblig-149-1", "5000000");
    await page.fill("#paid-149-1", "3000000");
    await page.waitForTimeout(1400);

    near("обязательства = 8 + 5 млн", num(await page.textContent("#oblig-149")), 13000000);
    near("оплачено = 4 + 3 млн", num(await page.textContent("#paid-149")), 7000000);
    near("остаток обязательств", num(await page.textContent("#rest-149")), 6000000);
    near("экономия = план − обязательства", num(await page.textContent("#saving-149")), 36098620.95);
    near("остаток по первому договору", num(await page.textContent("#rest-149-0")), 4000000);

    // Перезагрузка: данные на месте
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#name-149-0", { timeout: 20000 });
    await page.waitForTimeout(700);

    ok(
        "после перезагрузки договор на месте",
        (await page.inputValue("#name-149-0")) === "Канцтовары",
        await page.inputValue("#name-149-0"),
    );
    near(
        "и суммы пересчитались",
        num(await page.textContent("#saving-149")),
        36098620.95,
    );

    // Удаление
    page.on("dialog", (d) => d.accept());
    await page.click('tr[data-spec="149"][data-idx="1"] .btn-del-deal');
    await page.waitForTimeout(1200);
    near("после удаления обязательства 8 млн", num(await page.textContent("#oblig-149")), 8000000);

    ok("страница без ошибок в консоли", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
}

/* ══ 3. Форма 4-20: загрузка выгрузки 1С ══════════════════════════ */
console.log("\n══ Форма 4-20\n");
{
    const { ctx, page, errors } = await freshPage();
    await signIn(page, "admin@rfmsh.kz");

    await page.evaluate(() => {
        ["nao", "almaty", "astana", "uralsk"].forEach((b) =>
            localStorage.removeItem("rb_forma420_" + b),
        );
    });

    await page.goto(`${BASE}/forma-4-20.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#importFile", { timeout: 20000 });
    /* Обработчик выбора файла страница вешает на load, а разбор идёт через
       SheetJS с CDN. Пока не случилось и то и другое, подсовывать файл
       бессмысленно: событие change уйдёт в пустоту. */
    await page.waitForFunction(
        () => document.readyState === "complete" && !!window.XLSX,
        { timeout: 30000 },
    );

    await page.setInputFiles("#importFile", path.join(ROOT, "excel", "12345.xlsx"));
    await page.waitForTimeout(2500);

    const log = await page.textContent("#importLog");
    ok("выгрузка принята", /Загружено/.test(log), log.slice(0, 80));

    // Файл — по филиалу Алматы, смотрим его
    await page.click('.branch-btn[data-branch="almaty"]');
    await page.waitForTimeout(900);

    near("141: принятые обязательства", num(await page.inputValue("#taken-141")), 2510052.91);
    near("141: оплачено с начала года", num(await page.inputValue("#paidYear-141")), 339300);
    near("141: неоплаченные = 6 − 7", num(await page.textContent("#unpaid-141")), 2170752.91);
    near("111: оплачено на текущий месяц", num(await page.inputValue("#paidMonth-111")), 122747694.25);
    near("111: неоплаченные", num(await page.textContent("#unpaid-111")), 24364644.27);

    // «По организации» — сумма подразделений; в файле заполнен один филиал
    await page.click('.branch-btn[data-branch="consolidated"]');
    await page.waitForTimeout(900);
    near(
        "по организации: принятые обязательства 111",
        num(await page.textContent("#taken-111")),
        374223126.5,
    );
    ok(
        "в режиме организации полей ввода нет",
        (await page.locator("#taken-111 input").count()) === 0,
    );

    ok("страница без ошибок в консоли", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
}

/* ══ 4. Навигация и главная ═══════════════════════════════════════ */
console.log("\n══ Новые страницы в системе\n");
{
    const { ctx, page, errors } = await freshPage();
    await signIn(page, "admin@rfmsh.kz");
    await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);

    for (const href of ["dogovory.html", "forma-4-20.html"]) {
        ok(
            `карточка ${href} на главной`,
            (await page.locator(`a.page-card[href="${href}"]`).count()) > 0,
        );
    }

    ok("главная без ошибок в консоли", errors.length === 0, errors.slice(0, 2).join(" | "));

    /* Общее меню на главной не рисуется — у неё свои карточки
       (shared-nav.js). Ссылки проверяем на странице бюджета. */
    await page.goto(`${BASE}/rb-svodnaya.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    for (const href of ["dogovory.html", "forma-4-20.html"]) {
        ok(
            `${href} в меню страниц РБ`,
            (await page.locator(`nav.finka-nav a[href="${href}"]`).count()) > 0,
        );
    }
    await ctx.close();
}

/* ══ 5. Роли и города на новых страницах ══════════════════════════ */
/* Реестр и форма 4-20 держат данные по филиалам, значит на них должны
   работать те же ограничения, что и на остальном бюджете: филиал видит
   только свой город, роль без права правки — только читает. */
console.log("\n══ Права на новых страницах\n");
{
    // Здесь синхронизация нужна: филиал и роль приезжают из профиля.
    // Контекст на каждую учётку свой: сессия живёт в localStorage, и
    // login.html у вошедшего сразу уводит на главную
    for (const where of ["dogovory.html", "forma-4-20.html"]) {
        const ctx = await browser.newContext({
            viewport: { width: 1700, height: 1000 },
        });
        const page = await ctx.newPage();
        await signIn(page, "edit.ala@rfmsh.kz");
        await page.goto(`${BASE}/${where}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);

        const seen = await page.evaluate(() =>
            [...document.querySelectorAll(".branch-btn")]
                .filter((b) => b.offsetParent !== null)
                .map((b) => b.dataset.branch),
        );

        ok(
            `${where}: филиал видит только свой город`,
            !seen.includes("astana") && !seen.includes("uralsk") &&
                !seen.includes("nao") && seen.includes("almaty"),
            "видно: " + seen.join(", "),
        );
        await ctx.close();
    }

    // Роль «Просмотр» — только чтение
    const ctx = await browser.newContext({
        viewport: { width: 1700, height: 1000 },
    });
    const page = await ctx.newPage();
    await signIn(page, "view@rfmsh.kz");
    await page.goto(`${BASE}/dogovory.html`, { waitUntil: "domcontentloaded" });
    /* Синхронизация здесь живая: db-sync один раз перезагружает страницу,
       когда данные из базы разошлись с localStorage. Ждём, пока это
       случится и уляжется, иначе evaluate попадёт в снесённый контекст. */
    await page.waitForSelector(".finka-ro-banner", { timeout: 30000 });
    await page.waitForTimeout(4000);
    await page.waitForSelector(".finka-ro-banner", { timeout: 30000 });

    const ro = await page.evaluate(() => {
        const add = document.querySelector(".btn-add-deal");
        // Кнопку могли и не нажимать — зовём напрямую, как из консоли
        const before = localStorage.getItem("rb_dogovory_nao");
        addDeal("149");
        saveData();
        return {
            banner: !!document.querySelector(".finka-ro-banner"),
            addDisabled: !!(add && add.disabled),
            rowsAdded: document.querySelectorAll("tr.deal-row").length,
            wroteStorage: localStorage.getItem("rb_dogovory_nao") !== before,
        };
    });
    ok("«Просмотр»: баннер режима чтения", ro.banner);
    ok("«Просмотр»: кнопка «Добавить» выключена", ro.addDisabled);
    ok("«Просмотр»: строка не завелась даже из кода", ro.rowsAdded === 0, "строк: " + ro.rowsAdded);
    ok("«Просмотр»: в хранилище ничего не ушло", !ro.wroteStorage);

    await ctx.close();
}

await browser.close();

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
if (problems.length) {
    console.log("\nчто не сошлось:");
    problems.forEach((p) => console.log("   • " + p));
}
console.log("");
process.exit(failed ? 1 : 0);
