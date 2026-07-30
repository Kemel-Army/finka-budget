/**
 * Создание учётных записей в Supabase Auth по ролевой матрице.
 *
 *   node scripts/create-users.mjs            # создать/обновить всех
 *   node scripts/create-users.mjs --dry-run  # только показать план
 *   node scripts/create-users.mjs --list     # показать существующих
 *
 * SUPABASE_URL и SUPABASE_SECRET_KEY читаются из .env (в git не попадает).
 * Пароли генерируются случайно и печатаются ОДИН РАЗ — сохраните их сразу,
 * повторно Supabase их не покажет.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── .env ──────────────────────────────────────────────────────── */
function loadEnv() {
    const file = path.join(ROOT, ".env");
    if (!fs.existsSync(file)) {
        throw new Error(".env не найден в " + ROOT);
    }
    const env = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return env;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL;
const SECRET = env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SECRET) {
    throw new Error("В .env нужны SUPABASE_URL и SUPABASE_SECRET_KEY");
}

/* ── Матрица доступа (из «Алгоритм доступа в финансовую модель.xlsx») ── */
const DOMAIN = "rfmsh.kz";

const BRANCHES = [
    { key: "nao", suffix: "", name: "НАО «РФМШ» (центральный аппарат)" },
    { key: "almaty", suffix: ".ala", name: "Филиал Алматы" },
    { key: "astana", suffix: ".ast", name: "Филиал Астана" },
    { key: "uralsk", suffix: ".ura", name: "Филиал Уральск" },
];

const ROLE_DEFS = [
    {
        role: "view",
        local: "view",
        zone: "Зона просмотра / полный доступ для контроля",
        titles: {
            nao: "Председатель правления, первый заместитель, заместитель, финансовый директор",
            branch: "Директор филиала",
        },
    },
    {
        role: "edit",
        local: "edit",
        zone: "Зона работы / полный доступ",
        titles: {
            nao: "Главный экономист НАО «РФМШ»",
            branch: "Экономист, бухгалтер-экономист филиала",
        },
    },
    {
        role: "limited",
        local: "lim",
        zone: "Зона работы / ограниченный доступ",
        titles: {
            nao: "Главный бухгалтер НАО «РФМШ», инспектор по кадровой работе, специалист по закупкам, юрист, IT-отдел",
            branch: "Главный бухгалтер филиала, старшие бухгалтеры, заместитель директора филиала",
        },
    },
    {
        role: "initiator",
        local: "init",
        zone: "Заявки-потребности по своему филиалу",
        titles: {
            nao: "Остальные работники центрального аппарата (инициаторы)",
            branch: "Остальные работники филиала (инициаторы)",
        },
    },
];

const PLAN = [];

for (const def of ROLE_DEFS) {
    for (const br of BRANCHES) {
        PLAN.push({
            email: `${def.local}${br.suffix}@${DOMAIN}`,
            role: def.role,
            branch: br.key,
            branchName: br.name,
            zone: def.zone,
            title: br.key === "nao" ? def.titles.nao : def.titles.branch,
        });
    }
}

// Технический администратор системы — вне матрицы xlsx, нужен для управления
// пользователями и ролями.
PLAN.push({
    email: `admin@${DOMAIN}`,
    role: "admin",
    branch: "nao",
    branchName: "НАО «РФМШ» (центральный аппарат)",
    zone: "Администрирование системы",
    title: "Администратор системы",
});

/* ── Admin API ─────────────────────────────────────────────────── */
async function api(pathname, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1${pathname}`, {
        ...options,
        headers: {
            apikey: SECRET,
            Authorization: `Bearer ${SECRET}`,
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });
    const text = await res.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    if (!res.ok) {
        const msg = (body && (body.msg || body.message || body.error)) || text;
        throw new Error(`${res.status} ${pathname}: ${msg}`);
    }
    return body;
}

async function listUsers() {
    const out = [];
    for (let page = 1; page <= 20; page++) {
        const res = await api(`/admin/users?page=${page}&per_page=200`);
        const users = res.users || [];
        out.push(...users);
        if (users.length < 200) break;
    }
    return out;
}

/* ── Генерация пароля ──────────────────────────────────────────── */
// Без похожих символов (0/O, 1/l/I) — пароли передаются людьми вручную.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makePassword(len = 14) {
    const bytes = crypto.randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
}

/* ── Запуск ────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const listOnly = args.includes("--list");

const existing = await listUsers();
const byEmail = new Map(
    existing.map((u) => [String(u.email || "").toLowerCase(), u]),
);

if (listOnly) {
    console.log(`Пользователей в проекте: ${existing.length}\n`);
    for (const u of existing) {
        const m = u.app_metadata || {};
        console.log(
            [
                u.email.padEnd(24),
                String(m.role || "—").padEnd(10),
                String(m.branch || "—").padEnd(8),
                u.email_confirmed_at ? "confirmed" : "NOT CONFIRMED",
            ].join(" "),
        );
    }
    process.exit(0);
}

const results = [];

for (const item of PLAN) {
    const found = byEmail.get(item.email.toLowerCase());
    const appMeta = {
        role: item.role,
        branch: item.branch,
        title: item.title,
        zone: item.zone,
    };

    if (dryRun) {
        results.push({ ...item, action: found ? "update" : "create", password: "—" });
        continue;
    }

    try {
        if (found) {
            // Роль/филиал обновляем, пароль не трогаем.
            await api(`/admin/users/${found.id}`, {
                method: "PUT",
                body: JSON.stringify({ app_metadata: appMeta }),
            });
            results.push({ ...item, action: "updated", password: "(без изменений)" });
        } else {
            const password = makePassword();
            await api("/admin/users", {
                method: "POST",
                body: JSON.stringify({
                    email: item.email,
                    password,
                    email_confirm: true,
                    app_metadata: appMeta,
                }),
            });
            results.push({ ...item, action: "created", password });
        }
    } catch (err) {
        results.push({ ...item, action: "ERROR", password: String(err.message) });
    }
}

/* ── Вывод ─────────────────────────────────────────────────────── */
const header = ["email", "пароль", "роль", "филиал", "действие"];
const rows = results.map((r) => [
    r.email,
    r.password,
    r.role,
    r.branch,
    r.action,
]);
const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => String(row[i]).length)),
);

const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");

console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(row));

const created = results.filter((r) => r.action === "created").length;
const updated = results.filter((r) => r.action === "updated").length;
const failed = results.filter((r) => r.action === "ERROR").length;
console.log(
    `\nСоздано: ${created}   обновлено: ${updated}   ошибок: ${failed}   всего: ${results.length}`,
);

if (created > 0) {
    console.log(
        "\nПАРОЛИ ПОКАЗАНЫ ОДИН РАЗ. Сохраните их сейчас — Supabase хранит только хеш.",
    );
}

if (failed > 0) process.exitCode = 1;
