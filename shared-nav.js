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
            ],
        },
        pu: {
            label: "Подушевое финансирование",
            short: "ПУ",
            items: [
                {
                    href: "pu-svod-2026.html",
                    title: "Свод ПУ 2026",
                    key: "pu_svod_2026",
                },
                {
                    href: "pu-ss-dotacia.html",
                    title: "СС Дотация",
                    key: "pu_ss_dotacia",
                },
                {
                    href: "pu-ss-almaty.html",
                    title: "СС Алматы",
                    key: "pu_ss_almaty",
                },
                {
                    href: "pu-income-pu.html",
                    title: "Доходы ПУ",
                    key: "pu_income_pu",
                },
                {
                    href: "pu-income-dt.html",
                    title: "Доходы ДТ",
                    key: "pu_income_dt",
                },
                {
                    href: "pu-income-dop.html",
                    title: "Доходы ДОП",
                    key: "pu_income_dop",
                },
                {
                    href: "pu-fot-almaty.html",
                    title: "ФОТ Алматы",
                    key: "pu_fot_almaty",
                },
                {
                    href: "pu-grafik-almaty.html",
                    title: "График Алматы",
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
                    href: "plan-fact-dt.html",
                    title: "План-Факт ДТ",
                    key: "plan_fact_dt",
                },
                {
                    href: "plan-fact-pu-dt.html",
                    title: "План-Факт ПУ + ДТ (свод)",
                    key: "plan_fact_pu_dt",
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
            var cls = item.href === currentPage ? ' class="current"' : "";
            html +=
                '<a href="' + item.href + '"' + cls + ">" + item.title + "</a>";
        }
        return html;
    }

    var navHTML =
        "" +
        '<nav class="finka-nav">' +
        '  <div class="finka-nav-inner">' +
        '    <a href="index.html" class="finka-nav-brand">' +
        '      <span class="finka-nav-logo">\u20B8</span>' +
        "      <span>РФМШ Бюджет</span>" +
        "    </a>" +
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

    /* ── Toast Notification System ─────────────────────────────── */
    var TOAST_ICONS = {
        success: "\u2714",
        error: "\u2718",
        warning: "\u26A0",
        info: "\u2139",
    };

    window.finkaToast = function (message, type) {
        type = type || "info";
        var container = document.getElementById("finkaToasts");
        if (!container) return;

        var toast = document.createElement("div");
        toast.className = "finka-toast " + type;
        toast.innerHTML =
            '<span class="finka-toast-icon">' +
            (TOAST_ICONS[type] || "") +
            "</span>" +
            "<span>" +
            message +
            "</span>";
        container.appendChild(toast);

        setTimeout(function () {
            toast.classList.add("removing");
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 200);
        }, 3000);
    };

    /* ── Keyboard Shortcut: Ctrl+S ─────────────────────────────── */
    document.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (typeof window.saveData === "function") {
                window.saveData();
                window.finkaToast("Данные сохранены", "success");
            } else {
                window.finkaToast("На этой странице нечего сохранять", "info");
            }
        }
    });

    /* ── Состояние обмена ──────────────────────────────────────── */
    // db-sync.js стартует раньше навигации и успевает нарисовать
    // состояние в углу экрана — просим перерисовать его сюда, в шапку
    if (window.finkaSync && window.finkaSync.paint) window.finkaSync.paint();
})();
