/**
 * Серверная проверка ЭЦП (api/_lib/ecp.js, api/ecp-sign.js) без сети:
 * Supabase и NCANode подменены, проверяется, что сервер
 *   — подписывает в NCANode ровно текст заявки из базы (а не из браузера);
 *   — отвергает ключ AUTH, отозванный и недействительный сертификат, чужой
 *     ИИН и чужую фамилию;
 *   — не зовёт NCANode, если графу подписывать нельзя;
 *   — пишет подпись только через RPC с секретом.
 *
 *     node tests/ecp.mjs
 *
 * Ответы NCANode — по схеме NCANode v3 (/cms/verify), как их разбирает
 * qoltanba (server/services/ncaService.ts).
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { handle } = require(path.join(HERE, "..", "api", "_lib", "ecp.js"));
const vercelFn = require(path.join(HERE, "..", "api", "ecp-sign.js"));
const Z = globalThis.ZayavkaCore;

let total = 0;
let failed = 0;
function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${label}${!cond && extra ? " — " + extra : ""}`);
}

const ENV = { NCANODE_URL: "http://ncanode.test", NCANODE_TOKEN: "tok", ECP_SECRET: "x".repeat(40) };
const UID = "00000000-0000-0000-0000-000000000001";
const RID = "11111111-2222-3333-4444-555555555555";

function request(over = {}) {
    return {
        id: RID,
        no: 5,
        branch: "astana",
        status: "draft",
        author: UID,
        signatures: [],
        doc: { date: "2026-10-14", position: "Зам", fio: "Акимжанова Д.С.", rows: [{ name: "Бумага", unit: "пачка", qty: 2, price: 100, purpose: "x" }] },
        ...over,
    };
}

function cert(over = {}) {
    return {
        valid: true,
        revocations: [{ revoked: false, by: "OCSP" }],
        notBefore: "2026-01-01T00:00:00Z",
        notAfter: "2027-01-01T00:00:00Z",
        keyUsage: "SIGN",
        serialNumber: "abc",
        keyUser: ["INDIVIDUAL"],
        subject: { commonName: "АКИМЖАНОВА ДИНАРА", lastName: "АКИМЖАНОВА", surName: "СЕМБАЕВНА", iin: "880101400123" },
        issuer: { commonName: "ҰЛТТЫҚ КУӘЛАНДЫРУШЫ ОРТАЛЫҚ (RSA)" },
        ...over,
    };
}

/* Подменённая сеть. calls — что и куда ушло */
function net({ meta = { role: "initiator", branch: "astana", name: "Акимжанова Динара Сембаевна" }, req = request(), nca, ncaDown = false, rpcError = null } = {}) {
    const calls = [];
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    const fetch = async (url, opt = {}) => {
        calls.push({ url, opt, body: opt.body ? JSON.parse(opt.body) : null });
        if (url.endsWith("/auth/v1/user")) {
            return opt.headers.Authorization === "Bearer good" ? json(200, { id: UID, app_metadata: meta }) : json(401, {});
        }
        if (url.includes("/rest/v1/requests")) return json(200, req ? [req] : []);
        if (url.endsWith("/cms/verify")) {
            if (ncaDown) throw new Error("ECONNREFUSED");
            return json(200, nca || { status: 200, message: "", valid: true, signers: [{ certificates: [cert()], tsp: { genTime: "2026-10-14T10:00:00Z" } }] });
        }
        if (url.endsWith("/actuator/health")) return json(200, { status: "UP" });
        if (url.endsWith("/rpc/add_ecp_signature")) {
            if (rpcError) return json(400, { message: rpcError });
            const b = JSON.parse(opt.body);
            return json(200, { ...req, status: "submitted", signatures: [b.p_entry] });
        }
        return json(404, {});
    };
    return { fetch, calls };
}

const POST = (body, token = "good") => ({ method: "POST", token, body: { id: RID, slot: "initiator", cms: "MIIBAAAA", ...body } });
const find = (calls, part) => calls.find((c) => c.url.includes(part));

console.log("\n── Настройка ──");
let n = net();
let r = await handle({ method: "GET" }, {}, n.fetch);
ok("без настроек — ready: false", r.status === 200 && r.json.ready === false);
r = await handle({ method: "GET" }, ENV, n.fetch);
ok("с настройками — ready и NCANode UP", r.json.ready === true && r.json.ncanode === true);
ok("токен прокси уходит в NCANode", find(n.calls, "/actuator/health").opt.headers["X-Ncanode-Token"] === "tok");
r = await handle(POST({}), {}, net().fetch);
ok("POST без настроек — 503", r.status === 503);
r = await handle(POST({}), { ...ENV, ECP_SECRET: "short" }, net().fetch);
ok("короткий секрет не считается настройкой", r.status === 503);

console.log("\n── Входные данные ──");
r = await handle(POST({}, ""), ENV, net().fetch);
ok("без входа — 401", r.status === 401);
r = await handle(POST({}, "bad"), ENV, net().fetch);
ok("чужой/просроченный токен — 401", r.status === 401);
r = await handle(POST({ id: "1; drop" }), ENV, net().fetch);
ok("кривой номер заявки — 400", r.status === 400);
r = await handle(POST({ slot: "boss" }), ENV, net().fetch);
ok("неизвестная графа — 400", r.status === 400);
r = await handle(POST({ cms: "<script>" }), ENV, net().fetch);
ok("не base64 — 400", r.status === 400);
r = await handle(POST({}), ENV, net({ req: null }).fetch);
ok("заявка не видна по RLS — 404", r.status === 404);

console.log("\n── Подпись ──");
n = net();
r = await handle(POST({}), ENV, n.fetch);
ok("действующая подпись — записана", r.status === 200 && r.json.request.status === "submitted", JSON.stringify(r.json));
const v = find(n.calls, "/cms/verify").body;
ok("в NCANode — текст заявки из базы", Buffer.from(v.data, "base64").toString("utf8") === Z.signedText(request()));
ok("проверка отзыва — OCSP", JSON.stringify(v.revocationCheck) === '["OCSP"]');
const rpc = find(n.calls, "/rpc/add_ecp_signature");
ok("запись — RPC с секретом сервера", rpc && rpc.body.p_secret === ENV.ECP_SECRET && rpc.opt.headers["Content-Profile"] === "budget");
ok("запись — от имени пользователя (его токен)", rpc.opt.headers.Authorization === "Bearer good");
const e = rpc.body.p_entry;
ok("в подписи ФИО с отчеством и ИИН из сертификата", e.cert.fio === "АКИМЖАНОВА ДИНАРА СЕМБАЕВНА" && e.cert.iin === "880101400123", e.cert.fio);
ok("метка времени НУЦ сохранена", e.cert.tsp === "2026-10-14T10:00:00Z");
ok("хеш — SHA-256 подписанного текста", /^[0-9a-f]{64}$/.test(e.hash) && e.kind === "ecp" && e.verified.by === "NCANode");

r = await handle(POST({}), ENV, net({ nca: { valid: false, message: "Signature is not valid", signers: [] } }).fetch);
ok("подпись не на этих данных — 422", r.status === 422 && /недействительна/.test(r.json.error));
r = await handle(POST({}), ENV, net({ nca: { valid: true, signers: [{ certificates: [cert({ keyUsage: "AUTH" })] }] } }).fetch);
ok("ключ AUTH — 422", r.status === 422 && /AUTH/.test(r.json.error));
r = await handle(POST({}), ENV, net({ nca: { valid: true, signers: [{ certificates: [cert({ revocations: [{ revoked: true, by: "OCSP", reason: "keyCompromise" }] })] }] } }).fetch);
ok("отозванный сертификат — 422", r.status === 422 && /отозван/.test(r.json.error));
r = await handle(POST({}), ENV, net({ nca: { valid: true, signers: [{ certificates: [cert({ valid: false })] }] } }).fetch);
ok("истёкший/недоверенный — 422", r.status === 422);
r = await handle(POST({}), ENV, net({ nca: { valid: true, signers: [{ certificates: [cert({ subject: { commonName: "ИВАНОВ ИВАН", iin: "1" } })] }] } }).fetch);
ok("ключ другого человека (фамилия) — 403", r.status === 403 && /ИВАНОВ/.test(r.json.error));
r = await handle(POST({}), ENV, net({ meta: { role: "initiator", branch: "astana", name: "Akimzhanova", iin: "880101400123" } }).fetch);
ok("ИИН в учётке совпал — фамилию не сверяем", r.status === 200, r.json.error);
r = await handle(POST({}), ENV, net({ meta: { role: "initiator", branch: "astana", iin: "990101400999" } }).fetch);
ok("ИИН в учётке не совпал — 403", r.status === 403);
r = await handle(POST({}), ENV, net({ meta: { role: "edit", branch: "astana" } }).fetch);
ok("общая учётка без ФИО и ИИН — принимается", r.status === 200, r.json.error);

n = net({ meta: { role: "initiator", branch: "astana" } });
r = await handle(POST({ slot: "economist" }), ENV, n.fetch);
ok("графу без права не проверяем в NCANode — 403", r.status === 403 && !find(n.calls, "/cms/verify"));
n = net({ req: request({ author: "someone-else" }) });
r = await handle(POST({}), ENV, n.fetch);
ok("за чужого инициатора — 403", r.status === 403);
r = await handle(POST({}), ENV, net({ ncaDown: true }).fetch);
ok("NCANode недоступен — 503", r.status === 503);
r = await handle(POST({}), ENV, net({ rpcError: "Графа «initiator» уже подписана" }).fetch);
ok("отказ базы — 409 с её текстом", r.status === 409 && /уже подписана/.test(r.json.error));

console.log("\n── Обёртка Vercel ──");
const res = {
    headers: {},
    setHeader(k, v) {
        this.headers[k] = v;
    },
    end(s) {
        this.body = s;
    },
};
const saved = { ...process.env };
Object.assign(process.env, ENV);
const realFetch = globalThis.fetch;
globalThis.fetch = net().fetch;
try {
    await vercelFn({ method: "POST", headers: { authorization: "Bearer good" }, body: JSON.stringify({ id: RID, slot: "initiator", cms: "MIIB" }) }, res);
} finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(ENV)) if (!(k in saved)) delete process.env[k];
}
ok("строка JSON в теле разбирается, ответ 200", res.statusCode === 200 && JSON.parse(res.body).request, res.body);
ok("ответ не кешируется", res.headers["Cache-Control"] === "no-store");

console.log(`\n${failed ? "ПРОВАЛЕНО" : "Все проверки пройдены"}: ${total - failed} из ${total}`);
process.exit(failed ? 1 : 0);
