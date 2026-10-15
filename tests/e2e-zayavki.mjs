/**
 * Заявка-потребность целиком, в настоящем браузере и на настоящих
 * миграциях — без боевого Supabase.
 *
 *     node tests/e2e-zayavki.mjs            (SHOTS=папка — сохранить снимки)
 *
 * Запросы страницы к budget.requests / budget.notes заглушка Supabase
 * отправляет на /__db, а там они выполняются в PGlite (tests/sql-local.mjs
 * делает то же самое) от имени учётки: с её JWT-утверждениями, RLS и
 * триггером budget.requests_guard. То есть права проверяются базой, а не
 * заглушкой.
 *
 * Сценарий: инициатор Астаны создаёт заявку и подаёт её (ЭЦП без NCALayer
 * даёт понятную ошибку, затем — отметка без ЭЦП); экономист видит её во
 * входящих, отвечает примечанием и согласует; директор утверждает;
 * инициатор видит статус и ответ. Плюс примечания на листе бюджета.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { supabaseDb } from "./pg-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SHOTS = process.env.SHOTS || "";

let total = 0;
let failed = 0;
function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${label}${!cond && extra ? " — " + extra : ""}`);
}

/* ── База ────────────────────────────────────────────────────────── */
// Роли, auth.uid(), схема storage и все миграции — tests/pg-supabase.mjs
const db = await supabaseDb();

const IDENT = /^[a-z_]+$/;
const TABLES = { requests: 1, notes: 1 };

// Запрос заглушки → SQL. Разрешено ровно то, чем пользуются страницы
function toSql(q) {
    if (!TABLES[q.table]) throw new Error("таблица " + q.table);
    const t = "budget." + q.table;
    const params = [];
    const where = (q.filters || []).map((f) => {
        if (!IDENT.test(f.col)) throw new Error("колонка " + f.col);
        params.push(String(f.val));
        return `${f.col}::text = $${params.length}`;
    });
    const w = where.length ? " where " + where.join(" and ") : "";
    let sql;
    if (q.op === "select") {
        const cols = q.cols === "*" ? "*" : q.cols.split(",").map((c) => {
            if (!IDENT.test(c.trim())) throw new Error("колонка " + c);
            return c.trim();
        }).join(",");
        sql = `select ${cols} from ${t}${w}`;
        if (q.order) {
            if (!IDENT.test(q.order.col)) throw new Error("order");
            sql += ` order by ${q.order.col} ${q.order.asc ? "asc" : "desc"}`;
        }
        if (q.limit) sql += ` limit ${Number(q.limit) | 0}`;
        return { sql, params };
    }
    const cols = Object.keys(q.values || {});
    cols.forEach((c) => {
        if (!IDENT.test(c)) throw new Error("колонка " + c);
    });
    params.push(JSON.stringify(q.values || {}));
    const rec = `jsonb_populate_record(null::${t}, $${params.length}::jsonb)`;
    if (q.op === "insert") {
        sql = `insert into ${t} (${cols.join(",")}) select ${cols.join(",")} from ${rec} returning *`;
    } else if (q.op === "update") {
        sql = `update ${t} set (${cols.join(",")}) = (select ${cols.join(",")} from ${rec})${w} returning *`;
    } else if (q.op === "delete") {
        params.pop();
        sql = `delete from ${t}${w} returning *`;
    } else {
        throw new Error("op " + q.op);
    }
    return { sql, params };
}

async function runAs(user, q) {
    try {
        const { sql, params } = toSql(q);
        const rows = await db.transaction(async (tx) => {
            await tx.exec("set local role authenticated");
            await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user)]);
            return (await tx.query(sql, params)).rows;
        });
        return { data: rows, error: null };
    } catch (e) {
        return { data: null, error: { message: e.message, code: e.code || "" } };
    }
}

/* ── ЭЦП: настоящий обработчик api/ecp-sign.js ───────────────────── */
/* Снаружи подменены только NCALayer (в браузере) и NCANode (ответ «подпись
   верна, ключ SIGN, владелец — тот, кто вошёл»). Supabase для обработчика —
   тот же PGlite с настоящими RLS, триггером и RPC add_ecp_signature. */
const require = createRequire(import.meta.url);
const { handle: ecpHandle } = require(path.join(ROOT, "api", "_lib", "ecp.js"));
const ECP_ENV = { NCANODE_URL: "http://ncanode.test", ECP_SECRET: "e".repeat(48) };
await db.query("insert into budget.ecp_config (id, secret_hash) values (1, sha256(convert_to($1, 'UTF8')))", [ECP_ENV.ECP_SECRET]);

function userOfToken(auth) {
    const m = /^Bearer e2e\.(.+)$/.exec(auth || "");
    return m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null;
}

async function sqlAs(user, sql, params) {
    try {
        const rows = await db.transaction(async (tx) => {
            await tx.exec("set local role authenticated");
            await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user)]);
            return (await tx.query(sql, params)).rows;
        });
        return { ok: true, rows };
    } catch (e) {
        return { ok: false, message: e.message };
    }
}

let ncaVerified = null; // что пришло в «NCANode» последним
function ecpFetch(token) {
    const user = userOfToken("Bearer " + token);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    return async (url, opt = {}) => {
        if (url.endsWith("/auth/v1/user")) {
            return user ? reply(200, { id: user.sub, app_metadata: user.app_metadata }) : reply(401, {});
        }
        if (url.includes("/rest/v1/requests")) {
            const id = decodeURIComponent(url.split("id=eq.")[1] || "");
            const r = await sqlAs(user, "select * from budget.requests where id::text = $1", [id]);
            return r.ok ? reply(200, r.rows) : reply(400, { message: r.message });
        }
        if (url.endsWith("/actuator/health")) return reply(200, { status: "UP" });
        if (url.endsWith("/cms/verify")) {
            ncaVerified = JSON.parse(opt.body);
            const w = String(user.app_metadata.name || "").toUpperCase().split(" ");
            return reply(200, {
                status: 200,
                valid: true,
                signers: [{
                    certificates: [{
                        valid: true,
                        revocations: [{ revoked: false, by: "OCSP" }],
                        keyUsage: "SIGN",
                        serialNumber: "e2e",
                        notBefore: "2026-01-01T00:00:00Z",
                        notAfter: "2027-01-01T00:00:00Z",
                        subject: { commonName: w.slice(0, 2).join(" "), surName: w[2], iin: "880101400123", organization: "НАО «РФМШ»" },
                        issuer: { commonName: "НУЦ РК (тест)" },
                    }],
                    tsp: { genTime: "2026-10-14T10:00:00Z" },
                }],
            });
        }
        if (url.endsWith("/rpc/add_ecp_signature")) {
            const b = JSON.parse(opt.body);
            const r = await sqlAs(user, "select * from budget.add_ecp_signature($1, $2::jsonb, $3)", [b.p_id, JSON.stringify(b.p_entry), b.p_secret]);
            return r.ok ? reply(200, r.rows[0]) : reply(400, { message: r.message });
        }
        return reply(404, {});
    };
}

// NCALayer в браузере: пока window.__NCA_ONLINE не включён — «не запущен»
const NCALAYER_STUB = `
window.NCALayerClient = class {
    static get basicsStorageAll() { return null; }
    static get basicsCMSParamsDetached() { return { encapsulate: false }; }
    static get basicsSignerSignAny() { return { extKeyUsageOids: ["1.3.6.1.5.5.7.3.4"] }; }
    connect() {
        return window.__NCA_ONLINE ? Promise.resolve("1.4") : Promise.reject(new Error("ws closed"));
    }
    basicsSignCMS(storages, data) {
        window.__NCA_DATA = data;
        return Promise.resolve("-----BEGIN CMS-----\\nMIIBZTJlZmFrZQ==\\n-----END CMS-----");
    }
};
`;

/* ── Заглушка Supabase ───────────────────────────────────────────── */
const SUPABASE_STUB = `
(function () {
    function createClient() {
        var cfg = window.__FINKA_E2E__ || {};
        // Токен несёт учётку — по нему /api/ecp-sign узнаёт, кто подписывает
        var session = {
            access_token: "e2e." + btoa(unescape(encodeURIComponent(JSON.stringify(cfg.user)))),
            token_type: "bearer",
            user: cfg.user,
        };
        function query(table) {
            var q = { table: table, op: "select", cols: "*", filters: [] };
            var api = {};
            api.select = function (cols) {
                if (q.op === "select") q.cols = cols || "*";
                q.returning = true;
                return api;
            };
            api.insert = function (v) { q.op = "insert"; q.values = v; return api; };
            api.update = function (v) { q.op = "update"; q.values = v; return api; };
            api.delete = function () { q.op = "delete"; return api; };
            api.eq = function (col, val) { q.filters.push({ col: col, val: val }); return api; };
            api.order = function (col, o) { q.order = { col: col, asc: !o || o.ascending !== false }; return api; };
            api.limit = function (n) { q.limit = n; return api; };
            function run() {
                return fetch("/__db", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ user: cfg.user, q: q }),
                }).then(function (r) { return r.json(); });
            }
            api.single = function () {
                return run().then(function (r) {
                    if (r.error) return r;
                    if (!r.data || !r.data.length) return { data: null, error: { message: "0 rows", code: "PGRST116" } };
                    return { data: r.data[0], error: null };
                });
            };
            api.maybeSingle = function () {
                return run().then(function (r) {
                    return r.error ? r : { data: (r.data || [])[0] || null, error: null };
                });
            };
            api.then = function (a, b) {
                return run().then(function (r) {
                    if (!r.error && q.op !== "select" && !q.returning) r.data = null;
                    return r;
                }).then(a, b);
            };
            // Как PostgrestQueryBuilder: сам from() не «thenable», им
            // становится только запрос после select/insert/update/delete
            return {
                select: function (c) { return api.select(c); },
                insert: function (v) { return api.insert(v); },
                update: function (v) { return api.update(v); },
                delete: function () { return api.delete(); },
            };
        }
        var client = {
            auth: {
                getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
                getUser: function () { return Promise.resolve({ data: { user: session.user }, error: null }); },
                onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
                signOut: function () { return Promise.resolve({ error: null }); },
            },
            from: function (t) {
                // budget.kv листов — пустой список, как у нового пользователя
                if (t !== "requests" && t !== "notes") {
                    var empty = {};
                    var ret = { data: [], error: null };
                    ["select", "eq", "order", "limit", "in", "gt", "upsert", "insert", "update", "delete", "neq", "range"]
                        .forEach(function (m) { empty[m] = function () { return empty; }; });
                    empty.then = function (a, b) { return Promise.resolve(ret).then(a, b); };
                    empty.single = empty.maybeSingle = function () { return Promise.resolve({ data: null, error: null }); };
                    return empty;
                }
                return query(t);
            },
            rpc: function () { return Promise.resolve({ data: null, error: null }); },
            // Storage: объект кладётся в storage.objects от имени учётки — права
            // проверяют настоящие политики миграции 0006; содержимое не хранится
            storage: {
                from: function (bucket) {
                    function call(op, extra) {
                        return fetch("/__db", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ user: cfg.user, storage: Object.assign({ op: op, bucket: bucket }, extra) }),
                        }).then(function (r) { return r.json(); });
                    }
                    return {
                        upload: function (path) { return call("insert", { names: [path] }); },
                        remove: function (paths) { return call("delete", { names: paths }); },
                        createSignedUrl: function (path) {
                            return call("select", { names: [path] }).then(function (r) {
                                if (r.error || !r.data.length) return { data: null, error: r.error || { message: "Object not found" } };
                                return { data: { signedUrl: "about:blank#" + path }, error: null };
                            });
                        },
                    };
                },
            },
            schema: function () { return client; },
        };
        return client;
    }
    window.supabase = { createClient: createClient };
})();
`;

/* ── Сервер и браузер ────────────────────────────────────────────── */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") rel = "/index.html";
    const file = path.resolve(ROOT, "." + rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function launch() {
    const tries = [{ channel: "msedge" }, { channel: "chrome" }];
    if (process.env.E2E_BROWSER) tries.unshift({ executablePath: process.env.E2E_BROWSER });
    let last;
    for (const o of tries) {
        try {
            return await chromium.launch({ headless: true, ...o });
        } catch (e) {
            last = e;
        }
    }
    throw last;
}
const browser = await launch();

let n = 0;
function user(email, meta) {
    n++;
    return { id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, sub: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, email, app_metadata: meta };
}
const INI = user("akimzhanova@rfmsh.kz", { role: "initiator", branch: "astana", name: "Акимжанова Динара Сембаевна", title: "Заместитель директора по учебной работе" });
const ECO = user("edit.ast@rfmsh.kz", { role: "edit", branch: "astana", name: "Экономист Астана" });
const DIR = user("view.ast@rfmsh.kz", { role: "view", branch: "astana", signer: "director", name: "Кенжалин Д.Ж." });

async function open(account, page) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript((cfg) => {
        window.__FINKA_E2E__ = cfg;
    }, { user: account });
    await ctx.route("**/*", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (/supabase-js|\/vendor\/supabase[^/]*\.js/i.test(url.pathname)) {
            return route.fulfill({ contentType: "application/javascript", body: SUPABASE_STUB });
        }
        if (/\/vendor\/ncalayer-client[^/]*\.js$/.test(url.pathname)) {
            return route.fulfill({ contentType: "application/javascript", body: NCALAYER_STUB });
        }
        if (url.pathname === "/api/ecp-sign") {
            const token = String(req.headers().authorization || "").replace(/^Bearer\s+/, "");
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            const out = await ecpHandle({ method: req.method(), token, body }, ECP_ENV, ecpFetch(token));
            return route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.json) });
        }
        if (url.pathname === "/__db") {
            const body = JSON.parse(req.postData() || "{}");
            if (body.storage) {
                const st = body.storage;
                const sql = {
                    insert: "insert into storage.objects (bucket_id, name) select $1, unnest($2::text[]) returning name",
                    delete: "delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name",
                    select: "select name from storage.objects where bucket_id = $1 and name = any($2::text[])",
                }[st.op];
                const r = await sqlAs(body.user, sql, [st.bucket, st.names]);
                const res = r.ok ? { data: r.rows, error: null } : { data: null, error: { message: r.message } };
                return route.fulfill({ contentType: "application/json", body: JSON.stringify(res) });
            }
            const res = await runAs(body.user, body.q);
            return route.fulfill({ contentType: "application/json", body: JSON.stringify(res) });
        }
        if (!req.url().startsWith(BASE)) return route.abort("blockedbyclient");
        return route.continue();
    });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => {
        if (m.type() === "error" && !/WebSocket|13579|ERR_|blockedbyclient|Failed to load resource/i.test(m.text())) {
            errors.push(m.text());
        }
    });
    p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Уточните количество" : undefined));
    await p.goto(BASE + "/" + page);
    await p.waitForTimeout(700);
    return { ctx, p, errors };
}

async function shot(p, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await p.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true });
}

try {
    console.log("\n── Инициатор подаёт заявку ──");
    let s = await open(INI, "zayavki.html");
    ok("в меню нет закрытых разделов (РБ)", (await s.p.locator('.finka-nav-item:has([data-section="rb"])').evaluate((el) => getComputedStyle(el).display)) === "none");
    await s.p.click("#zNew");
    ok("ФИО подставлено из профиля", (await s.p.inputValue('[data-f="fio"]')) === "Акимжанова Динара Сембаевна");
    await s.p.fill('[data-f="initiator"]', "Учебная часть");
    await s.p.selectOption('[data-f="source"]', { index: 3 });
    await s.p.fill('textarea[data-k="name"]', "Бумага офисная А4, 80 г/м²");
    await s.p.fill('input[data-k="unit"]', "пачка");
    await s.p.fill('input[data-k="qty"]', "40");
    await s.p.fill('input[data-k="price"]', "2350");
    await s.p.fill('input[data-k="period"]', "ноябрь 2026");
    await s.p.fill('textarea[data-k="purpose"]', "Печать контрольных работ");
    await s.p.click("#zAddRow");
    await s.p.locator('textarea[data-k="name"]').nth(1).fill("Картридж HP 59A");
    await s.p.locator('input[data-k="unit"]').nth(1).fill("шт");
    await s.p.locator('input[data-k="qty"]').nth(1).fill("2");
    await s.p.locator('input[data-k="price"]').nth(1).fill("41500");
    await s.p.locator('textarea[data-k="purpose"]').nth(1).fill("Замена в учебной части");
    ok("итог считается", (await s.p.textContent("#zTotal")).replace(/\s/g, "") === "177000,00");

    // Маршрут: этой заявке АХР и закупки не нужны — снимаем
    ok("маршрут по умолчанию — АХР, закупки, экономист", (await s.p.locator("[data-route]:checked").count()) === 2);
    await s.p.uncheck('[data-route="ahr"]');
    await s.p.uncheck('[data-route="zakup"]');
    ok("АХР и закупки сняты", (await s.p.locator(".z-step.off").count()) === 2);

    // Вложение: заявка сохраняется сама, файл ложится в её папку
    await s.p.setInputFiles("#zFileInput", { name: "КП_картриджи.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
    await s.p.waitForTimeout(1200);
    ok("файл приложен", /КП_картриджи\.pdf/.test(await s.p.textContent(".z-files")), await s.p.textContent("#zDocMsg"));
    await s.p.setInputFiles("#zFileInput", { name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await s.p.waitForTimeout(300);
    ok("exe не принимается", /Не подходит/.test(await s.p.textContent("#zDocMsg")));

    await s.p.click('[data-sign="initiator"][data-kind="ecp"]');
    await s.p.waitForTimeout(1200);
    const msg = (await s.p.textContent("#zDocMsg")) || "";
    ok("без NCALayer — понятная ошибка", /NCALayer/.test(msg), msg);
    await shot(s.p, "1-initiator-form");

    // NCALayer «запущен»: подпись → /api/ecp-sign → NCANode → RPC в базе
    await s.p.evaluate(() => {
        window.__NCA_ONLINE = true;
    });
    await s.p.click('[data-sign="initiator"][data-kind="ecp"]');
    await s.p.waitForTimeout(1500);
    ok("подана — «На согласовании»", /На согласовании/.test(await s.p.textContent("#zDocBar")), await s.p.textContent("#zDocMsg"));
    const paper = await s.p.textContent("#zPaper");
    ok("штамп ЭЦП, проверено, ФИО и ИИН из сертификата",
        /Подписано ЭЦП · проверено НУЦ/.test(paper) && /АКИМЖАНОВА ДИНАРА СЕМБАЕВНА/.test(paper) && /880101400123/.test(paper));
    const signedB64 = await s.p.evaluate(() => window.__NCA_DATA);
    ok("NCALayer и NCANode получили один и тот же текст заявки", !!ncaVerified && ncaVerified.data === signedB64);
    ok("NCALayer подписывал JSON заявки", /Заявка-потребность/.test(Buffer.from(signedB64 || "", "base64").toString("utf8")));
    ok("форма больше не редактируется", (await s.p.locator('#zPaper textarea[data-k="name"]').count()) === 0);
    await shot(s.p, "2-initiator-submitted");
    ok("ошибок в консоли нет", !s.errors.length, s.errors.join(" | "));
    await s.ctx.close();

    console.log("\n── Экономист согласует ──");
    s = await open(ECO, "zayavki.html");
    ok("открылись входящие с меткой", (await s.p.textContent("#zInboxBadge")) === "1");
    await shot(s.p, "3-economist-inbox");
    await s.p.click("#zRows tr");
    await s.p.waitForTimeout(500);
    await s.p.fill("#zNotes textarea", "Приложите коммерческое предложение по картриджам");
    await s.p.click("#zNotes button[type=submit]");
    await s.p.waitForTimeout(500);
    ok("примечание к заявке сохранено", /коммерческое предложение/.test(await s.p.textContent("#zNotes")));
    ok("графу АХР экономист подписать не может", (await s.p.locator('[data-sign="ahr"]').count()) === 0);
    ok("исключённые графы помечены", (await s.p.locator("text=исключено из маршрута").count()) === 2);
    ok("экономист видит приложенный файл", /КП_картриджи\.pdf/.test(await s.p.textContent(".z-files")));
    await s.p.click('[data-sign="economist"][data-kind="simple"]');
    await s.p.waitForTimeout(700);
    ok("экономист подписал", (await s.p.locator(".z-stamp").count()) === 2);
    ok("ошибок в консоли нет", !s.errors.length, s.errors.join(" | "));
    await s.ctx.close();

    console.log("\n── Директор утверждает ──");
    s = await open(DIR, "zayavki.html");
    ok("кнопки «Новая заявка» у директора нет", !(await s.p.isVisible("#zNew")));
    await s.p.click("#zRows tr");
    await s.p.waitForTimeout(500);
    await s.p.click('[data-sign="director"][data-kind="simple"]');
    await s.p.waitForTimeout(700);
    ok("утверждена", /Утверждена/.test(await s.p.textContent("#zDocBar")));
    await shot(s.p, "4-director-approved");
    ok("ошибок в консоли нет", !s.errors.length, s.errors.join(" | "));
    await s.ctx.close();

    console.log("\n── Папка экономиста ──");
    s = await open(ECO, "zayavki.html");
    await s.p.click('.z-tab[data-tab="approved"]');
    ok("в «Утверждённых» — заявка", (await s.p.locator("#zRows tr").count()) === 1);
    const [dl] = await Promise.all([s.p.waitForEvent("download", { timeout: 5000 }), s.p.click("#zExport")]);
    ok("реестр выгружается в Excel", /Заявки_утверждённые_.*\.xlsx$/.test(dl.suggestedFilename()));
    ok("ошибок в консоли нет", !s.errors.length, s.errors.join(" | "));
    await s.ctx.close();

    console.log("\n── Полный маршрут: строго по порядку ──");
    s = await open(INI, "zayavki.html");
    await s.p.click("#zNew");
    await s.p.fill('textarea[data-k="name"]', "Стулья ученические");
    await s.p.fill('input[data-k="unit"]', "шт");
    await s.p.fill('input[data-k="qty"]', "30");
    await s.p.fill('input[data-k="price"]', "18000");
    await s.p.fill('textarea[data-k="purpose"]', "Замена в кабинете физики");
    await s.p.selectOption('[data-f="kind"]', "correction");
    await s.p.selectOption('[data-f="spec"]', "414");
    await s.p.click('[data-sign="initiator"][data-kind="simple"]');
    await s.p.waitForTimeout(900);
    ok("подана без вложений (после предупреждения)", /На согласовании/.test(await s.p.textContent("#zDocBar")), await s.p.textContent("#zDocMsg"));
    ok("вид и специфика на бланке", /Корректировка бюджета/.test(await s.p.textContent("#zPaper")) && /414 — Приобретение машин/.test(await s.p.textContent("#zPaper")));
    await s.ctx.close();
    s = await open(ECO, "zayavki.html");
    await s.p.click('.z-tab[data-tab="inbox"]');
    await s.p.locator("#zRows tr", { hasText: "Стулья" }).click();
    await s.p.waitForTimeout(500);
    ok("экономисту рано: кнопки подписи нет", (await s.p.locator('[data-sign="economist"]').count()) === 0);
    ok("видно, кто подписывает первым", /сначала подписывает зам\. директора по ахр/.test(await s.p.textContent("#zPaper")));
    await s.ctx.close();

    console.log("\n── Инициатор видит итог ──");
    s = await open(INI, "zayavki.html");
    ok("в списке — утверждена", /Утверждена/.test(await s.p.textContent("#zRows")));
    await s.p.locator("#zRows tr", { hasText: "Бумага" }).click();
    await s.p.waitForTimeout(600);
    ok("видит ответ экономиста", /коммерческое предложение/.test(await s.p.textContent("#zNotes")));
    await s.ctx.close();

    console.log("\n── Примечания на листе бюджета ──");
    s = await open(ECO, "pu-income-pu.html");
    await s.p.waitForTimeout(1500);
    ok("блок примечаний есть", (await s.p.locator(".fnotes").count()) === 1);
    ok("строки — с городом филиала", /в г\. Астана/.test(await s.p.textContent("#tableBody")));
    await s.p.click(".fnotes-head");
    await s.p.fill(".fnotes textarea", "Контингент уточнить к 20.10");
    await s.p.click(".fnotes button[type=submit]");
    await s.p.waitForTimeout(600);
    ok("примечание к листу сохранено", /Контингент уточнить/.test(await s.p.textContent(".fnotes")));
    await shot(s.p, "5-sheet-notes");
    ok("ошибок в консоли нет", !s.errors.length, s.errors.join(" | "));
    await s.ctx.close();

    s = await open(DIR, "pu-income-pu.html");
    await s.p.waitForTimeout(1500);
    ok("директор (просмотр) видит примечание", /Контингент уточнить/.test(await s.p.textContent(".fnotes")));
    ok("и может ответить: поле не заблокировано", await s.p.isEnabled(".fnotes textarea"));
    ok("а таблица бюджета — заблокирована", !(await s.p.isEnabled("#tableBody input >> nth=0")));
    await s.ctx.close();
} finally {
    await browser.close();
    server.close();
}

console.log(`\n${failed ? "ПРОВАЛЕНО" : "Все проверки пройдены"}: ${total - failed} из ${total}`);
process.exit(failed ? 1 : 0);
