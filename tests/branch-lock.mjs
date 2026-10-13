/**
 * Привязка к филиалу раньше загрузки страницы.
 *
 * auth.js у учётки филиала сам жмёт кнопку её города (lockBranch), как
 * только проверит сессию, — это бывает уже на DOMContentLoaded, раньше
 * обработчика load, в котором часть страниц строила таблицу и загружала
 * данные. Тогда switchBranch:
 *   • писал в ещё не созданные ячейки — «Cannot set properties of null»;
 *   • сохранял пустую заготовку поверх данных ЦА (ключ *_nao).
 *
 * Здесь клик auth.js воспроизводится на DOMContentLoaded в jsdom, и
 * проверяется: ошибок нет, ключи ЦА не тронуты, активна кнопка филиала.
 *
 *     node tests/branch-lock.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsdomPkg from "jsdom";

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let total = 0;
let failed = 0;

function ok(label, cond, extra = "") {
    total++;
    if (!cond) failed++;
    console.log(`   ${cond ? "OK  " : "FAIL"} ${String(label).padEnd(52)} ${extra}`);
}

// Страницы с переключателем филиалов
const PAGES = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => /function switchBranch/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    .sort();

const XLSX_STUB = `
window.XLSX = { utils: {}, read: () => ({ SheetNames: [], Sheets: {} }), writeFile: () => {} };
window.html2pdf = () => ({ from: () => ({ save: () => {} }) });
`;

/* То же, что делает auth.js для учётки Уральска: прячет чужие кнопки и
   жмёт свою, если она не активна. Ставится в <head> — раньше скриптов
   страницы, как и auth.js. */
const LOCK = `<script>
(function () {
    function branchOf(btn) {
        var attr = btn.getAttribute("data-branch");
        if (attr) return attr;
        var m = /switchBranch\\(\\s*['"]([^'"]+)/.exec(btn.getAttribute("onclick") || "");
        return m ? m[1] : "";
    }
    function selectOwn() {
        var btns = document.querySelectorAll(".branch-btn");
        for (var i = 0; i < btns.length; i++) {
            if (branchOf(btns[i]) === "uralsk" && !btns[i].classList.contains("active")) {
                btns[i].click();
            }
        }
    }
    document.addEventListener("DOMContentLoaded", function () {
        selectOwn();
        setTimeout(selectOwn, 800);
    });
})();
</script>`;

const JS = { headers: { "Content-Type": "application/javascript" } };

const localFiles = requestInterceptor((request) => {
    const url = request.url;
    if (/^https?:\/\/(cdn|cdnjs|unpkg)/i.test(url)) return new Response(XLSX_STUB, JS);
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    // auth.js и db-sync.js ходят в сеть — их роль здесь играет LOCK
    if (name === "auth.js" || name === "db-sync.js") return new Response("", JS);
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) return new Response(fs.readFileSync(p, "utf8"), JS);
    return new Response("", JS);
});

function installStubs(window) {
    window.matchMedia = () => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
    });
    window.fetch = async (url) => {
        const name = String(url).split("/").pop().split("?")[0];
        const p = path.join(ROOT, decodeURIComponent(name));
        if (!fs.existsSync(p)) {
            return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        }
        const text = fs.readFileSync(p, "utf8");
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    };
}

console.log("\n── Клик auth.js по своему филиалу до загрузки страницы");

for (const page of PAGES) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    vc.on("error", (...a) => errors.push(String(a[0])));

    const html = fs
        .readFileSync(path.join(ROOT, page), "utf8")
        .replace(/<head>/i, "<head>" + LOCK);

    let dom;
    try {
        dom = new JSDOM(html, {
            runScripts: "dangerously",
            url: "http://localhost/" + page,
            pretendToBeVisual: true,
            virtualConsole: vc,
            resources: { interceptors: [localFiles] },
            beforeParse: installStubs,
        });
    } catch (e) {
        ok(page, false, "не загрузилась: " + e.message);
        continue;
    }
    const win = dom.window;
    await new Promise((r) => win.addEventListener("load", r, { once: true }));
    // таймеры автосохранения страниц — до 1 с, повторный клик — 800 мс
    await new Promise((r) => win.setTimeout(r, 1600));

    const hard = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    const naoKeys = [];
    for (let i = 0; i < win.localStorage.length; i++) {
        const k = win.localStorage.key(i);
        if (/_nao$/.test(k)) naoKeys.push(k);
    }
    const active = [...win.document.querySelectorAll(".branch-btn.active")].map((b) => {
        const attr = b.getAttribute("data-branch");
        if (attr) return attr;
        const m = /switchBranch\(\s*['"]([^'"]+)/.exec(b.getAttribute("onclick") || "");
        return m ? m[1] : "";
    }).filter(Boolean);

    ok(
        page,
        hard.length === 0 && naoKeys.length === 0 && active.join() === "uralsk",
        (hard.length ? "ошибки: " + hard.slice(0, 2).join(" | ").slice(0, 140) + " " : "") +
            (naoKeys.length ? "записаны ключи ЦА: " + naoKeys.join(", ") + " " : "") +
            "активна: " + (active.join(",") || "—"),
    );
    win.close();
}

console.log(`\n${"=".repeat(78)}\nпроверок: ${total}, расхождений: ${failed}`);
process.exit(failed ? 1 : 0);
