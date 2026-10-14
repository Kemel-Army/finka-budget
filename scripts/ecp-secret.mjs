/**
 * Секрет сервера проверки ЭЦП (миграция 0005, api/ecp-sign.js).
 *
 *     node scripts/ecp-secret.mjs
 *
 * Печатает:
 *   1. значение для переменной ECP_SECRET на Vercel;
 *   2. SQL для SQL Editor — в базу кладётся только SHA-256 секрета, сам
 *      секрет в базе и в истории SQL не появляется.
 * Ничего никуда не отправляет. Смена секрета — запустить ещё раз и
 * повторить оба шага.
 */
import crypto from "node:crypto";

const secret = crypto.randomBytes(32).toString("base64url");
const hash = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

console.log("1) Vercel → Settings → Environment Variables (Production):");
console.log("   ECP_SECRET = " + secret);
console.log("");
console.log("2) Supabase → SQL Editor:");
console.log(
    "   insert into budget.ecp_config (id, secret_hash) values (1, decode('" + hash + "', 'hex'))\n" +
        "   on conflict (id) do update set secret_hash = excluded.secret_hash, updated_at = now();",
);
console.log("");
console.log("Секрет никому не пересылайте и в git не кладите.");
