/**
 * Проверка подписи ЭЦП заявки-потребности на сервере.
 *
 * Схема та же, что в qoltanba/tamga (server/services/ncaService.ts):
 * подпись CMS из NCALayer проверяет NCANode v3 (POST /cms/verify) — сама
 * подпись, цепочка до корня НУЦ, отзыв сертификата (OCSP/CRL), метка
 * времени. Браузеру здесь не верим ни в чём:
 *
 *   1. Кто подписывает — по токену Supabase (GET /auth/v1/user).
 *   2. Что подписывается — заявка читается из базы от имени этого же
 *      пользователя (RLS), текст строится тем же zayavka-core.js, что и в
 *      браузере. CMS без вложенных данных (detached), поэтому NCANode
 *      проверяет подпись ровно на этом тексте: подписать «что-то другое»
 *      и выдать за заявку нельзя.
 *   3. Ключ — SIGN (не AUTH), сертификат действует и не отозван, ИИН есть.
 *      Если в учётке задан ИИН (app_metadata.iin) — он должен совпасть, если
 *      задано ФИО (app_metadata.name) — должна совпасть фамилия.
 *   4. Запись — RPC budget.add_ecp_signature с секретом сервера (миграция
 *      0005) от имени пользователя: права на графу ещё раз проверяет
 *      триггер базы.
 *
 * Модуль без зависимостей и без обращения к process.env: настройки и fetch
 * передаются явно — так его проверяет tests/ecp.mjs без сети.
 */
"use strict";

const crypto = require("node:crypto");
require("../../zayavka-core.js");

const Z = globalThis.ZayavkaCore;

// Те же публичные значения, что в auth.js (publishable-ключ публичный по
// дизайну Supabase)
const SUPABASE_URL = "https://fdzwvwapcxoxllfqaoxw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ksFJ2xPiZXRTqk2l77NkMg_DSbD60u2";

const SLOTS = ["initiator", "ahr", "zakup", "economist", "director"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CMS = 200000;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function config(env) {
    env = env || {};
    return {
        supabaseUrl: (env.SUPABASE_URL || SUPABASE_URL).replace(/\/+$/, ""),
        anonKey: env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY,
        ncanodeUrl: (env.NCANODE_URL || "").replace(/\/+$/, ""),
        ncanodeToken: env.NCANODE_TOKEN || "",
        secret: env.ECP_SECRET || "",
        // Как проверять отзыв: OCSP быстрее, CRL — запасной (qoltanba: CRL)
        revocation: (env.NCANODE_REVOCATION || "OCSP")
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s === "OCSP" || s === "CRL"),
    };
}

function ready(cfg) {
    return !!(cfg.ncanodeUrl && cfg.secret.length >= 32);
}

/* ── Supabase ──────────────────────────────────────────────────── */
async function getUser(cfg, token, fetch) {
    const res = await fetch(cfg.supabaseUrl + "/auth/v1/user", {
        headers: { apikey: cfg.anonKey, Authorization: "Bearer " + token },
    });
    if (!res.ok) throw new HttpError(401, "Сессия истекла — войдите заново");
    return res.json();
}

function restHeaders(cfg, token, extra) {
    return Object.assign(
        {
            apikey: cfg.anonKey,
            Authorization: "Bearer " + token,
            "Accept-Profile": "budget",
            "Content-Profile": "budget",
        },
        extra || {},
    );
}

async function getRequest(cfg, token, id, fetch) {
    const res = await fetch(
        cfg.supabaseUrl + "/rest/v1/requests?select=*&id=eq." + encodeURIComponent(id),
        { headers: restHeaders(cfg, token) },
    );
    if (!res.ok) throw new HttpError(502, "База не ответила (" + res.status + ")");
    const rows = await res.json();
    if (!rows.length) throw new HttpError(404, "Заявка не найдена или нет доступа");
    return rows[0];
}

async function addSignature(cfg, token, id, entry, fetch) {
    const res = await fetch(cfg.supabaseUrl + "/rest/v1/rpc/add_ecp_signature", {
        method: "POST",
        headers: restHeaders(cfg, token, {
            "Content-Type": "application/json",
            Accept: "application/vnd.pgrst.object+json",
        }),
        body: JSON.stringify({ p_id: id, p_entry: entry, p_secret: cfg.secret }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        // Сообщения триггера понятны людям — отдаём как есть
        throw new HttpError(409, (body && (body.message || body.details)) || "База отказала (" + res.status + ")");
    }
    return body;
}

/* ── NCANode ───────────────────────────────────────────────────── */
function ncanodeHeaders(cfg) {
    const h = { "Content-Type": "application/json" };
    // NCANode без авторизации; наружу его открывают через прокси с токеном
    if (cfg.ncanodeToken) h["X-Ncanode-Token"] = cfg.ncanodeToken;
    return h;
}

async function ncanodeVerify(cfg, cms, dataB64, fetch) {
    let res;
    try {
        res = await fetch(cfg.ncanodeUrl + "/cms/verify", {
            method: "POST",
            headers: ncanodeHeaders(cfg),
            body: JSON.stringify({ cms, data: dataB64, revocationCheck: cfg.revocation }),
        });
    } catch (e) {
        throw new HttpError(503, "Сервис проверки ЭЦП (NCANode) недоступен");
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
        throw new HttpError(
            res.status >= 500 || !body ? 503 : 422,
            "Подпись не прошла проверку: " + ((body && body.message) || "NCANode " + res.status),
        );
    }
    return body;
}

async function ncanodeHealth(cfg, fetch) {
    try {
        const res = await fetch(cfg.ncanodeUrl + "/actuator/health", { headers: ncanodeHeaders(cfg) });
        const body = await res.json();
        return body && body.status === "UP";
    } catch (e) {
        return false;
    }
}

/* ── Проверка сертификата ──────────────────────────────────────── */
function norm(s) {
    return String(s || "").toUpperCase().replace(/Ё/g, "Е").replace(/\s+/g, " ").trim();
}

// Фамилия учётки должна быть фамилией владельца ключа. В сертификатах НУЦ
// CN — «ФАМИЛИЯ ИМЯ», SURNAME — фамилия
function surnameMatches(name, subject) {
    const want = norm(name).split(" ")[0];
    if (!want) return true;
    const have = [norm(subject.lastName), norm(subject.commonName).split(" ")[0]];
    return have.indexOf(want) !== -1;
}

function certOf(res, meta) {
    if (!res.valid || !res.signers || !res.signers.length) {
        throw new HttpError(422, "Подпись недействительна: " + (res.message || "не прошла проверку"));
    }
    const signer = res.signers[0];
    const cert = signer.certificates && signer.certificates[0];
    if (!cert) throw new HttpError(422, "В подписи нет сертификата");

    const revoked = (cert.revocations || []).find((r) => r.revoked);
    if (revoked) {
        throw new HttpError(422, "Сертификат ЭЦП отозван (" + revoked.by + (revoked.reason ? ": " + revoked.reason : "") + ")");
    }
    if (!cert.valid) throw new HttpError(422, "Сертификат ЭЦП недействителен: истёк срок или не доверенный УЦ");
    if (cert.keyUsage !== "SIGN") {
        throw new HttpError(422, "Выбран ключ для входа (AUTH). Для подписи нужен ключ подписи — файл RSA… или GOST… без «AUTH» в названии");
    }

    const subject = cert.subject || {};
    if (!subject.iin) throw new HttpError(422, "В сертификате нет ИИН");
    if (meta.iin && meta.iin !== subject.iin) {
        throw new HttpError(403, "ИИН в сертификате не совпадает с учётной записью — подпишите своим ключом");
    }
    if (!meta.iin && meta.name && !surnameMatches(meta.name, subject)) {
        throw new HttpError(
            403,
            "Ключ выдан на «" + (subject.commonName || "?") + "», а вы вошли как «" + meta.name +
                "». Подпишите своим ключом. Если фамилия записана иначе — администратор укажет ИИН в учётке.",
        );
    }

    // CN — «ФАМИЛИЯ ИМЯ»; отчество (GIVENNAME) приходит отдельным полем —
    // дописываем то, чего в CN ещё нет
    const cn = subject.commonName || "";
    const words = norm(cn).split(" ");
    const extra = [subject.surName, subject.lastName].find((x) => x && words.indexOf(norm(x)) === -1);

    return {
        fio: (cn + (extra ? " " + extra : "")).trim(),
        iin: subject.iin,
        bin: subject.bin || "",
        org: subject.organization || "",
        email: subject.email || "",
        serial: cert.serialNumber || "",
        issuer: (cert.issuer && cert.issuer.commonName) || "",
        notBefore: cert.notBefore || "",
        notAfter: cert.notAfter || "",
        keyUser: cert.keyUser || [],
        tsp: signer.tsp ? signer.tsp.genTime || "" : "",
    };
}

/* ── Обработчик ────────────────────────────────────────────────── */
/* { method, token, body } → { status, json }. Ошибки — в json.error. */
async function handle(input, env, fetch) {
    const cfg = config(env);
    try {
        if (input.method === "GET") {
            const on = ready(cfg);
            return { status: 200, json: { ready: on, ncanode: on ? await ncanodeHealth(cfg, fetch) : false } };
        }
        if (input.method !== "POST") throw new HttpError(405, "Только POST");
        if (!ready(cfg)) throw new HttpError(503, "Проверка ЭЦП на сервере ещё не настроена (NCANODE_URL, ECP_SECRET)");
        if (!input.token) throw new HttpError(401, "Нужен вход в систему");

        const b = input.body || {};
        if (!UUID.test(String(b.id || ""))) throw new HttpError(400, "Неверный номер заявки");
        if (SLOTS.indexOf(b.slot) === -1) throw new HttpError(400, "Неизвестная графа подписи");
        const cms = String(b.cms || "").replace(/\s+/g, "");
        if (!cms || cms.length > MAX_CMS || !/^[A-Za-z0-9+/]+=*$/.test(cms)) {
            throw new HttpError(400, "Подпись CMS пришла в неверном виде");
        }

        const user = await getUser(cfg, input.token, fetch);
        const meta = user.app_metadata || {};
        const req = await getRequest(cfg, input.token, b.id, fetch);

        // Права до похода в NCANode: зачем проверять подпись, которую база
        // всё равно не примет. Окончательно решает триггер
        const profile = { roleKey: meta.role, branchKey: meta.branch || "nao", signer: meta.signer || "" };
        if (!Z.canSign(b.slot, profile, req, user.id)) {
            throw new HttpError(403, "Нет права подписи в этой графе (или заявка уже в другом статусе)");
        }

        const text = Z.signedText(req);
        const data = Buffer.from(text, "utf8").toString("base64");
        const cert = certOf(await ncanodeVerify(cfg, cms, data, fetch), meta);

        const entry = {
            slot: b.slot,
            kind: "ecp",
            cms,
            hash: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
            cert,
            verified: { by: "NCANode", revocation: cfg.revocation.join(","), at: new Date().toISOString() },
        };
        const row = await addSignature(cfg, input.token, b.id, entry, fetch);
        return { status: 200, json: { request: row } };
    } catch (e) {
        if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
        return { status: 500, json: { error: "Внутренняя ошибка проверки подписи" } };
    }
}

module.exports = { handle, config, surnameMatches, HttpError };
