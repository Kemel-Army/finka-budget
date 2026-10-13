/**
 * Локальный сквозной прогон: все страницы в настоящем браузере, без сети.
 *
 *     npm run test:e2e:local
 *
 * В отличие от tests/e2e*.mjs, в боевой Supabase этот прогон НЕ ходит:
 *   • страницы раздаёт свой статический сервер на node прямо из папки
 *     проекта;
 *   • загрузка Supabase SDK (CDN или будущий vendor/supabase*.js)
 *     перехватывается, вместо неё отдаётся заглушка window.supabase с
 *     сессией нужной учётки (роль и филиал — в app_metadata, как их читает
 *     auth.js), а таблица budget.sheets отвечает пустым списком;
 *   • все прочие запросы к *.supabase.co обрываются, внешние CDN (SheetJS,
 *     шрифты) подменяются заглушками.
 *
 * Проверяется: каждая страница (кроме login.html — она отдельно, без
 * сессии) открывается без ошибок в консоли и без необработанных
 * исключений под ролями admin / edit / view и филиалами nao / uralsk.
 * Для Уральска это заодно проверка привязки к филиалу: auth.js сам жмёт
 * кнопку города сразу после входа.
 *
 * Браузер — установленный Edge или Chrome (playwright-core браузеров не
 * качает). Свой путь: E2E_BROWSER=C:\path\to\chrome.exe
 * Только часть страниц: E2E_PAGES=pu-income-pu.html,rb-svod.html
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* ── Учёт результатов ────────────────────────────────────────────── */
let total = 0;
let failed = 0;
const lines = [];

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    lines.push(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(48)} ${extra}`);
}

/* ── Статический сервер ──────────────────────────────────────────── */
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

function startServer() {
    const server = http.createServer((req, res) => {
        let rel;
        try {
            rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
        } catch (e) {
            res.writeHead(400).end();
            return;
        }
        if (rel === "/") rel = "/index.html";
        const file = path.resolve(ROOT, "." + rel);
        // наружу из папки проекта не выпускаем
        if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
            return;
        }
        res.writeHead(200, {
            "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-store",
        });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

/* ── Заглушки внешних библиотек ──────────────────────────────────── */
/* Supabase: только то, чем пользуются auth.js, db-sync.js и login.html.
   Учётка берётся из window.__FINKA_E2E__ (ставится до скриптов страницы).
   Запросы к таблицам отвечают пустым списком: страницы работают на
   пустом localStorage, как у нового пользователя. */
const SUPABASE_STUB = `
(function () {
    function result(data) {
        return { data: data, error: null, count: null, status: 200, statusText: "OK" };
    }
    function query() {
        var q = {};
        [
            "select", "insert", "upsert", "update", "delete", "eq", "neq",
            "gt", "gte", "lt", "lte", "in", "is", "like", "ilike", "match",
            "or", "filter", "order", "limit", "range", "returns",
        ].forEach(function (m) {
            q[m] = function () { return q; };
        });
        q.single = q.maybeSingle = function () {
            return Promise.resolve(result(null));
        };
        q.then = function (ok, bad) {
            return Promise.resolve(result([])).then(ok, bad);
        };
        return q;
    }
    function createClient() {
        var cfg = window.__FINKA_E2E__ || {};
        var session = cfg.user
            ? { access_token: "e2e", token_type: "bearer", user: cfg.user }
            : null;
        var auth = {
            getSession: function () {
                return Promise.resolve({ data: { session: session }, error: null });
            },
            getUser: function () {
                return Promise.resolve({ data: { user: session ? session.user : null }, error: null });
            },
            onAuthStateChange: function (cb) {
                setTimeout(function () {
                    cb("INITIAL_SESSION", session);
                }, 0);
                return { data: { subscription: { unsubscribe: function () {} } } };
            },
            signOut: function () {
                session = null;
                return Promise.resolve({ error: null });
            },
            signInWithPassword: function () {
                return Promise.resolve({
                    data: { session: null, user: null },
                    error: { message: "Invalid login credentials", status: 400 },
                });
            },
            resetPasswordForEmail: function () {
                return Promise.resolve({ data: {}, error: null });
            },
            updateUser: function () {
                return Promise.resolve({ data: { user: session && session.user }, error: null });
            },
        };
        var client = {
            auth: auth,
            from: function () { return query(); },
            rpc: function () { return query(); },
            schema: function () { return client; },
        };
        return client;
    }
    window.supabase = { createClient: createClient };
})();
`;

const XLSX_STUB = `
window.XLSX = {
    utils: {
        book_new: function () { return { SheetNames: [], Sheets: {} }; },
        aoa_to_sheet: function () { return {}; },
        json_to_sheet: function () { return {}; },
        table_to_sheet: function () { return {}; },
        book_append_sheet: function () {},
        sheet_to_json: function () { return []; },
        sheet_to_html: function () { return ""; },
        decode_range: function () { return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }; },
        encode_cell: function () { return "A1"; },
        encode_range: function () { return "A1:A1"; },
    },
    read: function () { return { SheetNames: [], Sheets: {} }; },
    writeFile: function () {},
};
`;

/* ── Браузер ─────────────────────────────────────────────────────── */
async function launch() {
    const tries = [];
    if (process.env.E2E_BROWSER) tries.push({ executablePath: process.env.E2E_BROWSER });
    tries.push({ channel: "msedge" }, { channel: "chrome" });
    for (const p of [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ]) {
        if (fs.existsSync(p)) tries.push({ executablePath: p });
    }
    let last;
    for (const opt of tries) {
        try {
            return await chromium.launch({ headless: true, ...opt });
        } catch (e) {
            last = e;
        }
    }
    throw new Error("не найден Edge/Chrome для playwright-core: " + (last && last.message));
}

/* ── Страница под учёткой ────────────────────────────────────────── */
async function newContext(browser, base, local, account) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const blocked = new Set();

    await ctx.addInitScript((cfg) => {
        window.__FINKA_E2E__ = cfg;
    }, account ? { user: account } : {});

    await ctx.route("**/*", (route) => {
        const url = route.request().url();
        const host = new URL(url).hostname;
        if (/supabase-js|\/vendor\/supabase[^/]*\.js/i.test(url)) {
            return route.fulfill({ contentType: "application/javascript", body: SUPABASE_STUB });
        }
        if (/\.supabase\.co$/i.test(host)) {
            blocked.add(url);
            return route.abort("blockedbyclient");
        }
        if (/\/xlsx[^/]*\.js(\?|$)/i.test(url) && !url.startsWith(base)) {
            return route.fulfill({ contentType: "application/javascript", body: XLSX_STUB });
        }
        if (host === "fonts.googleapis.com") {
            return route.fulfill({ contentType: "text/css", body: "" });
        }
        if (!url.startsWith(base) && !url.startsWith("data:") && !url.startsWith("blob:")) {
            // остальное внешнее — в тесте сети нет
            blocked.add(url);
            return route.abort("blockedbyclient");
        }
        // Свои файлы — с локального сервера (адрес страницы при этом
        // остаётся «боевым», см. BASE ниже)
        const target = local + url.slice(base.length);
        return route.fetch({ url: target }).then(
            (res) => route.fulfill({ response: res }),
            () => route.abort("failed"),
        );
    });

    return { ctx, blocked };
}

/* interact — пройтись по странице как пользователь: нажать по очереди все
   видимые кнопки филиалов (включая консолидацию), вернуться на первую и
   ввести число в первое поле таблицы. Ошибки в switchBranch, расчётах и
   автосохранении всплывают именно здесь, а не при открытии. */
async function interact(page) {
    const btns = page.locator(".branch-btn:visible");
    const n = await btns.count();
    for (let i = 0; i < n; i++) {
        await btns.nth(i).click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(250);
    }
    if (n) await btns.nth(0).click({ timeout: 3000 }).catch(() => {});
    const field = page.locator("table input[type=number]:visible:enabled").first();
    if (await field.count()) {
        await field.fill("123", { timeout: 3000 }).catch(() => {});
        await field.dispatchEvent("input").catch(() => {});
    }
    // автосохранение страниц — через 0,7–1,5 с
    await page.waitForTimeout(1600);
}

async function visit(ctx, blocked, url, waitMs, opts = {}) {
    const page = await ctx.newPage();
    const errors = [];
    const dialogs = [];

    page.on("pageerror", (err) => errors.push("pageerror: " + (err.stack || err.message).split("\n").slice(0, 2).join(" ")));
    page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const loc = msg.location() || {};
        const src = loc.url || "";
        // явно внешнее: запросы, которые оборвал сам тест, и favicon
        if (blocked.has(src) || /favicon\.ico/i.test(src)) return;
        if (/Failed to load resource/i.test(msg.text()) && (blocked.has(src) || /favicon/i.test(src))) return;
        errors.push("console: " + msg.text().slice(0, 200) + (src ? " @ " + src.split("/").pop() + ":" + (loc.lineNumber + 1) : ""));
    });
    page.on("requestfailed", (req) => {
        const u = req.url();
        if (blocked.has(u) || /favicon\.ico/i.test(u)) return;
        const why = (req.failure() && req.failure().errorText) || "";
        // ERR_ABORTED — запрос отменён уходом со страницы (переадресация
        // на вход без сессии и т. п.), это не ошибка ресурса
        if (/ERR_ABORTED/.test(why)) return;
        errors.push("requestfailed: " + u + " " + why);
    });
    page.on("response", (res) => {
        const u = res.url();
        if (res.status() >= 400 && !/favicon\.ico/i.test(u)) errors.push("HTTP " + res.status() + ": " + u);
    });
    page.on("dialog", (d) => {
        dialogs.push(d.type() + ": " + d.message().slice(0, 80));
        d.dismiss().catch(() => {});
    });

    try {
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
        errors.push("goto: " + e.message.split("\n")[0]);
    }
    // auth.js повторно встаёт на свой филиал через 0,8 и 2 с — ждём их
    await page.waitForTimeout(waitMs);
    if (opts.interact) await interact(page);

    const state = await page
        .evaluate(() => ({
            pending: document.documentElement.classList.contains("finka-auth-pending"),
            denied: !!document.querySelector(".finka-denied"),
            path: location.pathname.split("/").pop(),
            active: Array.prototype.map
                .call(document.querySelectorAll(".branch-btn.active"), (b) => {
                    const a = b.getAttribute("data-branch");
                    if (a) return a;
                    const m = /switchBranch\(\s*['"]([^'"]+)/.exec(b.getAttribute("onclick") || "");
                    return m ? m[1] : "";
                })
                .filter(Boolean),
        }))
        .catch((e) => ({ error: e.message }));

    await page.close();
    return { errors, dialogs, state };
}

/* ── Сценарии ────────────────────────────────────────────────────── */
const ALL_PAGES = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html") && f !== "login.html")
    .sort();
const PAGES = process.env.E2E_PAGES
    ? process.env.E2E_PAGES.split(",").map((s) => s.trim()).filter((s) => s && s !== "login.html")
    : ALL_PAGES;

// Ключи ролей и филиалов — как в auth.js (ROLES, BRANCHES)
const ROLES = ["admin", "edit", "view"];
const BRANCHES = ["nao", "uralsk"];

// Страницы-переадресации: куда они должны увести
const REDIRECTS = { "index-budget.html": "index.html" };

// Страницы только для узкого круга (RESTRICTED в auth.js)
function expectDenied(role, branch, page) {
    if (page === "deposit.html") return !(role === "admin" || (role === "limited" && branch === "nao"));
    return false;
}

const server = await startServer();
const LOCAL = `http://127.0.0.1:${server.address().port}/`;
/* Страницы открываются по «боевому» адресу, а отдаёт их локальный сервер
   (перехват в newContext). На localhost login.html и прочие включают
   режим разработки — например, тянут необязательный dev-logins.js,
   которого в git нет, — и прогон проверял бы не то, что видит
   пользователь. */
const BASE = "http://finka-budget.test/";
let browser;
try {
    browser = await launch();
} catch (e) {
    server.close();
    console.log(e.message);
    process.exit(1);
}
console.log(`\nЛокальный e2e: ${BASE} → ${LOCAL} · ${browser.version()} · страниц: ${PAGES.length}`);

/* 1. Вход без сессии */
{
    const { ctx, blocked } = await newContext(browser, BASE, LOCAL, null);
    lines.push("\n── login.html без сессии");
    const r = await visit(ctx, blocked, BASE + "login.html", 800);
    ok("login.html: без ошибок", r.errors.length === 0, r.errors.slice(0, 3).join(" | "));
    ok("login.html: остаётся на странице входа", r.state.path === "login.html", r.state.path || "");

    // Закрытая страница без сессии уводит на вход
    const r2 = await visit(ctx, blocked, BASE + "rb-svod.html", 800);
    ok("rb-svod.html без сессии → login.html", r2.state.path === "login.html", r2.state.path || "");
    ok("rb-svod.html без сессии: без ошибок", r2.errors.length === 0, r2.errors.slice(0, 3).join(" | "));
    await ctx.close();
}

/* 2. Все страницы под ролями и филиалами — комбинации параллельно */
const combos = [];
for (const role of ROLES) for (const branch of BRANCHES) combos.push({ role, branch });

const results = await Promise.all(
    combos.map(async ({ role, branch }) => {
        const account = {
            id: "00000000-0000-0000-0000-0000000000" + String(combos.findIndex((c) => c.role === role && c.branch === branch)).padStart(2, "0"),
            email: `e2e.${role}.${branch}@rfmsh.local`,
            aud: "authenticated",
            role: "authenticated",
            app_metadata: { role, branch, title: "e2e" },
            user_metadata: {},
        };
        const { ctx, blocked } = await newContext(browser, BASE, LOCAL, account);
        const out = [];
        for (const page of PAGES) {
            // Пройтись по кнопкам и полям — под учётками с правом правки
            const r = await visit(ctx, blocked, BASE + page, 2300, { interact: role !== "view" });
            out.push({ page, ...r });
        }
        await ctx.close();
        return { role, branch, out };
    }),
);

for (const { role, branch, out } of results) {
    lines.push(`\n── роль ${role}, филиал ${branch}`);
    for (const { page, errors, dialogs, state } of out) {
        const denied = expectDenied(role, branch, page);
        const problems = [...errors];
        if (state.error) problems.push("evaluate: " + state.error);
        if (state.pending) problems.push("страница так и не показана (finka-auth-pending)");
        const wantPath = REDIRECTS[page] || page;
        if (state.path && state.path !== wantPath) problems.push("ушла на " + state.path);
        if (!!state.denied !== denied) problems.push(denied ? "ждали «нет доступа»" : "показано «нет доступа»");
        // учётку Уральска auth.js ставит на её город
        if (branch === "uralsk" && state.active && state.active.length && !denied) {
            if (state.active.join() !== "uralsk") problems.push("активен филиал: " + state.active.join(","));
        }
        if (dialogs.length) problems.push("диалог: " + dialogs.join(" | "));
        ok(`${role}/${branch} ${page}`, problems.length === 0, problems.slice(0, 3).join(" | ").slice(0, 400));
    }
}

await browser.close();
server.close();

console.log(lines.join("\n"));
console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
process.exit(failed ? 1 : 0);
