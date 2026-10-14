/**
 * Создание учётных записей в Supabase Auth по ролевой матрице.
 *
 *   node scripts/create-users.mjs            # создать/обновить всех
 *   node scripts/create-users.mjs --dry-run  # только показать план
 *   node scripts/create-users.mjs --list     # показать существующих
 *   node scripts/create-users.mjs --only view   # только одна роль матрицы
 *
 * Личные учётки (инициаторы заявок и подписанты) — списком из файла:
 *   node scripts/create-users.mjs --file scripts/initiators-astana.local.json \
 *        --out scripts/passwords-astana.local.csv
 * Файл — массив {email, name, title, role, branch, signer}. signer — графа
 * подписи заявки-потребности: ahr, zakup, economist, director (миграция
 * 0004). С --out пароли пишутся в CSV, а не на экран. Файлы *.local.* в git
 * не попадают: там ФИО сотрудников и пароли, а репозиторий публичный.
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
        // Директор утверждает заявки-потребности («Утверждаю»)
        signer: "director",
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
            signer: def.signer || "",
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

/* ── Аргументы ─────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const listOnly = args.includes("--list");
function argValue(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}
const fromFile = argValue("--file");
const onlyRole = argValue("--only");
const outCsv = argValue("--out");

const ROLE_KEYS = ["admin", "view", "edit", "limited", "initiator"];
const BRANCH_KEYS = BRANCHES.map((b) => b.key);
const SIGNERS = ["", "ahr", "zakup", "economist", "director"];
const ZONES = Object.fromEntries(ROLE_DEFS.map((d) => [d.role, d.zone]));

if (fromFile) {
    const list = JSON.parse(fs.readFileSync(path.resolve(ROOT, fromFile), "utf8"));
    PLAN.length = 0;
    for (const u of list) {
        if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(u.email || "")) throw new Error("email: " + u.email);
        if (!ROLE_KEYS.includes(u.role)) throw new Error(`${u.email}: роль ${u.role}`);
        if (!BRANCH_KEYS.includes(u.branch)) throw new Error(`${u.email}: филиал ${u.branch}`);
        if (!SIGNERS.includes(u.signer || "")) throw new Error(`${u.email}: signer ${u.signer}`);
        PLAN.push({
            email: u.email.toLowerCase(),
            role: u.role,
            branch: u.branch,
            branchName: BRANCHES.find((b) => b.key === u.branch).name,
            zone: ZONES[u.role] || "",
            title: u.title || "",
            name: u.name || "",
            signer: u.signer || "",
        });
    }
}
if (onlyRole) {
    const keep = PLAN.filter((p) => p.role === onlyRole);
    PLAN.length = 0;
    PLAN.push(...keep);
}

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
        // Пустая строка, а не отсутствие: при обновлении снимает прежнее
        signer: item.signer || "",
    };
    if (item.name) appMeta.name = item.name;

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

if (outCsv) {
    // Пароли — в файл, на экран только сводка
    const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const csv = ["email;пароль;ФИО;должность;роль;филиал;подпись;действие"]
        .concat(results.map((r) =>
            [r.email, r.password, r.name, r.title, r.role, r.branch, r.signer, r.action].map(q).join(";"),
        ))
        .join("\r\n");
    // BOM — чтобы Excel открыл кириллицу без вопросов
    fs.writeFileSync(path.resolve(ROOT, outCsv), "﻿" + csv, "utf8");
    for (const r of results) {
        console.log(`${r.email.padEnd(32)} ${r.role.padEnd(10)} ${r.action}${r.action === "ERROR" ? " " + r.password : ""}`);
    }
    console.log("\nПароли записаны в " + outCsv);
} else {
    console.log(line(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) console.log(line(row));
}

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
