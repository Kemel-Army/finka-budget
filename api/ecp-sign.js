/**
 * POST /api/ecp-sign — проверить подпись ЭЦП заявки и записать её.
 * GET  /api/ecp-sign — настроена ли проверка (для подсказки в интерфейсе).
 *
 * Вся логика — api/_lib/ecp.js. Переменные окружения Vercel:
 *   NCANODE_URL          адрес NCANode v3 (например https://ncanode.example.kz)
 *   NCANODE_TOKEN        токен прокси перед NCANode (заголовок X-Ncanode-Token)
 *   ECP_SECRET           секрет для budget.add_ecp_signature (scripts/ecp-secret.mjs)
 *   NCANODE_REVOCATION   OCSP (по умолчанию), CRL или OCSP,CRL
 * Настройка — ECP.md.
 */
"use strict";

const { handle } = require("./_lib/ecp.js");

module.exports = async function (req, res) {
    let body = req.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch (e) {
            body = null;
        }
    }
    const auth = String(req.headers.authorization || "");
    const out = await handle(
        { method: req.method, token: auth.replace(/^Bearer\s+/i, ""), body },
        process.env,
        fetch,
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = out.status;
    res.end(JSON.stringify(out.json));
};
