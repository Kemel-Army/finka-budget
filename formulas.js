/**
 * FINKA Budget System — формулы на виду.
 *
 * Подключается перед </body> после скриптов страницы.
 *
 * Что делает:
 *   • у расчётных ячеек появляется пунктирная подчёркивание, при наведении
 *     видно, как считается число;
 *   • ставки, которые меняются от года к году (ОПВ, соцналог, соцотчисления,
 *     ОСМС, ОПВР, МРП, вычет по ИПН, рентабельность), собраны в одну панель
 *     «Ставки и формулы» и правятся там;
 *   • изменённые ставки лежат в localStorage под ключом rates_<филиал> и
 *     доступны страницам через window.finkaRates.get('opv').
 *
 * Почему так, а не «редактор формул на каждую ячейку»: расчёты страниц
 * сверены с исходными книгами Excel (tests/run.mjs). Свободная правка любой
 * формулы означала бы, что сверять больше нечего. От года к году меняются не
 * формулы, а ставки в них — их и даём менять.
 */
(function () {
    "use strict";

    var PAGE = location.pathname.split("/").pop() || "index.html";

    /* ── Ставки ────────────────────────────────────────────────── */
    var RATES = [
        { key: "opv", label: "Обязательные пенсионные взносы", value: 10, unit: "%",
          note: "удерживаются с работника, от ФЗП за месяц" },
        { key: "opvr", label: "ОПВР — взносы работодателя", value: 3.5, unit: "%",
          note: "от годового ФЗП с лечебным пособием" },
        { key: "socTax", label: "Социальный налог", value: 6, unit: "%",
          note: "от ФЗП за вычетом ОПВ и ВОСМС" },
        { key: "socOtch", label: "Социальные отчисления", value: 5, unit: "%",
          note: "от ФЗП за вычетом ОПВ" },
        { key: "osms", label: "ОСМС — отчисления работодателя", value: 3, unit: "%",
          note: "от годового ФЗП без лечебного пособия" },
        { key: "vosms", label: "ВОСМС — взносы работника", value: 2, unit: "%",
          note: "от ФЗП за месяц" },
        { key: "ipn", label: "Индивидуальный подоходный налог", value: 10, unit: "%",
          note: "с базы за вычетом ОПВ, ВОСМС и налогового вычета" },
        { key: "mrp", label: "МРП", value: 4325, unit: "₸",
          note: "месячный расчётный показатель на год" },
        { key: "deduction", label: "Налоговый вычет по ИПН", value: 129750, unit: "₸",
          note: "30 МРП — вычитается из базы ИПН" },
        { key: "lopK", label: "Лечебное пособие", value: 2, unit: "окладов",
          note: "сколько должностных окладов начисляется за год" },
        { key: "profit", label: "Рентабельность", value: 8, unit: "%",
          note: "закладывается в доходную часть подушевого финансирования" },
    ];

    function branch() {
        var btn = document.querySelector(".branch-btn.active[data-branch]");
        return btn ? btn.getAttribute("data-branch") : "nao";
    }

    function key() {
        return "rates_" + branch();
    }

    function stored() {
        try {
            return JSON.parse(localStorage.getItem(key())) || {};
        } catch (e) {
            return {};
        }
    }

    function get(name) {
        var saved = stored();
        if (saved[name] !== undefined) return Number(saved[name]);
        for (var i = 0; i < RATES.length; i++) {
            if (RATES[i].key === name) return RATES[i].value;
        }
        return null;
    }

    function set(name, value) {
        var saved = stored();
        saved[name] = Number(value);
        localStorage.setItem(key(), JSON.stringify(saved));
        document.dispatchEvent(
            new CustomEvent("finka:rates", { detail: { key: name, value: Number(value) } }),
        );
    }

    function reset() {
        localStorage.removeItem(key());
        document.dispatchEvent(new CustomEvent("finka:rates", { detail: {} }));
    }

    /* ── Что за число в ячейке ─────────────────────────────────── */
    /* Ячейки, посчитанные страницей, помечены классом formula-cell или
       auto-cell, но чем именно они посчитаны, из разметки не видно.
       Описание берём по заголовку колонки: он и есть название формулы. */
    var BY_HEADER = [
        [/^итого$|^всего$/i, "Сумма по строке"],
        [/итого доплаты/i, "Сумма всех доплат в строке"],
        [/всего фзп за месяц/i, "Должностной оклад + итого доплаты"],
        [/всего фзп в год/i, "ФЗП за месяц × 12"],
        [/леч.*пособи/i, "Должностной оклад × коэффициент лечебного пособия"],
        [/фзп.*с.*пособи/i, "Годовой ФЗП + лечебное пособие"],
        [/опв/i, "ставка ОПВ от ФЗП за месяц"],
        [/опвр/i, "ставка ОПВР от годового ФЗП с пособием"],
        [/восмс/i, "ставка ВОСМС от ФЗП за месяц"],
        [/^ипн/i, "(ФЗП − ОПВ − ВОСМС − налоговый вычет) × ставка ИПН"],
        [/итого на руки/i, "ФЗП − ОПВ − ИПН − ВОСМС"],
        [/социальн.*налог/i, "(ФЗП с пособием − ОПВ − ВОСМС) × ставка соцналога"],
        [/социальн.*отчислен/i, "(ФЗП с пособием − ОПВ) × ставка соцотчислений"],
        [/осмс/i, "ставка ОСМС от годового ФЗП"],
        [/всего фот/i, "ФЗП с пособием + ОПВР + соцналог + соцотчисления + ОСМС"],
        [/план с остатк/i, "План за месяц + справка на передвижку"],
        [/^остатки$/i, "План с остатками − факт"],
        [/нарастающ/i, "Сумма с начала года, включая отчётный месяц"],
        [/финансовый план/i, "Сумма двенадцати месяцев"],
        [/рентабельн/i, "ставка рентабельности от суммы дохода"],
        [/^сумма затрат/i, "Количество × цена"],
        [/^%|процент/i, "Доля от итога"],
    ];

    function headerOf(td) {
        var table = td.closest("table");
        if (!table || !table.tHead) return "";
        var idx = 0;
        var tr = td.parentNode;
        for (var i = 0; i < tr.cells.length; i++) {
            if (tr.cells[i] === td) break;
            idx += parseInt(tr.cells[i].getAttribute("colspan"), 10) || 1;
        }
        // берём самую нижнюю строку шапки — там подписи конкретных колонок
        var rows = table.tHead.rows;
        for (var r = rows.length - 1; r >= 0; r--) {
            var col = 0;
            for (var c = 0; c < rows[r].cells.length; c++) {
                var span = parseInt(rows[r].cells[c].getAttribute("colspan"), 10) || 1;
                if (idx >= col && idx < col + span) {
                    var t = rows[r].cells[c].textContent.replace(/\s+/g, " ").trim();
                    if (t) return t;
                }
                col += span;
            }
        }
        return "";
    }

    function describe(td) {
        var head = headerOf(td);
        var text = "";
        for (var i = 0; i < BY_HEADER.length; i++) {
            if (BY_HEADER[i][0].test(head)) {
                text = BY_HEADER[i][1];
                break;
            }
        }
        if (!text && td.closest("tr.sx-total")) {
            text = "Сумма по колонке, включая добавленные строки";
        }
        if (!text && td.closest("tr.total-row,tr.summary-row,tr.grand-total-row")) {
            text = "Сумма по колонке";
        }
        if (!text) return "";

        // подставляем действующие ставки
        text = text
            .replace(/ставка ОПВР/g, get("opvr") + " %")
            .replace(/ставка ОПВ/g, get("opv") + " %")
            .replace(/ставка ВОСМС/g, get("vosms") + " %")
            .replace(/ставка ИПН/g, get("ipn") + " %")
            .replace(/ставка соцналога/g, get("socTax") + " %")
            .replace(/ставка соцотчислений/g, get("socOtch") + " %")
            .replace(/ставка ОСМС/g, get("osms") + " %")
            .replace(/ставка рентабельности/g, get("profit") + " %");

        return (head ? head + " — " : "") + text;
    }

    /* ── Оформление ────────────────────────────────────────────── */
    function injectStyles() {
        if (document.getElementById("formulaStyles")) return;
        var css = document.createElement("style");
        css.id = "formulaStyles";
        css.textContent = [
            "td.fx{cursor:help}",
            "td.fx:hover{box-shadow:inset 0 -2px 0 var(--c-primary,#2563eb)}",
            ".fx-tip{position:fixed;z-index:9999;max-width:340px;padding:9px 12px;",
            "font:400 12px/1.45 var(--font,system-ui);color:#e2e8f0;",
            "background:#0f172a;border-radius:8px;box-shadow:0 6px 20px rgba(15,23,42,.28);",
            "pointer-events:none;opacity:0;transition:opacity 120ms ease}",
            ".fx-tip.show{opacity:1}",
            ".fx-tip b{color:#fff;font-weight:650}",
            ".fx-tip i{display:block;margin-top:5px;color:#94a3b8;font-style:normal;font-size:11px}",
            /* панель ставок */
            ".fx-panel{margin:14px 0 18px;border:1px solid var(--c-gray-200);",
            "border-radius:var(--radius-lg,10px);background:#fff;overflow:hidden}",
            ".fx-head{display:flex;align-items:center;gap:10px;padding:11px 16px;",
            "cursor:pointer;user-select:none;font-size:13px;font-weight:650;",
            "color:var(--c-gray-800)}",
            ".fx-head:hover{background:var(--c-gray-50)}",
            ".fx-head .fx-chev{margin-left:auto;color:var(--c-gray-400);transition:transform 150ms}",
            ".fx-panel.open .fx-chev{transform:rotate(180deg)}",
            ".fx-body{display:none;padding:4px 16px 14px;border-top:1px solid var(--c-gray-200)}",
            ".fx-panel.open .fx-body{display:block}",
            ".fx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}",
            ".fx-item{display:flex;flex-direction:column;gap:3px;padding:9px 11px;",
            "border:1px solid var(--c-gray-200);border-radius:8px;background:var(--c-gray-50)}",
            ".fx-item.changed{border-color:var(--c-primary,#2563eb);background:#eff6ff}",
            ".fx-item label{font-size:11.5px;font-weight:600;color:var(--c-gray-700)}",
            ".fx-item .fx-row{display:flex;align-items:center;gap:6px}",
            ".fx-item input{width:110px;text-align:right;font-variant-numeric:tabular-nums}",
            ".fx-item .fx-unit{font-size:11.5px;color:var(--c-gray-500)}",
            ".fx-item .fx-note{font-size:11px;color:var(--c-gray-500);line-height:1.35}",
            "@media print{.fx-panel{display:none}}",
        ].join("");
        document.head.appendChild(css);
    }

    /* ── Подсказка ─────────────────────────────────────────────── */
    var tip = null;

    function showTip(td) {
        var text = describe(td);
        if (!text) return;
        if (!tip) {
            tip = document.createElement("div");
            tip.className = "fx-tip";
            document.body.appendChild(tip);
        }
        var parts = text.split(" — ");
        tip.innerHTML =
            "<b>" + parts[0] + "</b>" +
            (parts[1] ? "<i>" + parts.slice(1).join(" — ") + "</i>" : "") +
            '<i>Ставки меняются в панели «Ставки и формулы» над таблицей</i>';

        var r = td.getBoundingClientRect();
        tip.style.left = Math.min(r.left, window.innerWidth - 360) + "px";
        tip.style.top = (r.bottom + 6) + "px";
        tip.classList.add("show");
    }

    function hideTip() {
        if (tip) tip.classList.remove("show");
    }

    function markCells() {
        var cells = document.querySelectorAll(
            "td.formula-cell:not(.fx),td.auto-cell:not(.fx)," +
            "tr.total-row td:not(.fx),tr.sx-total td:not(.fx)",
        );
        Array.prototype.forEach.call(cells, function (td) {
            if (!describe(td)) return;
            td.classList.add("fx");
        });
    }

    /* ── Панель ставок ─────────────────────────────────────────── */
    function buildPanel() {
        if (document.querySelector(".fx-panel")) return;
        var anchor = document.querySelector(".table-container, .table-wrap");
        if (!anchor) return;

        var saved = stored();
        var panel = document.createElement("div");
        panel.className = "fx-panel";
        panel.innerHTML =
            '<div class="fx-head">Ставки и формулы' +
            '<span class="fx-chev">▾</span></div>' +
            '<div class="fx-body">' +
            '<p style="font-size:12px;color:var(--c-gray-500);margin:6px 0 12px">' +
            "Наведите курсор на любую расчётную ячейку — покажется, как она " +
            "считается. Ставки ниже подставляются в эти формулы; изменение " +
            "действует на текущий филиал." +
            "</p>" +
            '<div class="fx-grid">' +
            RATES.map(function (r) {
                var v = saved[r.key] !== undefined ? saved[r.key] : r.value;
                return (
                    '<div class="fx-item' +
                    (saved[r.key] !== undefined ? " changed" : "") +
                    '" data-rate="' + r.key + '">' +
                    "<label>" + r.label + "</label>" +
                    '<div class="fx-row">' +
                    '<input type="number" step="0.01" value="' + v + '">' +
                    '<span class="fx-unit">' + r.unit + "</span>" +
                    "</div>" +
                    '<span class="fx-note">' + r.note + "</span>" +
                    "</div>"
                );
            }).join("") +
            "</div>" +
            '<div class="buttons" style="margin-top:12px">' +
            '<button class="btn btn-secondary" id="fxReset">↺ Вернуть типовые ставки</button>' +
            "</div>" +
            "</div>";

        anchor.parentNode.insertBefore(panel, anchor);

        panel.querySelector(".fx-head").addEventListener("click", function () {
            panel.classList.toggle("open");
        });

        panel.querySelectorAll(".fx-item").forEach(function (item) {
            var input = item.querySelector("input");
            input.addEventListener("change", function () {
                set(item.dataset.rate, input.value);
                item.classList.add("changed");
                if (window.finkaToast) {
                    window.finkaToast("Ставка сохранена", "success");
                }
            });
        });

        panel.querySelector("#fxReset").addEventListener("click", function () {
            if (!confirm("Вернуть все ставки к типовым значениям?")) return;
            reset();
            panel.remove();
            buildPanel();
        });
    }

    /* ── Запуск ────────────────────────────────────────────────── */
    var SKIP = ["", "index.html", "index-budget.html", "dashboard.html",
        "login.html", "business-process.html", "import-excel.html"];

    function start() {
        if (SKIP.indexOf(PAGE) !== -1) return;
        injectStyles();
        buildPanel();
        markCells();

        document.addEventListener("mouseover", function (e) {
            var td = e.target.closest && e.target.closest("td.fx");
            if (td) showTip(td);
        });
        document.addEventListener("mouseout", function (e) {
            if (e.target.closest && e.target.closest("td.fx")) hideTip();
        });

        var timer = null;
        new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                buildPanel();
                markCells();
            }, 200);
        }).observe(document.body, { childList: true, subtree: true });
    }

    window.finkaRates = { get: get, set: set, reset: reset, all: RATES };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
