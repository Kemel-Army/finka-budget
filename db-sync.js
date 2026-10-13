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
 *
 * Как устроена запись (подробности — у функций ниже):
 *   • изменённый ключ попадает в очередь; очередь лежит в localStorage и
 *     переживает перезагрузку и закрытие вкладки;
 *   • ключ уходит из очереди только после того, как база подтвердила
 *     запись; при сбое сети — повтор с нарастающей паузой;
 *   • запись существующей строки условная: «обнови, если updated_at всё ещё
 *     тот, что я видел». Если строку успел поменять кто-то другой, его
 *     правки не затираются — пользователь получает предупреждение;
 *   • ключи, которые RLS этой учётке заведомо не даст записать (чужой
 *     филиал у привязанной к филиалу, депозит), в очередь не ставятся;
 *   • очистить данные только в браузере — finkaSync.clearLocal():
 *     обычный removeItem ушёл бы в базу удалением строки.
 */
(function () {
    "use strict";

    var SCHEMA = "budget";
    var TABLE = "kv";
    var BRANCHES = ["nao", "almaty", "astana", "uralsk"];

    // Ключи бюджета. Всё остальное в localStorage (сессия Supabase,
    // настройки браузера) не наше и в базу не уезжает.
    // rates_ — ставки налогов и отчислений по филиалу (formulas.js): раньше
    // их здесь не было, и изменённые ставки жили только в одном браузере.
    var OURS =
        /^(rb_|pu_|fot|kb_|plan_|spravka_|shtat|osnovaniya|deposit_|sheet_edits_|rates_|budget_year)/;

    var PAGE = location.pathname.split("/").pop() || "index.html";
    var RELOAD_PREFIX = "finka_synced_";
    var RELOAD_FLAG = RELOAD_PREFIX + PAGE;
    // Сколько раз подряд можно перезагрузить страницу из-за свежих данных.
    // Больше — значит, данные меняются по кругу, и лучше спросить человека.
    var MAX_RELOADS = 2;

    /* Служебные ключи. Под OURS не попадают, поэтому сами в базу не уезжают
       и данными страницы не считаются.
         queue  — что изменено и ещё не подтверждено базой;
         known  — какую версию (updated_at) каждой строки мы видели в базе, и
                  отпечаток её значения: по версии запись делается условной,
                  по отпечатку «страница пересохранила то же самое» отличается
                  от настоящей правки;
         notice — предупреждение, которое надо показать после перезагрузки
                  (в sessionStorage);
         finka_conflict_<ключ> — своя версия листа, проигравшая конфликт:
                  её не выбрасываем, чтобы правки можно было восстановить. */
    var QUEUE_KEY = "finka_sync_queue";
    var KNOWN_KEY = "finka_sync_known";
    var NOTICE_KEY = "finka_sync_notice";
    var CONFLICT_PREFIX = "finka_conflict_";

    // Паузы, мс. Повторы ограничены: после последнего очередь остаётся в
    // localStorage и уйдёт при следующей правке, по Ctrl+S, при появлении
    // сети или при следующем открытии страницы.
    var TIMING = {
        debounce: 1500,
        retry: [2000, 5000, 15000, 30000, 60000],
    };

    // Сколько строк просить за раз. Supabase по умолчанию отдаёт не больше
    // 1000 строк на запрос — без постраничного чтения хвост таблицы молча
    // не доезжал бы, а удаление «пропавших из базы» ключей стёрло бы его.
    var PAGE_SIZE = 1000;

    /* ── Чей кэш ───────────────────────────────────────────────── */
    /* localStorage один на браузер, а не на учётную запись. Вошёл
       администратор или Алматы — их данные легли в кэш; следом на том же
       компьютере входит Уральск, и страницы показывают ему алматинские
       таблицы: база через RLS отдаёт только Уральск, но старый кэш никто не
       стирал. Поэтому кэш помечается владельцем, и при входе другого
       пользователя чужие ключи удаляются — синхронно, до того как скрипты
       страницы их прочтут. Сессию Supabase кладёт в localStorage под ключом
       storageKey из auth.js. */
    var OWNER_KEY = "finka_cache_owner";
    var AUTH_KEY = "finka-auth";

    /* ── Ключ ↔ (филиал, ключ) ─────────────────────────────────── */
    // Общие настройки филиала не имеют и держатся за центральным аппаратом.
    // Список явный: иначе «budget_year» и «rb_svodnaya_nao» при сборке
    // обратно неразличимы — первому суффикс филиала не нужен, второму нужен.
    var GLOBALS = { budget_year: 1, budget_year_end: 1 };

    /* Импорт кладёт лист целиком под ключом вида
       rb_svodnaya_almaty_full — филиал в середине, а не в конце. Без этого
       разбора такой ключ уезжал в «ЦА», и филиал не видел собственный лист. */
    var TAIL = "_full";

    /* Старые ключи, которые жили вне синхронизации. Страницы теперь пишут
       под новыми именами; то, что осталось в браузере под старыми,
       переносим один раз при загрузке. */
    var LEGACY = [
        // «СС Алматы» писала ss_almaty_<филиал>, а импорт — pu_ss_almaty_…:
        // ключ без префикса не уезжал в базу, а импорт был не виден странице
        { from: /^ss_almaty_(nao|almaty|astana|uralsk)$/, to: "pu_ss_almaty_$1" },
        // Консолидация доходов — лист центрального аппарата, без филиала
        { from: /^income_svod$/, to: "kb_income_svod_nao" },
    ];

    /* ── Состояние обмена ──────────────────────────────────────── */
    // Ключ → номер правки. Номер нужен, чтобы правка, сделанная, пока
    // предыдущая версия летела в базу, не выпала из очереди вместе с ней.
    var pending = Object.create(null);
    // Ключи, изменённые в этой загрузке до первого чтения из базы. Почти
    // всегда это страница, пересохранившая при открытии устаревший кэш, а
    // не правка человека, — см. pull().
    var early = Object.create(null);
    // Ключ → отпечатки значений, которые ушли в базу, но ответа на которые
    // мы не дождались (сбой сети). Запрос мог дойти: тогда повтор с прежней
    // версией задевает 0 строк, и без этого списка своя же доехавшая запись
    // выглядела бы как «изменено другим пользователем». Живёт, пока ключ в
    // очереди, и сохраняется вместе с ней — переживает перезагрузку.
    var unsure = Object.create(null);
    var known = Object.create(null);
    var inflight = Object.create(null);
    // Ключи, которые страница прочитала: по ним решаем, нужна ли перезагрузка
    var readKeys = Object.create(null);
    var conflicts = [];
    var rev = 0;

    var pushTimer = null;
    var retryTimer = null;
    var attempt = 0;
    var sending = null; // промис текущей отправки
    var again = false;
    var ready = false; // первое чтение из базы прошло
    var disabled = false; // в базу не пишем: нет роли или нет права правки
    var readOnly = false;
    var bootFailed = false;
    var hooked = false;

    var client = null;
    var profile = null;
    var lastError = "";

    // Номер «поколения» локальных данных. clearLocal() его увеличивает:
    // ответ на отправку, начатую до очистки, уже не должен ничего менять
    var epoch = 0;

    /* Трогал ли человек страницу (клавиатура, ввод, мышь) с момента
       загрузки. Запись до первого чтения из базы без участия человека —
       это страница пересохранила кэш при открытии; с участием — настоящая
       правка, и молча выбрасывать её нельзя (см. markDirty и pull). */
    var userTouched = false;

    // Перезагрузка вынесена, чтобы тесты могли её подменить: в jsdom
    // location.reload не реализован
    var hooks = {
        reload: function () {
            location.reload();
        },
    };

    // Свои чтения и записи localStorage не должны ни попадать в очередь,
    // ни считаться «страница прочитала ключ»
    var quiet = false;

    function getRaw(k) {
        var was = quiet;
        quiet = true;
        try {
            return localStorage.getItem(k);
        } finally {
            quiet = was;
        }
    }

    function setRaw(k, v) {
        var was = quiet;
        quiet = true;
        try {
            localStorage.setItem(k, v);
        } finally {
            quiet = was;
        }
    }

    function removeRaw(k) {
        var was = quiet;
        quiet = true;
        try {
            localStorage.removeItem(k);
        } finally {
            quiet = was;
        }
    }

    function sessionUserId() {
        try {
            var s = JSON.parse(getRaw(AUTH_KEY) || "null");
            return (s && s.user && s.user.id) || "";
        } catch (e) {
            return "";
        }
    }

    function isService(k) {
        return (
            k === QUEUE_KEY || k === KNOWN_KEY || k.indexOf(CONFLICT_PREFIX) === 0
        );
    }

    function dropForeignCache() {
        var uid = sessionUserId();
        // Не вошли — не трогаем: auth.js всё равно уведёт на вход
        if (!uid) return false;
        if (getRaw(OWNER_KEY) === uid) return false;

        // Чужой кэш или кэш без владельца (от версии без этой проверки).
        // Запись в базу ещё не перехвачена — удаление туда не уедет.
        // Очередь и версии прошлого пользователя стираем вместе с данными:
        // иначе его неотправленные удаления ушли бы в базу от имени нового.
        var drop = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            // Год бюджета — общая настройка, а не данные филиала
            if ((OURS.test(k) && !GLOBALS[k]) || isService(k)) drop.push(k);
        }
        drop.forEach(function (k) {
            removeRaw(k);
        });
        pending = Object.create(null);
        early = Object.create(null);
        unsure = Object.create(null);
        known = Object.create(null);

        // Отметки «уже перезагружали» прошлого пользователя тоже не наши:
        // без перезагрузки страница так и останется пустой
        try {
            var flags = [];
            for (var j = 0; j < sessionStorage.length; j++) {
                var f = sessionStorage.key(j);
                if (f.indexOf(RELOAD_PREFIX) === 0 || f === NOTICE_KEY) {
                    flags.push(f);
                }
            }
            flags.forEach(function (f) {
                sessionStorage.removeItem(f);
            });
        } catch (e) {
            /* приватный режим */
        }

        setRaw(OWNER_KEY, uid);
        return true;
    }

    /* Перенос старых ключей. Только для своего кэша: если кэш сменил
       владельца, ключи без префикса неизвестно чьи — их просто удаляем. */
    function migrateLegacy(foreign) {
        if (!sessionUserId()) return;
        var found = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            for (var j = 0; j < LEGACY.length; j++) {
                if (LEGACY[j].from.test(k)) {
                    found.push({ from: k, to: k.replace(LEGACY[j].from, LEGACY[j].to) });
                }
            }
        }
        found.forEach(function (m) {
            var old = getRaw(m.from);
            if (!foreign && old !== null && getRaw(m.to) === null) {
                setRaw(m.to, old);
                // Перехват записи ещё не стоит — ставим в очередь сами.
                // Ранней правкой (молча уступающей базе) это НЕ считаем:
                // под старым ключом лежит то, что человек ввёл руками, а
                // в базе под новым может быть лист от старого импорта.
                // Разойдутся — обычный конфликт: в браузер версия из базы,
                // своя — в finka_conflict_<ключ>, и предупреждение.
                pending[m.to] = ++rev;
            }
            removeRaw(m.from);
        });
        if (found.length) saveQueue();
    }

    /* ── Очередь и версии в localStorage ───────────────────────── */
    function loadJson(k) {
        try {
            var v = JSON.parse(getRaw(k) || "null");
            return v && typeof v === "object" ? v : null;
        } catch (e) {
            return null;
        }
    }

    function saveJson(k, obj) {
        try {
            if (Object.keys(obj).length) setRaw(k, JSON.stringify(obj));
            else removeRaw(k);
        } catch (e) {
            /* переполнение localStorage — очередь живёт хотя бы в памяти */
        }
    }

    function saveQueue() {
        var out = {};
        Object.keys(pending).forEach(function (k) {
            out[k] = unsure[k] && unsure[k].length ? unsure[k] : 1;
        });
        saveJson(QUEUE_KEY, out);
    }

    // Ключ больше не ждёт отправки: всё, что о нём помнила очередь, — прочь
    function unqueue(k) {
        delete pending[k];
        delete early[k];
        delete unsure[k];
    }

    /* Версии общие для всех вкладок: localStorage один. Сохраняем только
       то, что поменяли сами, поверх записанного другими вкладками, — иначе
       вкладка со старой картой затирала бы свежие версии соседней, и та
       следующей же записью получала «конфликт» сама с собой. */
    var knownTouched = Object.create(null);

    function setKnown(k, v) {
        if (v) known[k] = v;
        else delete known[k];
        knownTouched[k] = 1;
    }

    function saveKnown() {
        var stored = loadJson(KNOWN_KEY) || {};
        Object.keys(knownTouched).forEach(function (k) {
            if (known[k]) stored[k] = known[k];
            else delete stored[k];
        });
        knownTouched = Object.create(null);
        saveJson(KNOWN_KEY, stored);
    }

    // Подхватить версии, записанные другими вкладками
    function refreshKnown() {
        var stored = loadJson(KNOWN_KEY) || {};
        Object.keys(stored).forEach(function (k) {
            if (stored[k] && stored[k].at && !knownTouched[k]) known[k] = stored[k];
        });
    }

    function restoreState() {
        var q = loadJson(QUEUE_KEY) || {};
        Object.keys(q).forEach(function (k) {
            if (!OURS.test(k) || pending[k]) return;
            pending[k] = ++rev;
            if (Array.isArray(q[k])) unsure[k] = q[k].map(String);
        });
        var kn = loadJson(KNOWN_KEY) || {};
        Object.keys(kn).forEach(function (k) {
            if (kn[k] && kn[k].at) known[k] = kn[k];
        });
    }

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

    /* Сравнение значений по смыслу, а не по строке. jsonb хранит ключи
       объекта в своём порядке, и JSON.stringify ответа базы почти никогда
       не совпадает посимвольно с тем, что записала страница. Сравнивая
       строки, мы бы на каждом открытии считали лист изменившимся — и
       перезагружали страницу по кругу. */
    function canon(v) {
        if (v === null || typeof v !== "object") return JSON.stringify(v);
        if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
        return (
            "{" +
            Object.keys(v)
                .sort()
                .map(function (k) {
                    return JSON.stringify(k) + ":" + canon(v[k]);
                })
                .join(",") +
            "}"
        );
    }

    function canonValue(value) {
        if (value && typeof value === "object" && "__raw" in value) {
            return "r:" + String(value.__raw);
        }
        return canon(value);
    }

    function canonRaw(raw) {
        return canonValue(encode(raw));
    }

    // Короткий отпечаток (djb2 + длина) — хранить в known сами значения дорого
    function hash(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36) + "." + s.length.toString(36);
    }

    function remember(k, row) {
        setKnown(k, { at: row.updated_at, h: hash(canonValue(row.value)) });
    }

    /* Строка в базе — одно из значений, которые мы сами отправляли (sent —
       отпечатки текущей отправки, unsure — прежних, без ответа)? Тогда
       расхождение версии — след нашей же доехавшей записи, а не конфликт. */
    function landed(k, row, sent) {
        if (!row) return false;
        var h = hash(canonValue(row.value));
        var mine = (unsure[k] || []).concat(sent || []);
        return mine.indexOf(h) !== -1;
    }

    /* ── Состояние ─────────────────────────────────────────────── */
    /* Показывается в шапке (там, где раньше был объём localStorage), а если
       общей навигации на странице нет — отдельным значком в углу. */
    var badge = null;
    var state = { code: "busy", text: "Загрузка…", rows: 0, branches: [], at: "" };

    function showState(code, text) {
        // У роли без права правки другого состояния быть не может: auth.js
        // закрыл страницу на запись (enableReadOnly), и «Синхронизировано»
        // после чтения из базы перетирало бы «Только чтение»
        if (readOnly && code !== "off") {
            code = "ro";
            text = "Только чтение";
        }
        state.code = code;
        state.text = text;
        paint();
        document.dispatchEvent(
            new CustomEvent("finka:sync", { detail: stats() }),
        );
    }

    function pendingCount() {
        return Object.keys(pending).length;
    }

    function stats() {
        return {
            code: state.code,
            text: state.text,
            rows: state.rows,
            branches: state.branches.slice(),
            at: state.at,
            error: lastError,
            // Неотправленные ключи, идёт ли отправка, конфликты
            pending: pendingCount(),
            sending: !!sending,
            conflicts: conflicts.slice(),
            readOnly: readOnly,
            ready: ready,
            enabled: !!client && !disabled,
        };
    }

    var ICON = { ok: "☁", busy: "⏳", wait: "⏳", off: "⚠", ro: "👁", conflict: "⚠" };

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
        var bad = state.code === "off" || state.code === "conflict";
        badge.style.borderColor = bad ? "#fca5a5" : "#e2e8f0";
        badge.style.color = bad ? "#b91c1c" : "#475569";
        badge.textContent = ICON[state.code] + " " + state.text;
        badge.title = lastError || describeState();
    }

    function describeState() {
        var out = state.rows
            ? "Таблиц в базе: " + state.rows +
              "\nФилиалы: " + (state.branches.join(", ") || "—") +
              (state.at ? "\nОбновлено: " + state.at : "")
            : "Данные хранятся в базе (схема budget)";
        var n = pendingCount();
        if (n) out += "\nНе отправлено в базу: " + n;
        if (conflicts.length) out += "\nКонфликт правок: " + conflicts.join(", ");
        return out;
    }

    /* Предупреждение пользователю. Тост — если на странице есть общая
       навигация (shared-nav.js); иначе остаётся состояние в значке. Текст
       только свой: сообщение сервера в тост не кладём, оно видно во
       всплывающей подсказке значка. */
    function notify(text, type) {
        if (typeof window.finkaToast === "function") {
            window.finkaToast(text, type || "warning");
        }
    }

    // Предупреждение, отложенное до конца перезагрузки
    function showDeferredNotice() {
        try {
            var text = sessionStorage.getItem(NOTICE_KEY);
            if (!text) return;
            sessionStorage.removeItem(NOTICE_KEY);
            notify(text, "warning");
        } catch (e) {
            /* приватный режим */
        }
    }

    /* ── Перезагрузка страницы ─────────────────────────────────── */
    /* Страницы читают localStorage при загрузке и пришедшие из базы данные
       уже пропустили. Перезагружаем, только если изменился ключ, который
       страница действительно прочитала (перехват getItem ниже): лист,
       который она прочтёт позже — например, при переключении филиала, —
       она и так возьмёт свежим.
       От зацикливания — счётчик подряд идущих перезагрузок в sessionStorage.
       Чтение без изменений по странице его сбрасывает; упёрлись в предел —
       не перезагружаем, а просим обновить страницу вручную. */
    function maybeReload(changedKeys, notice) {
        var hit = changedKeys.filter(function (k) {
            return readKeys[k];
        });
        if (!hit.length) {
            if (notice) notify(notice, "warning");
            return false;
        }
        var n = 0;
        try {
            n = Number(sessionStorage.getItem(RELOAD_FLAG)) || 0;
            if (n >= MAX_RELOADS) {
                notify(
                    (notice ? notice + " " : "") +
                        "Данные в базе обновились — обновите страницу (F5).",
                    "warning",
                );
                return false;
            }
            sessionStorage.setItem(RELOAD_FLAG, String(n + 1));
            if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
        } catch (e) {
            // Без sessionStorage счётчик держать негде — лучше не
            // перезагружать вовсе, чем рисковать циклом
            if (notice) notify(notice, "warning");
            return false;
        }
        hooks.reload();
        return true;
    }

    function resetReloadGuard() {
        try {
            sessionStorage.removeItem(RELOAD_FLAG);
        } catch (e) {
            /* приватный режим */
        }
    }

    /* ── Конфликт ──────────────────────────────────────────────── */
    /* Строку в базе успел поменять (или удалить) кто-то другой. Его правки
       не затираем: в браузер кладём версию из базы, свою — в запасной ключ
       finka_conflict_<ключ>, из очереди ключ убираем. silent — когда своя
       «правка» на деле была пересохранением устаревшего кэша при открытии
       страницы: предупреждать там не о чем. */
    function takeServer(k, row, silent) {
        var mine = getRaw(k);
        if (!silent && mine !== null) {
            try {
                setRaw(CONFLICT_PREFIX + k, mine);
            } catch (e) {
                /* места нет — версию из базы всё равно берём */
            }
        }
        if (row) {
            setRaw(k, decode(row.value));
            remember(k, row);
        } else {
            removeRaw(k);
            setKnown(k, null);
        }
        unqueue(k);
        if (!silent && conflicts.indexOf(k) === -1) conflicts.push(k);
    }

    function conflictNotice(keys) {
        return (
            "Лист изменён в базе другим пользователем (" + keys.join(", ") +
            "). Его правки не перезаписаны: загружена версия из базы, " +
            "ваша копия сохранена в браузере."
        );
    }

    /* ── Чтение из базы ────────────────────────────────────────── */
    var COLS = "branch,key,value,updated_at";

    function table() {
        return client.schema(SCHEMA).from(TABLE);
    }

    function fetchAll(from, acc) {
        return table()
            .select(COLS)
            .order("branch")
            .order("key")
            .range(from, from + PAGE_SIZE - 1)
            .then(function (res) {
                if (res.error) throw res.error;
                var data = res.data || [];
                acc = acc.concat(data);
                // Конец — пустая страница. По «пришло меньше PAGE_SIZE» не
                // останавливаемся: предел на сервере может быть меньше нашего
                return data.length ? fetchAll(from + data.length, acc) : acc;
            });
    }

    /* Возвращает { changed: [ключи], conflicts: [ключи] }.
       Неотправленные ключи не перезаписываются — кроме случая, когда строку
       в базе за это время поменял кто-то другой (см. takeServer). */
    function pull() {
        return fetchAll(0, []).then(function (rows) {
            var changed = [];
            var lost = [];
            var seenBranch = {};
            var seenKey = Object.create(null);

            rows.forEach(function (row) {
                var k = join(row.key, row.branch);
                seenBranch[row.branch] = 1;
                seenKey[k] = 1;

                if (pending[k]) {
                    var base = known[k] && known[k].at;
                    // Правка сделана поверх той же версии — её и отправим
                    if (base && base === row.updated_at) return;
                    if (inflight[k]) return; // разберётся ответ на отправку
                    // Совпало по смыслу — отправлять нечего
                    if (canonRaw(getRaw(k)) === canonValue(row.value)) {
                        remember(k, row);
                        unqueue(k);
                        return;
                    }
                    // В базе — наше же значение, отправленное раньше, ответ
                    // на которое потерялся. Это не чужая правка: запоминаем
                    // новую версию, а более поздние правки отправим от неё
                    if (landed(k, row)) {
                        remember(k, row);
                        delete unsure[k];
                        return;
                    }
                    // Пересохранение устаревшего кэша — молча берём базу;
                    // правка человека (из прошлой сессии, перенесённая из
                    // старого ключа, сделанная до конца чтения) — конфликт
                    var silent = !!early[k];
                    takeServer(k, row, silent);
                    changed.push(k);
                    if (!silent) lost.push(k);
                    return;
                }

                var local = getRaw(k);
                if (local === null || canonRaw(local) !== canonValue(row.value)) {
                    setRaw(k, decode(row.value));
                    changed.push(k);
                }
                remember(k, row);
            });

            /* Строки, удалённые в базе. Удаляем локально только то, что мы
               раньше видели в базе (есть в known). Ключа, которого в known
               нет, в базе могло не быть никогда — данные из версии без
               синхронизации, из сессии без сети, только что перенесённый
               старый ключ, — и удаление при первом же чтении его бы
               потеряло. Не трогаем неотправленное (его судьбу решит
               отправка) и общие настройки: у филиала нет права читать
               строку ЦА, а значение по умолчанию у страницы своё.
               Пустой ответ при непустом known удалением всего не считаем:
               это скорее сбой прав, чем чистка базы. */
            var knownKeys = Object.keys(known);
            if (rows.length || !knownKeys.length) {
                knownKeys.forEach(function (k) {
                    if (seenKey[k] || pending[k]) return;
                    setKnown(k, null);
                    if (GLOBALS[k] || !OURS.test(k)) return;
                    if (getRaw(k) !== null) {
                        removeRaw(k);
                        changed.push(k);
                    }
                });
            }

            saveKnown();
            saveQueue();
            state.rows = rows.length;
            state.branches = Object.keys(seenBranch).sort();
            state.at = new Date().toLocaleString("ru-RU");
            return { changed: changed, conflicts: lost };
        });
    }

    /* ── Запись в базу ─────────────────────────────────────────── */
    // Что делать с ошибкой: повторить позже, отказ в правах или отказ по
    // данным (повтор не поможет)
    function classify(err) {
        var code = String((err && err.code) || "");
        var msg = String((err && err.message) || err || "");
        if (code === "42501" || /row-level security/i.test(msg)) return "denied";
        if (code === "23505") return "conflict";
        // Классы 22 (данные), 23 (ограничения), 42 (запрос) — повтор не
        // поможет. Прочее — сеть, таймаут, истёкший токен, 5xx — повторяем.
        if (/^(22|23|42)/.test(code)) return "rejected";
        return "retry";
    }

    function fail(k, err) {
        return { k: k, result: classify(err), error: err };
    }

    function fetchRow(parts) {
        return table()
            .select(COLS)
            .eq("branch", parts.branch)
            .eq("key", parts.key)
            .then(function (res) {
                if (res.error) throw res.error;
                return (res.data && res.data[0]) || null;
            });
    }

    /* В базе лежит наше же значение — запись на деле прошла (ответ на неё
       потерялся). Если с тех пор лист правили ещё, ключ остаётся в очереди
       (stale) и уйдёт следующей отправкой — уже условно от этой версии. */
    function ours(k, row, raw) {
        var same = raw !== null && canonValue(row.value) === canonRaw(raw);
        return { k: k, result: "ok", row: row, stale: !same };
    }

    function insertRow(k, parts, raw, sent) {
        return table()
            .insert({ branch: parts.branch, key: parts.key, value: encode(raw) })
            .select(COLS)
            .then(function (res) {
                if (!res.error) {
                    return { k: k, result: "ok", row: res.data && res.data[0] };
                }
                var f = fail(k, res.error);
                if (f.result !== "conflict") return f;
                // Строка уже есть. Если в ней наше значение — это наша же
                // прошлая вставка, ответ на которую не дошёл; иначе её
                // успел создать кто-то другой — конфликт
                return fetchRow(parts).then(function (row) {
                    if (landed(k, row, sent)) return ours(k, row, raw);
                    return { k: k, result: "conflict", row: row };
                });
            });
    }

    /* Запись или удаление не задели ни одной строки. Причин три: строку
       поменяли (конфликт), удалили, или RLS не пустила — PostgREST в
       последнем случае ошибки не возвращает, просто 0 строк. Различаем
       по тому, что сейчас лежит в базе.
       Четвёртая причина — наша же прошлая запись: запрос дошёл, ответ
       потерялся (Failed to fetch), и повтор с прежним updated_at уже ничего
       не находит. Её узнаём по значению: в базе лежит то, что мы слали. */
    function probe(k, parts, raw, base, sent) {
        return fetchRow(parts).then(function (row) {
            if (!row) {
                if (raw === null) return { k: k, result: "ok", row: null };
                // Лист удалили, а у нас правки — восстанавливаем его: так
                // ничего чужого не затирается
                return insertRow(k, parts, raw, sent);
            }
            if (row.updated_at === base) return { k: k, result: "denied" };
            if (landed(k, row, sent)) return ours(k, row, raw);
            return { k: k, result: "conflict", row: row };
        });
    }

    function sendOne(k, raw) {
        var parts = split(k);
        var base = known[k] && known[k].at;
        // Отпечаток того, что отправляем сейчас: по нему probe узнает свою
        // запись, если ответ на неё не дойдёт и придётся повторять
        var sent = raw === null ? [] : [hash(canonRaw(raw))];

        if (raw === null) {
            // Ключ ни разу не видели в базе — удалять там нечего. Удалять
            // без версии нельзя: строку мог создать кто-то после нашего чтения.
            if (!base) return Promise.resolve({ k: k, result: "ok", row: null });
            return table()
                .delete()
                .eq("branch", parts.branch)
                .eq("key", parts.key)
                .eq("updated_at", base)
                .select("updated_at")
                .then(function (res) {
                    if (res.error) return fail(k, res.error);
                    if (res.data && res.data.length) {
                        return { k: k, result: "ok", row: null };
                    }
                    return probe(k, parts, raw, base, sent);
                });
        }

        if (!base) return insertRow(k, parts, raw, sent);

        // updated_at выставляет триггер budget.stamp() при каждой записи,
        // поэтому новую версию берём из ответа (.select), а не из часов
        // браузера
        return table()
            .update({ value: encode(raw) })
            .eq("branch", parts.branch)
            .eq("key", parts.key)
            .eq("updated_at", base)
            .select(COLS)
            .then(function (res) {
                if (res.error) return fail(k, res.error);
                if (res.data && res.data.length) {
                    return { k: k, result: "ok", row: res.data[0] };
                }
                return probe(k, parts, raw, base, sent);
            });
    }

    function push() {
        if (!client || disabled || !ready) return Promise.resolve(stats());
        if (sending) {
            again = true;
            return sending;
        }
        clearTimeout(pushTimer);
        clearTimeout(retryTimer);

        var keys = Object.keys(pending);
        if (!keys.length) return Promise.resolve(stats());
        refreshKnown();

        var gen = epoch;
        var sent = {};
        var jobs = keys.map(function (k) {
            var raw = getRaw(k);
            sent[k] = { rev: pending[k], raw: raw };
            inflight[k] = 1;
            var job;
            try {
                job = sendOne(k, raw);
            } catch (e) {
                job = Promise.reject(e);
            }
            return job.catch(function (err) {
                return fail(k, err);
            });
        });

        showState("busy", "Сохранение…");

        sending = Promise.all(jobs).then(function (results) {
            if (gen !== epoch) {
                // Пока летел ответ, данные в браузере очистили (clearLocal):
                // версии и очередь, которые он принёс, уже не про них
                sending = null;
                if (pendingCount()) schedulePush();
                return stats();
            }
            var retry = 0;
            var denied = [];
            var rejected = [];
            var lost = [];
            lastError = "";

            results.forEach(function (r) {
                var k = r.k;
                var s = sent[k];
                delete inflight[k];
                // Пока летел ответ, ключ правили ещё раз — тогда он остаётся
                // в очереди, уже с новой версией за основу
                var untouched = pending[k] === s.rev;

                if (r.result === "ok") {
                    if (r.row && r.row.updated_at) {
                        // stale — в базе наше прежнее значение, а не это
                        var h = r.stale
                            ? hash(canonValue(r.row.value))
                            : hash(canonRaw(s.raw));
                        setKnown(k, { at: r.row.updated_at, h: h });
                    } else {
                        setKnown(k, null);
                    }
                    // Что лежит в базе, теперь известно точно
                    delete unsure[k];
                    // stale: доехала прежняя версия, а эта — ещё нет; ключ
                    // остаётся в очереди и уйдёт от новой версии
                    if (untouched && !r.stale) unqueue(k);
                    return;
                }
                if (r.error) lastError = String(r.error.message || r.error);

                if (r.result === "conflict") {
                    takeServer(k, r.row || null, false);
                    lost.push(k);
                } else if (r.result === "denied" || r.result === "rejected") {
                    // Повтор не поможет. Из очереди убираем, иначе ключ
                    // навсегда закрылся бы для обновлений из базы
                    if (untouched) unqueue(k);
                    (r.result === "denied" ? denied : rejected).push(k);
                } else {
                    // Ответа нет — запрос мог и дойти. Запоминаем отпечаток
                    // отправленного: если при повторе в базе окажется ровно
                    // оно, это наша запись, а не чужая (см. probe)
                    if (s.raw !== null && pending[k]) {
                        var list = unsure[k] || (unsure[k] = []);
                        var mine = hash(canonRaw(s.raw));
                        if (list.indexOf(mine) === -1) list.push(mine);
                        // Хватит последних: без связи человек может успеть
                        // сохранить лист много раз
                        if (list.length > 20) list.shift();
                    }
                    retry++;
                }
            });

            saveKnown();
            saveQueue();
            sending = null;

            if (lost.length) {
                lastError = "Конфликт правок: " + lost.join(", ");
                showState("conflict", "Конфликт правок");
                maybeReload(lost, conflictNotice(lost));
            } else if (denied.length) {
                lastError = lastError || "Нет права записи: " + denied.join(", ");
                showState("off", "Нет права записи");
            } else if (rejected.length) {
                showState("off", "Не сохранено");
            }

            if (retry) {
                scheduleRetry();
            } else {
                attempt = 0;
                if (!lost.length && !denied.length && !rejected.length) {
                    showState("ok", "Синхронизировано");
                }
                if (again || pendingCount()) {
                    again = false;
                    schedulePush();
                }
            }
            return stats();
        });
        return sending;
    }

    function scheduleRetry() {
        again = false;
        if (attempt >= TIMING.retry.length) {
            // Пауз больше нет. Очередь в localStorage — уйдёт при следующей
            // правке, по Ctrl+S, при появлении сети или открытии страницы
            attempt = 0;
            showState("off", "Не сохранено: нет связи (" + pendingCount() + ")");
            return;
        }
        var delay = TIMING.retry[attempt++];
        showState("wait", "Нет связи, повтор через " + Math.ceil(delay / 1000) + " с");
        clearTimeout(retryTimer);
        retryTimer = setTimeout(push, delay);
    }

    function schedulePush() {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(push, TIMING.debounce);
    }

    // Отправить всё сейчас: Ctrl+S, уход со страницы, вернулась сеть.
    // Если отправка уже идёт — дождаться её и отправить накопившееся после.
    function flush() {
        clearTimeout(pushTimer);
        clearTimeout(retryTimer);
        attempt = 0;
        if (bootFailed) {
            // При открытии страницы базы не было — пробуем подключиться снова
            bootFailed = false;
            return start().then(push);
        }
        if (sending) {
            return sending.then(push);
        }
        return push();
    }

    /* ── Перехват записи и чтения ──────────────────────────────── */
    /* RLS заведомо не даст этой учётке записать ключ (см. budget.
       can_write_branch и budget.can_touch_key в supabase/migrations
       0001 и 0003). Такие записи страниц — пересохранение при открытии
       (год бюджета на главной, лист филиала после switchBranch, который
       жмёт auth.js) — в очередь не ставим вовсе: иначе каждое открытие
       страницы давало бы 42501 и красный значок «Нет права записи».
       Молчим только там, где правка человека невозможна по интерфейсу:
         • депозит — пишут лишь администратор и «Работа (огранич.)» ЦА;
         • чужой филиал (и общие настройки — они в строке ЦА) у учётки,
           привязанной к филиалу: auth.js не даёт ей переключить город.
       «Работа» из ЦА видит все города, и её правку чужого города RLS тоже
       не пропустит, — но там это может быть настоящий ввод, и о нём лучше
       сказать значком, чем молча потерять. Профиль ещё не пришёл — решим в
       start(), когда он будет. */
    var DEPOSIT = /^deposit(_|$)/;

    function refused(k) {
        if (!profile || !profile.role) return false;
        var role = profile.roleKey;
        var parts = split(k);
        if (DEPOSIT.test(parts.key)) {
            var bookkeeper =
                role === "admin" || (role === "limited" && profile.branchKey === "nao");
            if (!bookkeeper) return true;
        }
        if (role === "admin") return false;
        return !!profile.branchLocked && parts.branch !== profile.branchKey;
    }

    // Страницы пишут через localStorage.setItem — подменяем метод, чтобы не
    // трогать код двадцати с лишним страниц. Флаг quiet нужен, чтобы наша
    // же запись при чтении из базы не улетала обратно в базу.
    function markDirty(k) {
        if (disabled) return;
        if (refused(k)) {
            if (pending[k]) {
                unqueue(k);
                saveQueue();
            }
            return;
        }
        // Пока у ключа есть отправка без ответа, база могла уже принять
        // новое значение — тогда known устарел, и сверять с ним нельзя
        if (!inflight[k] && known[k] && !unsure[k]) {
            var raw = getRaw(k);
            // Страница пересохранила ровно то, что лежит в базе, — это не
            // правка: в очередь не ставим и обновления из базы не блокируем
            if (raw !== null && hash(canonRaw(raw)) === known[k].h) {
                if (pending[k]) {
                    unqueue(k);
                    saveQueue();
                }
                return;
            }
        }
        // «Ранняя» запись — до первого чтения из базы и без участия
        // человека: страница пересохранила при открытии устаревший кэш, и
        // при расхождении с базой молча уступит ей (см. pull). Если человек
        // уже что-то вводил, это может быть его правка — тогда обычный
        // конфликт с запасной копией и предупреждением, а не тихая потеря
        if (!pending[k] && !ready && !userTouched) early[k] = 1;
        if (ready || userTouched) delete early[k];
        pending[k] = ++rev;
        saveQueue();
        schedulePush();
    }

    /* Отметка «человек трогал страницу». Слушаем на document в фазе
       перехвата — раньше обработчиков страницы, которые сохраняют лист.
       click не берём: auth.js сам жмёт кнопку филиала (lockBranch), а
       mousedown программный .click() не вызывает. */
    function watchUser() {
        var mark = function () {
            userTouched = true;
        };
        ["keydown", "input", "change", "paste", "cut", "drop", "mousedown", "touchstart"].forEach(
            function (type) {
                document.addEventListener(type, mark, true);
            },
        );
    }

    function hookStorage() {
        if (hooked) return;
        hooked = true;
        var proto = Object.getPrototypeOf(localStorage) || Storage.prototype;
        var setItem = proto.setItem;
        var removeItem = proto.removeItem;
        var getItem = proto.getItem;

        proto.setItem = function (k, v) {
            setItem.call(this, k, v);
            if (!quiet && this === localStorage && OURS.test(k)) markDirty(k);
        };

        proto.removeItem = function (k) {
            removeItem.call(this, k);
            if (!quiet && this === localStorage && OURS.test(k)) markDirty(k);
        };

        // Какие ключи читает страница — по ним решается перезагрузка
        proto.getItem = function (k) {
            if (!quiet && this === localStorage && OURS.test(k)) readKeys[k] = 1;
            return getItem.call(this, k);
        };
    }

    /* ── Запуск ────────────────────────────────────────────────── */
    function stop(code, text) {
        disabled = true;
        pending = Object.create(null);
        early = Object.create(null);
        unsure = Object.create(null);
        saveQueue();
        if (code) showState(code, text);
    }

    // Записи, сделанные до прихода профиля (перехват стоит с загрузки
    // модуля), и очередь прошлой сессии: то, что RLS этой учётке заведомо
    // не пропустит, выбрасываем молча — см. refused()
    function dropRefused() {
        var dropped = false;
        Object.keys(pending).forEach(function (k) {
            if (refused(k)) {
                unqueue(k);
                dropped = true;
            }
        });
        if (dropped) saveQueue();
    }

    /* Очистить данные бюджета в этом браузере — и только в нём. Обычный
       localStorage.removeItem перехвачен и каждое удаление отправил бы в
       базу как DELETE строки (у администратора — всех филиалов), поэтому
       удаляем в обход перехвата. Вместе с данными забываем версии и
       очередь: при следующем открытии страницы всё придёт из базы заново.
       Год бюджета — общая настройка, не данные, его не трогаем; запасные
       копии конфликтов (finka_conflict_*) тоже — их в базе нет, и это
       единственный экземпляр проигравших правок.
       Возвращает число удалённых ключей. */
    function clearLocal() {
        var drop = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (OURS.test(k) && !GLOBALS[k]) drop.push(k);
        }
        drop.forEach(function (k) {
            removeRaw(k);
        });
        epoch++;
        clearTimeout(pushTimer);
        clearTimeout(retryTimer);
        attempt = 0;
        pending = Object.create(null);
        early = Object.create(null);
        unsure = Object.create(null);
        inflight = Object.create(null);
        known = Object.create(null);
        knownTouched = Object.create(null);
        removeRaw(QUEUE_KEY);
        removeRaw(KNOWN_KEY);
        if (!disabled && client) showState("ok", "Синхронизировано");
        return drop.length;
    }

    function start() {
        if (!window.finkaAuth) return Promise.resolve(); // страница без авторизации

        return Promise.all([window.finkaAuth.getClient(), window.finkaAuth.getProfile()])
            .then(function (pair) {
                client = pair[0];
                profile = pair[1];
                if (!profile || !profile.role) {
                    // роли нет — база не наша
                    client = null;
                    stop();
                    return;
                }

                if (!profile.role.canEdit) {
                    // Правки такой роли RLS в базу не пустит. Не копим их в
                    // очереди: неотправляемый ключ навсегда закрылся бы для
                    // обновлений из базы
                    readOnly = true;
                    stop("ro", "Только чтение");
                } else {
                    showState("busy", "Загрузка…");
                    dropRefused();
                }

                return pull().then(function (res) {
                    ready = true;
                    early = Object.create(null);
                    showState("ok", "Синхронизировано");
                    showDeferredNotice();

                    var notice = "";
                    if (res.conflicts.length) {
                        notice = conflictNotice(res.conflicts);
                        lastError = "Конфликт правок: " + res.conflicts.join(", ");
                        showState("conflict", "Конфликт правок");
                    }
                    if (maybeReload(res.changed, notice)) return;

                    // Чтение не изменило ничего на странице — цикл
                    // перезагрузок, если и был, закончился
                    var hit = res.changed.some(function (k) {
                        return readKeys[k];
                    });
                    if (!hit) resetReloadGuard();

                    if (pendingCount()) return push();
                });
            })
            .catch(function (err) {
                bootFailed = true;
                lastError = String((err && err.message) || err);
                showState("off", "Работа без базы");
            });
    }

    /* ── Инициализация ─────────────────────────────────────────── */
    try {
        var foreign = dropForeignCache();
        restoreState();
        migrateLegacy(foreign);
        // Перехват ставим сразу, ещё до ответа auth: страницы читают и
        // пересохраняют данные на DOMContentLoaded, и это надо видеть. Если
        // роли не окажется, start() очередь очистит.
        if (window.finkaAuth) {
            hookStorage();
            watchUser();
        }
    } catch (e) {
        /* localStorage недоступен — страница работает как работала */
    }

    // Перед уходом со страницы пробуем дописать то, что не успело уехать.
    // Не успеет — очередь лежит в localStorage и уйдёт при следующем открытии.
    window.addEventListener("beforeunload", function () {
        if (pendingCount()) flush();
    });

    // Сеть вернулась — не ждём следующей паузы
    window.addEventListener("online", function () {
        if (pendingCount() || bootFailed) flush();
    });

    window.finkaSync = {
        pull: function () {
            return pull();
        },
        push: function () {
            return push();
        },
        // Отправить очередь немедленно; промис вернёт status()
        flush: flush,
        // Удалить данные бюджета только из этого браузера, ничего не
        // отправляя в базу; вернёт число удалённых ключей
        clearLocal: clearLocal,
        // Есть ли неотправленное, идёт ли отправка, ошибка, конфликт
        status: stats,
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
        _canon: canonRaw,
        _dropForeignCache: dropForeignCache,
        _timing: TIMING,
        _hooks: hooks,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
