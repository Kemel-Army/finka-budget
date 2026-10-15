/**
 * Заявка-потребность: расчёты, проверка формы, подписываемый текст,
 * права в интерфейсе и разбор сертификата из CMS (zayavka-core.js).
 *
 *     node tests/zayavki.mjs
 *
 * fixtures/cms-test.b64 — CMS, подписанный самоподписанным сертификатом с
 * полями как у НУЦ РК (CN, SURNAME, SERIALNUMBER=IIN…, OU=BIN…, GIVENNAME),
 * сделан openssl cms -sign -nodetach.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(path.join(HERE, "..", "zayavka-core.js"));
const Z = globalThis.ZayavkaCore;

let total = 0;
let failed = 0;
function eq(label, got, want) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`   ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : ` — ждём ${JSON.stringify(want)}, получили ${JSON.stringify(got)}`}`);
}

console.log("\n── Итоги ──");
eq("строка: кол-во × цена", Z.rowTotal({ qty: "3", price: "1 500,50" }), 4501.5);
eq("строка без цены — 0", Z.rowTotal({ qty: 2 }), 0);
eq("итог заявки", Z.docTotal({ rows: [{ qty: 2, price: 100 }, { qty: 1, price: 0.1 }] }), 200.1);

console.log("\n── Форма ──");
const raw = {
    date: "2026-10-14",
    position: " Зам. директора ",
    fio: "Иванов И.И.",
    junk: "лишнее",
    rows: [
        { name: "Бумага А4", unit: "пачка", qty: "10", price: "2500", period: "ноябрь", purpose: "Для учебного процесса" },
        { name: "", unit: "", qty: "", price: "" },
    ],
};
const d = Z.normalizeDoc(raw, { year: 2027 });
eq("пустые строки отброшены", d.rows.length, 1);
eq("лишние поля отброшены", "junk" in d, false);
eq("пробелы обрезаны", d.position, "Зам. директора");
eq("год по умолчанию", d.year, 2027);
eq("заполненная форма проходит", Z.validate(raw), []);
eq("пустая форма — ошибки", Z.validate({}).length > 0, true);
eq("строка без цены — ошибка", Z.validate({ ...raw, rows: [{ name: "x", unit: "шт", qty: 1, purpose: "y" }] }),
    ["Строка 1: цена должна быть больше нуля"]);

console.log("\n── Подписываемый текст ──");
const req = { id: "u1", no: 7, branch: "astana", doc: raw };
const t1 = Z.signedText(req);
const t2 = Z.signedText({ branch: "astana", no: 7, id: "u1", doc: { ...raw, rows: [...raw.rows].reverse().reverse() } });
eq("тот же объект — тот же текст", t1 === t2, true);
eq("в тексте итог", JSON.parse(t1).total, 25000);
eq("ключи по алфавиту", Z.stable({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
eq("base64 UTF-8", Buffer.from(Z.utf8ToBase64("Заявка №1"), "base64").toString("utf8"), "Заявка №1");

console.log("\n── Права в интерфейсе ──");
const ini = { roleKey: "initiator", branchKey: "astana" };
const eco = { roleKey: "edit", branchKey: "astana" };
const naoEco = { roleKey: "edit", branchKey: "nao" };
const alaEco = { roleKey: "edit", branchKey: "almaty" };
const dir = { roleKey: "view", branchKey: "astana", signer: "director" };
const ahr = { roleKey: "initiator", branchKey: "astana", signer: "ahr" };
const draft = { author: "me", status: "draft", branch: "astana", signatures: [] };
const sent = { author: "me", status: "submitted", branch: "astana", signatures: [{ slot: "initiator" }] };
eq("автор подписывает свой черновик", Z.canSign("initiator", ini, draft, "me"), true);
eq("чужой не подписывает за инициатора", Z.canSign("initiator", ini, draft, "other"), false);
eq("черновик не согласуют", Z.canSign("economist", eco, draft, "x"), false);
// Маршрут «только экономист»: экономист — следующий после инициатора
const onlyEco = { ...sent, doc: { route: ["economist"] } };
eq("экономист филиала", Z.canSign("economist", eco, onlyEco, "x"), true);
eq("экономист ЦА", Z.canSign("economist", naoEco, onlyEco, "x"), true);
eq("экономист Алматы — нет", Z.canSign("economist", alaEco, onlyEco, "x"), false);
eq("директор — до экономиста нельзя", Z.canSign("director", dir, onlyEco, "x"), false);
const ecoSigned = { ...onlyEco, signatures: [{ slot: "initiator" }, { slot: "economist" }] };
eq("директор — после экономиста утверждает", Z.canSign("director", dir, ecoSigned, "x"), true);
eq("АХР ждёт своей подписи", Z.waitingFor(ahr, sent, "x"), ["ahr"]);

console.log("\n── Маршрут согласования ──");
eq("по умолчанию — АХР, закупки, экономист", Z.route({}), ["ahr", "zakup", "economist"]);
eq("АХР и закупки исключены — остаётся экономист", Z.route({ route: [] }), ["economist"]);
eq("порядок — всегда канонический", Z.route({ route: ["economist", "ahr"] }), ["ahr", "economist"]);
eq("мусор в маршруте отбрасывается", Z.route({ route: ["boss", "zakup"] }), ["zakup", "economist"]);
eq("полный маршрут: первым ждёт АХР", Z.nextSlot(sent), "ahr");
eq("экономист в полном маршруте раньше времени — нет", Z.canSign("economist", eco, sent, "x"), false);
const afterAhr = { ...sent, signatures: [{ slot: "initiator" }, { slot: "ahr" }] };
eq("после АХР ждём закупки", Z.nextSlot(afterAhr), "zakup");
eq("все согласовали — ждём директора", Z.nextSlot({ ...sent, signatures: ["initiator", "ahr", "zakup", "economist"].map((x) => ({ slot: x })) }), "director");
eq("не подана — следующего нет", Z.nextSlot(draft), "");
eq("маршрут попадает в подписываемый текст", JSON.parse(Z.signedText({ id: "a", no: 1, branch: "astana", doc: { route: [] } })).doc.route, ["economist"]);
const fd = Z.normalizeDoc({ kind: "correction", files: [{ name: "КП.pdf", path: "a/b.pdf", size: "1200", sha256: "ab", junk: 1 }, { name: "без пути" }] });
eq("вложения: только с путём, лишнее отброшено", fd.files, [{ name: "КП.pdf", path: "a/b.pdf", size: 1200, type: "", sha256: "ab" }]);
eq("вид заявки — корректировка", fd.kind, "correction");
eq("неизвестный вид — планирование", Z.normalizeDoc({ kind: "x" }).kind, "plan");
eq("правка подписанной — нет", Z.canEdit(ini, sent, "me"), false);
eq("отозвать, пока подписал только автор", Z.canWithdraw(ini, sent, "me"), true);
eq("отозвать после согласующего — нет",
    Z.canWithdraw(ini, { ...sent, signatures: [{ slot: "initiator" }, { slot: "ahr" }] }, "me"), false);
eq("вернуть может согласующий", Z.canReturn(ahr, sent), true);
eq("инициатор без подписи не возвращает", Z.canReturn(ini, sent), false);

console.log("\n── Сертификат из CMS ──");
const cms = fs.readFileSync(path.join(HERE, "fixtures", "cms-test.b64"), "utf8");
const c = Z.parseCms(cms);
eq("ФИО", c && c.fio, "ТЕСТОВ ТЕСТ ТЕСТОВИЧ");
eq("ИИН", c && c.iin, "123456789012");
eq("БИН", c && c.bin, "123456789021");
eq("организация", c && c.org, "НАО «РФМШ»");
eq("срок действия", c && c.notAfter.slice(0, 10), "2027-10-14");
eq("мусор — null, без исключения", Z.parseCms("не base64 ####"), null);

console.log(`\n${failed ? "ПРОВАЛЕНО" : "Все проверки пройдены"}: ${total - failed} из ${total}`);
process.exit(failed ? 1 : 0);
