/**
 * FINKA Budget System — Supabase Auth Guard + ролевой доступ
 *
 * Подключается одной строкой в <head> каждой страницы:
 *     <script src="auth.js"></script>
 *
 * Что делает:
 *   1. Прячет содержимое страницы, пока сессия не проверена.
 *   2. Без сессии — редирект на login.html?next=<текущая страница>.
 *   3. Проверяет роль: закрытые для роли страницы не открываются.
 *   4. Для ролей без права правки включает режим «только просмотр».
 *   5. Привязывает пользователя к своему филиалу, если он не из ЦА.
 *   6. Рисует бейдж пользователя с ролью и кнопку «Выйти».
 *
 * Роль и филиал хранятся в app_metadata пользователя Supabase. Это поле
 * пишется только service_role-ключом с сервера и попадает в JWT, поэтому
 * пользователь не может подменить себе роль из браузера.
 *
 * ВАЖНО: это ограничение интерфейса, а не защита данных. Сами данные лежат
 * в схеме budget той же базы и закрыты политиками RLS: филиал читает и пишет
 * только свой город, администратор и центральный аппарат — все филиалы
 * (см. supabase/migrations/0001_budget_schema.sql). localStorage остался
 * кэшем, через который работают страницы.
 *
 * URL и publishable-ключ публичные по дизайну Supabase.
 * Secret / service_role ключ здесь быть НЕ ДОЛЖЕН.
 */
(function () {
    "use strict";

    var SUPABASE_URL = "https://fdzwvwapcxoxllfqaoxw.supabase.co";
    var SUPABASE_ANON_KEY = "sb_publishable_ksFJ2xPiZXRTqk2l77NkMg_DSbD60u2";
    var SDK_URL =
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
    var LOGIN_PAGE = "login.html";
    var HOME_PAGE = "index.html";
    var STORAGE_KEY = "finka-auth";

    /* ── Страницы по группам ───────────────────────────────────── */
    var PAGES = {
        kb: ["kb-svod.html"],
        rb: [
            "rb-svod.html",
            "rb-svodnaya.html",
            "rb-income.html",
            "rb-fzp.html",
            "rb-kalkulyacia.html",
            "rb-plan-komandir.html",
        ],
        pu: [
            "pu-svod-2026.html",
            "pu-income-pu.html",
            "pu-income-dt.html",
            "pu-income-dop.html",
            "pu-ss-almaty.html",
            "pu-ss-dotacia.html",
            "pu-fot-almaty.html",
            "pu-grafik-almaty.html",
            "pu-kalkulyacia-almaty.html",
            "pu-plan-rk.html",
            "pu-plan-abroad.html",
            "plan-fact-pu.html",
            "plan-fact-dt.html",
            "plan-fact-pu-dt.html",
        ],
        common: [
            "index.html",
            "dashboard.html",
            "index-budget.html",
            "business-process.html",
            "plan-fact.html",
            "fot-consolidation.html",
            "fot-almaty.html",
            "income-consolidation.html",
            "plan-finansirovaniya.html",
            "spravki.html",
            "shtatnoe.html",
            "osnovaniya.html",
        ],
        tools: ["import-excel.html"],
    };

    function group() {
        var out = [];
        for (var i = 0; i < arguments.length; i++) {
            out = out.concat(PAGES[arguments[i]]);
        }
        return out;
    }

    /* ── Роли ──────────────────────────────────────────────────── */
    var ROLES = {
        admin: {
            label: "Администратор",
            zone: "Администрирование системы",
            canEdit: true,
            canImport: true,
            canExport: true,
            pages: null, // null = все страницы
        },
        view: {
            label: "Просмотр",
            zone: "Зона просмотра / полный доступ для контроля",
            canEdit: false,
            canImport: false,
            canExport: true,
            pages: null,
        },
        edit: {
            label: "Работа",
            zone: "Зона работы / полный доступ",
            canEdit: true,
            canImport: true,
            canExport: true,
            pages: null,
        },
        limited: {
            label: "Работа (огранич.)",
            zone: "Зона работы / ограниченный доступ",
            canEdit: true,
            canImport: false,
            canExport: true,
            pages: group("common", "rb", "pu"), // без КБ и без импорта
        },
        initiator: {
            label: "Инициатор",
            zone: "Заявки-потребности по своему филиалу",
            canEdit: false,
            canImport: false,
            canExport: false,
            pages: ["index.html", "dashboard.html"].concat(PAGES.pu),
        },
    };

    // Роли по умолчанию НЕТ. Этот проект Supabase общий с другими сервисами
    // (в нём тысячи посторонних учётных записей), поэтому пользователь без
    // явно проставленной роли в app_metadata доступа к бюджету не получает.
    var DEFAULT_ROLE = null;

    /* ── Филиалы ───────────────────────────────────────────────── */
    var BRANCHES = {
        nao: "НАО «РФМШ» (центральный аппарат)",
        almaty: "Филиал Алматы",
        astana: "Филиал Астана",
        uralsk: "Филиал Уральск",
    };

    var currentPage = location.pathname.split("/").pop() || "index.html";
    var isLoginPage = currentPage === LOGIN_PAGE;

    /* ── Скрываем страницу до проверки сессии ──────────────────── */
    var GATE_CLASS = "finka-auth-pending";
    if (!isLoginPage) {
        document.documentElement.classList.add(GATE_CLASS);
        var gateStyle = document.createElement("style");
        gateStyle.textContent =
            "." + GATE_CLASS + " body { visibility: hidden; }";
        (document.head || document.documentElement).appendChild(gateStyle);
        // Страховка: если SDK не загрузился за 10 с — показать страницу,
        // чтобы пользователь не смотрел в белый экран.
        setTimeout(revealPage, 10000);
    }

    function revealPage() {
        document.documentElement.classList.remove(GATE_CLASS);
    }

    /* ── Загрузка SDK ──────────────────────────────────────────── */
    var sdkPromise = null;

    function loadSdk() {
        if (sdkPromise) return sdkPromise;
        sdkPromise = new Promise(function (resolve, reject) {
            if (window.supabase && window.supabase.createClient) {
                resolve(window.supabase);
                return;
            }
            var el = document.createElement("script");
            el.src = SDK_URL;
            el.async = true;
            el.onload = function () {
                if (window.supabase && window.supabase.createClient) {
                    resolve(window.supabase);
                } else {
                    reject(new Error("Supabase SDK загружен, но недоступен"));
                }
            };
            el.onerror = function () {
                reject(new Error("Не удалось загрузить Supabase SDK"));
            };
            (document.head || document.documentElement).appendChild(el);
        });
        return sdkPromise;
    }

    /* ── Клиент ────────────────────────────────────────────────── */
    var client = null;

    function getClient() {
        return loadSdk().then(function (sdk) {
            if (!client) {
                client = sdk.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true,
                        storageKey: STORAGE_KEY,
                    },
                });
            }
            return client;
        });
    }

    /* ── Профиль из JWT ────────────────────────────────────────── */
    function profileOf(user) {
        var meta = (user && user.app_metadata) || {};
        var roleKey = ROLES[meta.role] ? meta.role : DEFAULT_ROLE;
        var branchKey = BRANCHES[meta.branch] ? meta.branch : "nao";
        return {
            email: (user && user.email) || "",
            title: meta.title || "",
            roleKey: roleKey,
            role: roleKey ? ROLES[roleKey] : null,
            branchKey: branchKey,
            branch: BRANCHES[branchKey],
            branchLocked: branchKey !== "nao",
        };
    }

    function canOpen(profile, page) {
        if (!profile.role) return false;
        if (!profile.role.pages) return true;
        return profile.role.pages.indexOf(page) !== -1;
    }

    /* ── Проверка сессии ───────────────────────────────────────── */
    var ready = getClient()
        .then(function (c) {
            return c.auth.getSession().then(function (res) {
                var session = res.data.session || null;
                return {
                    client: c,
                    session: session,
                    profile: session ? profileOf(session.user) : null,
                };
            });
        })
        .catch(function (err) {
            revealPage();
            throw err;
        });

    function loginUrl() {
        var next = currentPage + location.search + location.hash;
        return LOGIN_PAGE + "?next=" + encodeURIComponent(next);
    }

    function signOut() {
        return getClient()
            .then(function (c) {
                return c.auth.signOut();
            })
            .then(function () {
                location.replace(LOGIN_PAGE);
            });
    }

    /* ── Стили ─────────────────────────────────────────────────── */
    function injectStyles() {
        if (document.getElementById("finkaAuthStyles")) return;
        var css = document.createElement("style");
        css.id = "finkaAuthStyles";
        css.textContent = [
            /* «Вы вошли» — своя всплывашка: на главной навигации нет,
               значит и finkaToast там не существует */
            ".finka-hello{position:fixed;right:18px;bottom:62px;z-index:10000;",
            "display:flex;align-items:flex-start;gap:10px;max-width:340px;",
            "padding:12px 16px;border-radius:12px;",
            "background:#0f172a;color:#e2e8f0;font:400 13px/1.4 var(--font,system-ui);",
            "box-shadow:0 10px 30px rgba(15,23,42,.3);",
            "opacity:0;transform:translateY(10px);transition:all 260ms ease}",
            ".finka-hello.show{opacity:1;transform:none}",
            ".finka-hello strong{display:block;color:#fff;font-weight:650}",
            ".finka-hello-sub{display:block;margin-top:2px;font-size:11.5px;color:#94a3b8}",
            ".finka-hello-mark{flex:0 0 20px;height:20px;border-radius:50%;",
            "display:flex;align-items:center;justify-content:center;",
            "background:#10b981;color:#fff;font-size:12px;font-weight:800}",
            "@media print{.finka-hello{display:none}}",
            ".finka-user{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;",
            "background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);",
            "border-radius:10px;font-size:13px;color:#e2e8f0;max-width:320px}",
            ".finka-user-avatar{width:26px;height:26px;border-radius:50%;flex-shrink:0;",
            "display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;",
            "color:#fff;background:linear-gradient(135deg,#4f46e5,#7c3aed)}",
            ".finka-user-info{display:flex;flex-direction:column;line-height:1.25;overflow:hidden}",
            ".finka-user-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
            ".finka-user-role{font-size:11px;color:#94a3b8;overflow:hidden;",
            "text-overflow:ellipsis;white-space:nowrap}",
            ".finka-user-logout{border:0;background:transparent;color:#94a3b8;cursor:pointer;",
            "font:inherit;font-size:13px;padding:2px 6px;border-radius:6px;transition:all 150ms ease}",
            ".finka-user-logout:hover{background:rgba(239,68,68,.18);color:#fca5a5}",
            ".finka-user--floating{position:fixed;top:12px;right:16px;z-index:9999;",
            "background:#1e293b;box-shadow:0 4px 6px -1px rgba(0,0,0,.2)}",
            "@media(max-width:640px){.finka-user-info{display:none}}",
            ".finka-ro-banner{position:sticky;top:0;z-index:9998;display:flex;align-items:center;",
            "justify-content:center;gap:8px;padding:7px 14px;font-size:13px;font-weight:500;",
            "background:#fef3c7;color:#92400e;border-bottom:1px solid #fde68a}",
            ".finka-denied{max-width:520px;margin:80px auto;padding:32px;background:#fff;",
            "border-radius:12px;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);text-align:center;",
            "font-family:'Inter','Segoe UI',system-ui,sans-serif;color:#374151}",
            ".finka-denied h1{font-size:19px;color:#111827;margin-bottom:10px}",
            ".finka-denied p{font-size:14px;line-height:1.6;margin-bottom:20px;color:#6b7280}",
            ".finka-denied a{display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;",
            "text-decoration:none;border-radius:8px;font-size:14px;font-weight:600}",
        ].join("");
        (document.head || document.documentElement).appendChild(css);
    }

    /* ── Бейдж пользователя ────────────────────────────────────── */
    function buildBadge(profile) {
        var email = profile.email || "Пользователь";
        var box = document.createElement("div");
        box.className = "finka-user";

        var avatar = document.createElement("span");
        avatar.className = "finka-user-avatar";
        avatar.textContent = email.charAt(0).toUpperCase();

        var info = document.createElement("span");
        info.className = "finka-user-info";

        var line1 = document.createElement("span");
        line1.className = "finka-user-email";
        line1.textContent = email;

        var line2 = document.createElement("span");
        line2.className = "finka-user-role";
        line2.textContent =
            profile.role.label +
            (profile.branchLocked ? " · " + profile.branch : "");

        info.appendChild(line1);
        info.appendChild(line2);
        box.title = profile.role.zone + "\n" + profile.branch;

        var out = document.createElement("button");
        out.type = "button";
        out.className = "finka-user-logout";
        out.textContent = "Выйти";
        out.addEventListener("click", function () {
            out.disabled = true;
            signOut();
        });

        box.appendChild(avatar);
        box.appendChild(info);
        box.appendChild(out);
        return box;
    }

    // Навигация из shared-nav.js подключается в конце <body>, поэтому
    // ждём её появления, но не бесконечно.
    function findHost(cb) {
        var tries = 0;
        (function poll() {
            var host =
                document.querySelector(".finka-nav-right") ||
                document.querySelector(".hero-right");
            if (host) return cb(host, false);
            if (++tries > 40) return cb(document.body, true);
            setTimeout(poll, 50);
        })();
    }

    function renderBadge(profile) {
        if (document.querySelector(".finka-user")) return;
        injectStyles();
        findHost(function (host, floating) {
            if (!host) return;
            var badge = buildBadge(profile);
            if (floating) badge.classList.add("finka-user--floating");
            host.appendChild(badge);
        });
    }

    /* ── Режим «только просмотр» ───────────────────────────────── */
    // Экспорт и печать в режиме просмотра разрешены, поэтому их тут нет.
    var WRITE_BTN_RE =
        /сохран|импорт|загруз|очист|заполн|удал|сброс|добав|применить|пересчит/i;

    function lockNode(node) {
        if (!node || node.nodeType !== 1) return;

        var inputs = node.matches && node.matches("input,select,textarea")
            ? [node]
            : [];
        inputs = inputs.concat(
            Array.prototype.slice.call(
                node.querySelectorAll
                    ? node.querySelectorAll("input,select,textarea")
                    : [],
            ),
        );

        inputs.forEach(function (el) {
            if (el.type === "hidden") return;
            el.dataset.finkaRo = "1";
            // Не «уже помечали — пропускаем»: страницы включают поля обратно
            // своими расчётами, и пометка при этом остаётся. Проверять надо
            // фактическое состояние поля.
            if (!el.disabled) el.disabled = true;
        });

        var editables = Array.prototype.slice.call(
            node.querySelectorAll ? node.querySelectorAll("[contenteditable]") : [],
        );
        editables.forEach(function (el) {
            el.setAttribute("contenteditable", "false");
        });

        var buttons = node.matches && node.matches("button,.btn")
            ? [node]
            : [];
        buttons = buttons.concat(
            Array.prototype.slice.call(
                node.querySelectorAll ? node.querySelectorAll("button,.btn") : [],
            ),
        );

        buttons.forEach(function (btn) {
            if (btn.dataset.finkaRo) return;
            // Навигация, вкладки филиалов и кнопка выхода остаются рабочими
            if (
                btn.classList.contains("finka-user-logout") ||
                btn.classList.contains("finka-nav-btn") ||
                btn.classList.contains("finka-nav-mobile-btn") ||
                btn.classList.contains("branch-btn") ||
                btn.classList.contains("filter-btn") ||
                btn.classList.contains("toggle-pass")
            ) {
                return;
            }
            if (WRITE_BTN_RE.test(btn.textContent || "")) {
                btn.dataset.finkaRo = "1";
                btn.disabled = true;
                btn.style.opacity = "0.45";
                btn.style.cursor = "not-allowed";
                btn.title = "Недоступно в режиме просмотра";
            }
        });
    }

    function enableReadOnly(profile) {
        injectStyles();

        var banner = document.createElement("div");
        banner.className = "finka-ro-banner";
        banner.textContent =
            "👁 Режим просмотра — редактирование недоступно для роли «" +
            profile.role.label +
            "»";
        document.body.insertBefore(banner, document.body.firstChild);

        lockNode(document.body);

        /* Таблицы отрисовываются скриптами страниц уже после загрузки, а
           некоторые страницы вдобавок сами включают поля обратно: например
           «План-Факт» при переключении филиала выставляет каждому полю
           disabled = false. Для учётки с привязкой к филиалу такое
           переключение происходит автоматически сразу после входа — и режим
           просмотра переставал действовать. Поэтому следим и за появлением
           узлов, и за снятием запрета с полей. */
        var mo = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var rec = records[i];

                if (rec.type === "attributes") {
                    var el = rec.target;
                    if (
                        el.dataset &&
                        el.dataset.finkaRo &&
                        !el.disabled &&
                        el.type !== "hidden"
                    ) {
                        el.disabled = true;
                    }
                    continue;
                }

                var added = rec.addedNodes;
                for (var j = 0; j < added.length; j++) {
                    lockNode(added[j]);
                }
            }
        });
        mo.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["disabled"],
        });

        // Переключение филиала перерисовывает таблицу целиком — проходим ещё
        // раз, когда страница успокоится
        setTimeout(function () {
            lockNode(document.body);
        }, 1200);
    }

    /* ── Блокировка импорта ────────────────────────────────────── */
    function hideImportLinks() {
        var links = document.querySelectorAll('a[href="import-excel.html"]');
        for (var i = 0; i < links.length; i++) {
            var el = links[i].closest(".section") || links[i];
            el.style.display = "none";
        }
    }

    /* ── Привязка к своему филиалу ─────────────────────────────── */
    /* Филиал кнопки: часть страниц размечена атрибутом data-branch, а
       тринадцать других зовут switchBranch('almaty') прямо из onclick.
       Раньше здесь искались только первые — и на страницах ПУ, «Сводной
       общей», «Свода ФЗП» привязка к городу не срабатывала вовсе:
       пользователь филиала мог открыть чужой город. */
    function branchOfButton(btn) {
        var attr = btn.getAttribute("data-branch");
        if (attr) return attr;
        var on = btn.getAttribute("onclick") || "";
        var m = /switchBranch\(\s*['"]([^'"]+)/.exec(on);
        return m ? m[1] : "";
    }

    function lockBranch(profile) {
        var tries = 0;

        function pass() {
            var btns = document.querySelectorAll(".branch-btn");
            var own = null;
            var found = 0;

            for (var i = 0; i < btns.length; i++) {
                var b = branchOfButton(btns[i]);
                if (!b) continue; // «Сводный» и прочие кнопки без филиала
                found++;
                if (b === profile.branchKey) {
                    own = btns[i];
                    btns[i].style.display = "";
                } else {
                    btns[i].style.display = "none";
                }
            }
            return { found: found, own: own };
        }

        (function poll() {
            var res = pass();
            if (!res.found) {
                if (++tries > 40) return;
                return setTimeout(poll, 50);
            }
            if (res.own && !res.own.classList.contains("active")) res.own.click();

            // Страницы перерисовывают панель филиалов при загрузке данных —
            // проходим ещё раз, когда всё успокоится
            setTimeout(pass, 800);
            setTimeout(pass, 2000);
        })();
    }

    /* ── Экран «нет доступа» ───────────────────────────────────── */
    function renderDenied(profile) {
        injectStyles();
        var hasRole = !!profile.role;
        var body = hasRole
            ? "Роль «" +
              profile.role.label +
              "» не даёт доступа к этому разделу.<br>" +
              "Если доступ нужен по работе — обратитесь к администратору системы."
            : "Учётной записи " +
              profile.email +
              " не назначена роль в бюджетной системе.<br>" +
              "Доступ выдаёт администратор.";
        document.body.innerHTML =
            '<div class="finka-denied">' +
            "<h1>" +
            (hasRole ? "Страница недоступна" : "Доступ не разрешён") +
            "</h1><p>" +
            body +
            "</p>" +
            (hasRole
                ? '<a href="' + HOME_PAGE + '">На главную</a>'
                : '<a href="#" id="finkaDeniedOut">Выйти</a>') +
            "</div>";
        revealPage();
        var out = document.getElementById("finkaDeniedOut");
        if (out) {
            out.addEventListener("click", function (e) {
                e.preventDefault();
                signOut();
            });
        }
    }

    /* ── Главный сценарий ──────────────────────────────────────── */
    function applyPolicy(state) {
        var profile = state.profile;

        if (!canOpen(profile, currentPage)) {
            renderDenied(profile);
            return;
        }

        revealPage();
        renderBadge(profile);
        greetIfJustSignedIn(profile);

        if (!profile.role.canEdit) enableReadOnly(profile);
        if (!profile.role.canImport) hideImportLinks();
        if (profile.branchLocked) lockBranch(profile);
    }

    /* ── «Вы вошли» ────────────────────────────────────────────── */
    /* Страница входа сразу уводит внутрь, и человек не понимает, вошёл он
       или его просто перекинуло. Поэтому login.html оставляет отметку в
       sessionStorage, а здесь — уже на нужной странице — показываем, кем
       именно вошли и какие права.

       Своя всплывашка, а не finkaToast из shared-nav.js: на главной
       навигация не рисуется, и там finkaToast не существует. */
    var GREET_KEY = "finka-just-signed-in";

    function greetIfJustSignedIn(profile) {
        var flag;
        try {
            flag = sessionStorage.getItem(GREET_KEY);
        } catch (e) {
            return;
        }
        if (!flag) return;

        /* Отметку снимаем не сразу, а когда уведомление уже повисело на
           экране. Иначе его не увидеть: db-sync.js после первой загрузки
           данных из базы перезагружает страницу, и всплывашка исчезает
           вместе с ней — а отметка к тому времени была бы уже съедена. */
        function consume() {
            try {
                sessionStorage.removeItem(GREET_KEY);
            } catch (e) {
                /* приватный режим */
            }
        }

        var text = "Вы вошли как " + (profile.email || flag);
        var sub = profile.role
            ? profile.role.label +
              (profile.branchLocked ? " · " + profile.branch : "")
            : "";

        // Ждём загрузку: shared-nav.js подключается в конце страницы, и до
        // него своей всплывашки может не быть
        if (document.readyState === "complete") show();
        else window.addEventListener("load", show, { once: true });

        function show() {
            if (window.finkaToast) {
                window.finkaToast(text + (sub ? " · " + sub : ""), "success");
            } else {
                ownToast(text, sub);
            }
            setTimeout(consume, 4200);
        }
    }

    function ownToast(text, sub) {
        injectStyles();
        var box = document.createElement("div");
        box.className = "finka-hello";
        box.innerHTML =
            '<span class="finka-hello-mark">✓</span>' +
            "<span><strong>" +
            escapeHtml(text) +
            "</strong>" +
            (sub ? '<span class="finka-hello-sub">' + escapeHtml(sub) + "</span>" : "") +
            "</span>";
        document.body.appendChild(box);

        requestAnimationFrame(function () {
            box.classList.add("show");
        });
        setTimeout(function () {
            box.classList.remove("show");
            setTimeout(function () {
                if (box.parentNode) box.parentNode.removeChild(box);
            }, 260);
        }, 3600);
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    ready
        .then(function (state) {
            if (isLoginPage) return;

            if (!state.session) {
                location.replace(loginUrl());
                return;
            }

            function run() {
                applyPolicy(state);
            }
            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", run);
            } else {
                run();
            }

            state.client.auth.onAuthStateChange(function (event, session) {
                if (!session && event !== "INITIAL_SESSION") {
                    location.replace(LOGIN_PAGE);
                }
            });
        })
        .catch(function (err) {
            // Сеть недоступна или CDN заблокирован — не запираем пользователя
            // в белом экране, но и не выдаём доступ молча.
            console.error("[auth]", err);
            revealPage();
        });

    /* ── Публичное API ─────────────────────────────────────────── */
    window.finkaAuth = {
        getClient: getClient,
        signOut: signOut,
        // Профиль нужен страницам, чтобы включать/выключать свои элементы
        // по роли: finkaAuth.getProfile().then(p => …)
        getProfile: function () {
            return ready.then(function (s) {
                return s.profile;
            });
        },
    };
})();
