/**
 * FINKA Budget System — синхронизация данных с базой.
 *
 * Подключается сразу после auth.js:
 *     <script src="auth.js"></script>
 *     <script src="db-sync.js"></script>
 *
 * Зачем так, а не переписывать страницы: у каждой страницы свои расчёты,
 * сверенные с исходными книгами Excel, и все они читают и пишут
 * localStorage. Модуль подставляет им данные из базы под теми же ключами —
 * страницы про сеть ничего не знают и менять их не нужно.
 *
 * Ключ localStorage вида  rb_svodnaya_almaty  раскладывается в базе на
 * (branch = 'almaty', key = 'rb_svodnaya'). Право читать и писать даёт RLS
 * по роли и филиалу из app_metadata: филиал видит только свой город,
 * администратор и центральный аппарат — все, поэтому консолидация
 * складывает заполненное Алматы с заполненным Астаной.
 *
 * Без сети или без роли страница продолжает работать на localStorage —
 * данные просто не уезжают, о чём говорит значок в шапке.
 */
(function () {
    "use strict";

    var SCHEMA = "budget";
    var TABLE = "kv";
    var BRANCHES = ["nao", "almaty", "astana", "uralsk"];

    // Ключи бюджета. Всё остальное в localStorage (сессия Supabase,
    // настройки браузера) не наше и в базу не уезжает.
    var OURS =
        /^(rb_|pu_|fot|kb_|plan_|spravka_|shtat|osnovaniya|sheet_edits_|budget_year)/;

    var PAGE = location.pathname.split("/").pop() || "index.html";
    var RELOAD_FLAG = "finka_synced_" + PAGE;

    var dirty = Object.create(null);
    var pushTimer = null;
    var client = null;
    var profile = null;
    var lastError = "";

    /* ── Ключ ↔ (филиал, ключ) ─────────────────────────────────── */
    // Общие настройки филиала не имеют и держатся за центральным аппаратом.
    // Список явный: иначе «budget_year» и «rb_svodnaya_nao» при сборке
    // обратно неразличимы — первому суффикс филиала не нужен, второму нужен.
    var GLOBALS = { budget_year: 1, budget_year_end: 1 };

    /* Импорт кладёт лист целиком под ключом вида
       rb_svodnaya_almaty_full — филиал в середине, а не в конце. Без этого
       разбора такой ключ уезжал в «ЦА», и филиал не видел собственный лист. */
    var TAIL = "_full";

    function split(storageKey) {
        if (GLOBALS[storageKey]) return { key: storageKey, branch: "nao" };

        var tail = "";
        var body = storageKey;
        if (body.slice(-TAIL.length) === TAIL) {
            tail = TAIL;
            body = body.slice(0, -TAIL.length);
        }

        for (var i = 0; i < BRANCHES.length; i++) {
            var suffix = "_" + BRANCHES[i];
            if (body.slice(-suffix.length) === suffix) {
                return {
                    key: body.slice(0, -suffix.length) + tail,
                    branch: BRANCHES[i],
                };
            }
        }
        return { key: storageKey, branch: "nao" };
    }

    function join(key, branch) {
        if (GLOBALS[key]) return key;
        if (key.slice(-TAIL.length) === TAIL) {
            return key.slice(0, -TAIL.length) + "_" + branch + TAIL;
        }
        return key + "_" + branch;
    }

    /* ── Значение ↔ jsonb ──────────────────────────────────────── */
    // Разобранный JSON держим как есть — по нему можно делать запросы.
    // Всё, что JSON-ом не является (например год «2026»), заворачиваем,
    // чтобы строка вернулась ровно такой, какой была.
    function encode(raw) {
        try {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") return parsed;
        } catch (e) {
            /* не JSON — ниже */
        }
        return { __raw: String(raw) };
    }

    function decode(value) {
        if (value && typeof value === "object" && "__raw" in value) {
            return String(value.__raw);
        }
        return JSON.stringify(value);
    }

    /* ── Состояние ─────────────────────────────────────────────── */
    /* Показывается в шапке (там, где раньше был объём localStorage), а если
       общей навигации на странице нет — отдельным значком в углу. */
    var badge = null;
    var state = { code: "busy", text: "Загрузка…", rows: 0, branches: [], at: "" };

    function showState(code, text) {
        state.code = code;
        state.text = text;
        paint();
        document.dispatchEvent(
            new CustomEvent("finka:sync", { detail: stats() }),
        );
    }

    function stats() {
        return {
            code: state.code,
            text: state.text,
            rows: state.rows,
            branches: state.branches.slice(),
            at: state.at,
            error: lastError,
        };
    }

    var ICON = { ok: "☁", busy: "⏳", off: "⚠", ro: "👁" };

    function paint() {
        var slot = document.getElementById("finkaSyncState");
        if (slot) {
            if (badge) {
                badge.remove();
                badge = null;
            }
            slot.textContent = ICON[state.code] + " " + state.text;
            slot.title = lastError || describeState();
            return;
        }
        if (!document.body) return;
        if (!badge) {
            badge = document.createElement("div");
            badge.id = "finkaSyncBadge";
            badge.style.cssText =
                "position:fixed;right:14px;bottom:14px;z-index:9997;" +
                "display:flex;align-items:center;gap:7px;padding:6px 12px;" +
                "font:500 11.5px/1 var(--font,system-ui);border-radius:20px;" +
                "background:#fff;border:1px solid #e2e8f0;color:#475569;" +
                "box-shadow:0 2px 8px rgba(15,23,42,.08);cursor:default";
            document.body.appendChild(badge);
        }
        badge.style.borderColor = state.code === "off" ? "#fca5a5" : "#e2e8f0";
        badge.style.color = state.code === "off" ? "#b91c1c" : "#475569";
        badge.textContent = ICON[state.code] + " " + state.text;
        badge.title = lastError || describeState();
    }

    function describeState() {
        if (!state.rows) return "Данные хранятся в базе (схема budget)";
        return (
            "Таблиц в базе: " + state.rows +
            "\nФилиалы: " + (state.branches.join(", ") || "—") +
            (state.at ? "\nОбновлено: " + state.at : "")
        );
    }

    /* ── Чтение из базы ────────────────────────────────────────── */
    function pull() {
        return client
            .schema(SCHEMA)
            .from(TABLE)
            .select("branch,key,value")
            .then(function (res) {
                if (res.error) throw res.error;
                var changed = 0;
                var seen = {};
                (res.data || []).forEach(function (row) {
                    var k = join(row.key, row.branch);
                    var next = decode(row.value);
                    seen[row.branch] = 1;
                    if (localStorage.getItem(k) !== next) {
                        setRaw(k, next);
                        changed++;
                    }
                });
                state.rows = (res.data || []).length;
                state.branches = Object.keys(seen).sort();
                state.at = new Date().toLocaleString("ru-RU");
                return changed;
            });
    }

    /* ── Запись в базу ─────────────────────────────────────────── */
    function push() {
        var keys = Object.keys(dirty);
        if (!keys.length) return Promise.resolve(0);
        dirty = Object.create(null);

        var rows = [];
        var removals = [];
        keys.forEach(function (k) {
            var raw = localStorage.getItem(k);
            var parts = split(k);
            if (raw === null) {
                removals.push(parts);
                return;
            }
            rows.push({ branch: parts.branch, key: parts.key, value: encode(raw) });
        });

        showState("busy", "Сохранение…");

        var jobs = [];
        if (rows.length) {
            jobs.push(
                client
                    .schema(SCHEMA)
                    .from(TABLE)
                    .upsert(rows, { onConflict: "branch,key" }),
            );
        }
        removals.forEach(function (p) {
            jobs.push(
                client
                    .schema(SCHEMA)
                    .from(TABLE)
                    .delete()
                    .eq("branch", p.branch)
                    .eq("key", p.key),
            );
        });

        return Promise.all(jobs).then(function (results) {
            var bad = results.filter(function (r) {
                return r && r.error;
            });
            if (bad.length) {
                lastError = bad[0].error.message || String(bad[0].error);
                // 42501 — RLS не пустила: чужой филиал или роль без права правки
                showState(
                    "off",
                    /row-level security|42501/i.test(lastError)
                        ? "Только чтение"
                        : "Не сохранено",
                );
                return 0;
            }
            lastError = "";
            showState("ok", "Синхронизировано");
            return rows.length + removals.length;
        });
    }

    function schedulePush() {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(function () {
            push().catch(function (err) {
                lastError = String((err && err.message) || err);
                showState("off", "Нет связи");
            });
        }, 1500);
    }

    /* ── Перехват записи ───────────────────────────────────────── */
    // Страницы пишут через localStorage.setItem — подменяем метод, чтобы не
    // трогать код двадцати с лишним страниц. Флаг quiet нужен, чтобы наша
    // же запись при чтении из базы не улетала обратно в базу.
    var quiet = false;

    function setRaw(k, v) {
        quiet = true;
        try {
            localStorage.setItem(k, v);
        } finally {
            quiet = false;
        }
    }

    function hookStorage() {
        var proto = Object.getPrototypeOf(localStorage) || Storage.prototype;
        var setItem = proto.setItem;
        var removeItem = proto.removeItem;

        proto.setItem = function (k, v) {
            setItem.call(this, k, v);
            if (!quiet && this === localStorage && OURS.test(k)) {
                dirty[k] = 1;
                schedulePush();
            }
        };

        proto.removeItem = function (k) {
            removeItem.call(this, k);
            if (!quiet && this === localStorage && OURS.test(k)) {
                dirty[k] = 1;
                schedulePush();
            }
        };
    }

    /* ── Запуск ────────────────────────────────────────────────── */
    function start() {
        if (!window.finkaAuth) return; // страница без авторизации

        Promise.all([window.finkaAuth.getClient(), window.finkaAuth.getProfile()])
            .then(function (pair) {
                client = pair[0];
                profile = pair[1];
                if (!profile || !profile.role) return; // роли нет — база не наша

                hookStorage();

                if (!profile.role.canEdit) showState("ro", "Только чтение");
                else showState("busy", "Загрузка…");

                return pull().then(function (changed) {
                    showState("ok", "Синхронизировано");

                    // Страницы читают localStorage при загрузке, поэтому
                    // пришедшие из базы данные они уже пропустили. Один раз
                    // перезагружаем — флаг в sessionStorage не даёт зациклиться.
                    if (changed && !sessionStorage.getItem(RELOAD_FLAG)) {
                        sessionStorage.setItem(RELOAD_FLAG, "1");
                        location.reload();
                    }
                });
            })
            .catch(function (err) {
                lastError = String((err && err.message) || err);
                showState("off", "Работа без базы");
            });
    }

    // Перед уходом со страницы дописываем то, что не успело уехать
    window.addEventListener("beforeunload", function () {
        if (Object.keys(dirty).length) {
            clearTimeout(pushTimer);
            push();
        }
    });

    window.finkaSync = {
        pull: function () {
            return pull();
        },
        push: function () {
            return push();
        },
        stats: stats,
        // Навигация встраивается позже db-sync, поэтому после её появления
        // состояние надо перерисовать в новое место
        paint: paint,
        state: function () {
            return { profile: profile, lastError: lastError };
        },
        // Раскладка ключей и упаковка значений — на них держится совпадение
        // localStorage с базой, поэтому вынесены наружу для tests/db-sync.mjs
        _split: split,
        _join: join,
        _encode: encode,
        _decode: decode,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
