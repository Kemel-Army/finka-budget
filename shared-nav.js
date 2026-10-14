/**
 * FINKA Budget System — Shared Navigation & Utilities
 * Automatically injects top navigation bar, toast notifications,
 * and keyboard shortcuts into every page.
 */
(function () {
    "use strict";

    /* ── Page Registry ─────────────────────────────────────────── */
    var SECTIONS = {
        kb: {
            label: "Консолидированный бюджет",
            short: "КБ",
            items: [
                {
                    href: "kb-svod.html",
                    title: "КБ НАО РФМШ — Для руководства",
                    key: "kb_svod",
                },
                {
                    href: "plan-finansirovaniya.html",
                    title: "План финансирования по платежам",
                    key: "plan_fin",
                },
                {
                    href: "spravki.html",
                    title: "Справки на передвижку",
                    key: "spravka_peredvizhka",
                },
                {
                    href: "shtatnoe.html",
                    title: "Штатное расписание",
                    key: "shtat",
                },
                {
                    href: "osnovaniya.html",
                    title: "Основания (приказы)",
                    key: "osnovaniya",
                },
                {
                    href: "deposit.html",
                    title: "Депозит (доход и расход)",
                    key: "deposit",
                },
            ],
        },
        rb: {
            label: "Республиканский бюджет",
            short: "РБ",
            items: [
                {
                    href: "rb-svod.html",
                    title: "Свод расходов 2026-2028",
                    key: "rb_svod",
                },
                {
                    href: "rb-svodnaya.html",
                    title: "Сводная общая 2026",
                    key: "rb_svodnaya",
                },
                {
                    href: "rb-income.html",
                    title: "Доходы РБ",
                    key: "rb_income",
                },
                {
                    href: "rb-fzp.html",
                    title: "Фонд заработной платы",
                    key: "rb_fzp",
                },
                {
                    href: "fot-almaty.html",
                    title: "Свод ФОТ Алматы",
                    key: "fot",
                },
                {
                    href: "rb-kalkulyacia.html",
                    title: "Калькуляция расходов",
                    key: "rb_kalkulyacia",
                },
                {
                    href: "rb-plan-komandir.html",
                    title: "План командировок РК",
                    key: "rb_plan_komandir",
                },
                {
                    href: "plan-fact.html",
                    title: "План-Факт РБ",
                    key: "plan_fact_rb",
                },
                {
                    href: "dogovory.html",
                    title: "Договоры по спецификам",
                    key: "rb_dogovory",
                },
                {
                    href: "forma-4-20.html",
                    title: "Форма 4-20 (план-факт 1С)",
                    key: "rb_forma420",
                },
            ],
        },
        /* Раздел целиком — «Бюджет за счёт реализации образовательных
           услуг» (бывший «Подушевое финансирование»), внутри три подраздела
           по источнику дохода. Листы и ключи прежние, поменялись только
           подписи и порядок. */
        pu: {
            label: "Бюджет за счёт реализации образовательных услуг",
            short: "Обр. услуги",
            items: [
                {
                    href: "pu-svod-2026.html",
                    title: "Свод 2026 (все источники)",
                    key: "pu_svod_2026",
                },
                {
                    href: "plan-fact-pu-dt.html",
                    title: "План-Факт ПУ + ДТ (свод)",
                    key: "plan_fact_pu_dt",
                },
                {
                    group: "1. Подушевое финансирование (Республиканский бюджет)",
                    href: "pu-income-dt.html",
                    title: "Доходы ДТ (подушевое финансирование)",
                    key: "pu_income_dt",
                },
                {
                    href: "pu-ss-dotacia.html",
                    title: "Собственные средства (Дотация)",
                    key: "pu_ss_dotacia",
                },
                {
                    href: "plan-fact-dt.html",
                    title: "План-Факт ДТ",
                    key: "plan_fact_dt",
                },
                {
                    group: "2. За счёт средств от реализации образовательных услуг на возмездной основе",
                    href: "pu-income-pu.html",
                    title: "Доходы ПУ (платное обучение)",
                    key: "pu_income_pu",
                },
                {
                    href: "pu-ss-almaty.html",
                    title: "Собственные средства Алматы",
                    key: "pu_ss_almaty",
                },
                {
                    href: "pu-fot-almaty.html",
                    title: "ФОТ Алматы",
                    key: "pu_fot_almaty",
                },
                {
                    href: "pu-grafik-almaty.html",
                    title: "График родительской оплаты Алматы",
                    key: "pu_grafik_almaty",
                },
                {
                    href: "pu-kalkulyacia-almaty.html",
                    title: "Калькуляция Алматы",
                    key: "pu_kalkulyacia_almaty",
                },
                {
                    href: "pu-plan-rk.html",
                    title: "План командировок РК",
                    key: "pu_plan_rk",
                },
                {
                    href: "pu-plan-abroad.html",
                    title: "План командировок за рубеж",
                    key: "pu_plan_abroad",
                },
                {
                    href: "plan-fact-pu.html",
                    title: "План-Факт ПУ",
                    key: "plan_fact_pu",
                },
                {
                    group: "3. Иные доходы",
                    href: "pu-income-dop.html",
                    title: "Иные доходы (ДОП)",
                    key: "pu_income_dop",
                },
            ],
        },
        zayavki: {
            label: "Заявки-потребности",
            short: "Заявки",
            items: [
                {
                    href: "zayavki.html",
                    title: "Заявки-потребности на товары, работы, услуги",
                    key: "zayavki",
                },
            ],
        },
        util: {
            label: "Импорт",
            short: "Импорт",
            items: [
                { href: "import-excel.html", title: "Импорт из Excel" },
            ],
        },
    };

    var currentPage = location.pathname.split("/").pop() || "index.html";
    if (currentPage === "index.html" || currentPage === "") return; // dashboard has its own nav

    /* ── Detect Current Section ────────────────────────────────── */
    var currentSection = null;
    var currentTitle = document.title || "";
    for (var key in SECTIONS) {
        var sec = SECTIONS[key];
        for (var i = 0; i < sec.items.length; i++) {
            if (sec.items[i].href === currentPage) {
                currentSection = key;
                currentTitle = sec.items[i].title;
                break;
            }
        }
        if (currentSection) break;
    }

    /* ── Состояние обмена с базой ──────────────────────────────── */
    // Раньше здесь считался объём localStorage. Данные теперь хранятся
    // в базе (схема budget), localStorage остался лишь кэшем, и его
    // размер пользователю ничего не говорит. Состояние пишет db-sync.js.

    /* ── Build Navigation HTML ─────────────────────────────────── */
    function buildDropdown(section) {
        var html = "";
        for (var i = 0; i < section.items.length; i++) {
            var item = section.items[i];
            // Подраздел — подпись над группой листов
            if (item.group) {
                html += '<div class="finka-dd-group">' + item.group + "</div>";
            }
            var cls = item.href === currentPage ? ' class="current"' : "";
            html +=
                '<a href="' + item.href + '"' + cls + ">" +
                // «Алматы» в названии листа — город выбранного филиала,
                // auth.js подставит свой (см. «Город в заголовках»)
                item.title.replace(
                    "Алматы",
                    '<span data-city-own="city">Алматы</span>',
                ) +
                "</a>";
        }
        return html;
    }

    var navHTML =
        "" +
        '<nav class="finka-nav">' +
        '  <div class="finka-nav-inner">' +
        // Единственная ссылка «на главную» на листе. Раньше у каждой
        // страницы была своя «← Вернуться к списку» в шапке, а логотип вёл
        // туда же — две ссылки на одно место. Теперь логотип — подпись.
        '    <span class="finka-nav-brand">' +
        '      <span class="finka-nav-logo">\u20B8</span>' +
        "      <span>РФМШ Бюджет</span>" +
        "    </span>" +
        '    <a href="index.html" class="back-link finka-nav-home">\u2190 На главную</a>' +
        '    <div class="finka-nav-links">';

    for (var sKey in SECTIONS) {
        var s = SECTIONS[sKey];
        var activeClass = currentSection === sKey ? " active" : "";
        navHTML +=
            "" +
            '<div class="finka-nav-item' +
            activeClass +
            '">' +
            '  <button class="finka-nav-btn" data-section="' +
            sKey +
            '">' +
            s.short +
            ' <span class="finka-arrow">\u25BE</span>' +
            "  </button>" +
            '  <div class="finka-dropdown">' +
            buildDropdown(s) +
            "  </div>" +
            "</div>";
    }

    navHTML +=
        "" +
        "    </div>" +
        '    <div class="finka-nav-right">' +
        '      <span class="finka-nav-storage" title="Данные хранятся в базе">' +
        '        <span id="finkaSyncState">☁ База данных</span>' +
        "      </span>" +
        '      <button class="finka-nav-mobile-btn" aria-label="Меню">\u2630</button>' +
        "    </div>" +
        "  </div>" +
        "</nav>";

    /* ── Toast Container ───────────────────────────────────────── */
    navHTML += '<div class="finka-toast-container" id="finkaToasts"></div>';

    /* ── Inject into DOM ───────────────────────────────────────── */
    var wrapper = document.createElement("div");
    wrapper.innerHTML = navHTML;
    while (wrapper.firstChild) {
        document.body.insertBefore(
            wrapper.firstChild,
            document.body.firstChild,
        );
    }

    // Если страница ещё носит свою «← Вернуться…» в разметке — убираем:
    // ссылка на главную одна, в навигации
    var strayBack = document.querySelectorAll("a.back-link:not(.finka-nav-home)");
    for (var sb = 0; sb < strayBack.length; sb++) {
        strayBack[sb].parentNode.removeChild(strayBack[sb]);
    }

    /* ── Dropdown Toggle Handling ──────────────────────────────── */
    var navItems = document.querySelectorAll(".finka-nav-item");

    function closeAll() {
        for (var i = 0; i < navItems.length; i++) {
            navItems[i].classList.remove("open");
        }
    }

    for (var n = 0; n < navItems.length; n++) {
        (function (item) {
            var btn = item.querySelector(".finka-nav-btn");
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                var wasOpen = item.classList.contains("open");
                closeAll();
                if (!wasOpen) item.classList.add("open");
            });
        })(navItems[n]);
    }

    // Desktop: hover open (after small delay)
    if (window.matchMedia("(min-width: 901px)").matches) {
        for (var h = 0; h < navItems.length; h++) {
            (function (item) {
                var timer;
                item.addEventListener("mouseenter", function () {
                    clearTimeout(timer);
                    closeAll();
                    item.classList.add("open");
                });
                item.addEventListener("mouseleave", function () {
                    timer = setTimeout(function () {
                        item.classList.remove("open");
                    }, 150);
                });
            })(navItems[h]);
        }
    }

    // Close on outside click
    document.addEventListener("click", function () {
        closeAll();
    });

    // Mobile hamburger toggle
    var mobileBtn = document.querySelector(".finka-nav-mobile-btn");
    if (mobileBtn) {
        mobileBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            var nav = document.querySelector(".finka-nav");
            nav.classList.toggle("open");
        });
    }

    /* Всплывающие сообщения (finkaToast) — в ui-kit.js: он выводит текст
       как текст, а не HTML. Контейнер #finkaToasts рисуется выше. */

    /* ── Keyboard Shortcut: Ctrl+S ─────────────────────────────── */
    /* Раньше здесь безусловно писалось «Данные сохранены», хотя saveData()
       кладёт данные только в localStorage, а в базу они уходят позже и
       могут не уйти вовсе (нет сети, нет прав, конфликт). Теперь очередь
       отправляется сразу (finkaSync.flush), и сообщение — по её итогу. */
    function syncReport(st) {
        if (st.readOnly) {
            return ["Режим просмотра — изменения в базу не сохраняются", "warning"];
        }
        if (!st.enabled) return ["Сохранено в браузере (база недоступна)", "warning"];
        if (st.code === "conflict" && st.conflicts.length) {
            return [
                "Лист изменён другим пользователем — ваши правки не записаны " +
                    "поверх, загружена версия из базы",
                "warning",
            ];
        }
        if (st.pending) {
            if (!st.ready) {
                return ["Сохранено в браузере, уйдёт в базу после загрузки", "info"];
            }
            return [
                "Сохранено только в браузере, в базу не отправлено: " +
                    st.pending + " (" + st.text + ")",
                "error",
            ];
        }
        if (st.code === "off") return ["Не сохранено в базе: " + st.text, "error"];
        return ["Сохранено в базе", "success"];
    }

    document.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (e.repeat) return;
            var hasSave = typeof window.saveData === "function";
            if (hasSave) window.saveData();

            var sync = window.finkaSync;
            if (!sync || typeof sync.flush !== "function") {
                window.finkaToast(
                    hasSave
                        ? "Сохранено в браузере"
                        : "На этой странице нечего сохранять",
                    "info",
                );
                return;
            }
            sync.flush().then(
                function (st) {
                    var r = syncReport(st || sync.status());
                    window.finkaToast(r[0], r[1]);
                },
                function () {
                    window.finkaToast("Не удалось отправить в базу", "error");
                },
            );
        }
    });

    /* ── Состояние обмена ──────────────────────────────────────── */
    // db-sync.js стартует раньше навигации и успевает нарисовать
    // состояние в углу экрана — просим перерисовать его сюда, в шапку
    if (window.finkaSync && window.finkaSync.paint) window.finkaSync.paint();

    /* ── Примечания ────────────────────────────────────────────── */
    // Блок «Примечания» внизу листа — notes.js. Подключаем отсюда, чтобы не
    // править три десятка страниц; страница может подключить его и сама
    if (!window.finkaNotes && !document.querySelector('script[src="notes.js"]')) {
        var notesJs = document.createElement("script");
        notesJs.src = "notes.js";
        document.body.appendChild(notesJs);
    }
})();
