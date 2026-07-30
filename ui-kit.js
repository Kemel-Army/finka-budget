/**
 * FINKA Budget System — оформление кнопок и чисел.
 *
 * Подключается перед </body> на каждой странице.
 *
 * Три вещи, которые иначе пришлось бы править в трёх десятках файлов:
 *
 *   1. Эмодзи на кнопках (📥 📄 🖨️ 💾 ➕ ↺) заменяются на векторные значки.
 *      Эмодзи рисуются шрифтом операционной системы: на Windows они цветные
 *      и разного размера, рядом с текстом смотрятся кустарно.
 *
 *   2. Числа в расчётных ячейках приводятся к одному виду: разряды через
 *      пробел и ровно два знака после запятой. Было «1000000» и «0,3333».
 *
 *   3. В полях ввода число показывается с разрядами, пока поле не в фокусе.
 *      Само значение поля при этом не трогается — страницы читают его через
 *      parseFloat, а «1 000» parseFloat превращает в 1. Поэтому форматируется
 *      наложенная поверх подпись, а не значение.
 */
(function () {
    "use strict";

    /* ── Значки ────────────────────────────────────────────────── */
    // 16×16, обводкой в currentColor — наследуют цвет кнопки
    var ICONS = {
        download:
            '<path d="M8 2v8M5 7l3 3 3-3M2 12v1a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 13v-1"/>',
        file:
            '<path d="M4 1.5h5l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z"/>' +
            '<path d="M9 1.5v3h3M5.5 8h5M5.5 11h3"/>',
        printer:
            '<path d="M4 5.5V2h8v3.5M4 11H2.5v-5h11v5H12M4 11v3h8v-3H4z"/>',
        save:
            '<path d="M2.5 3.5A1 1 0 013.5 2.5h7L13.5 5.5v7a1 1 0 01-1 1h-9a1 1 0 01-1-1v-9z"/>' +
            '<path d="M5 2.5v4h5v-4M5 13.5v-4h6v4"/>',
        plus: '<path d="M8 3.5v9M3.5 8h9"/>',
        close: '<path d="M4 4l8 8M12 4l-8 8"/>',
        rotate:
            '<path d="M13 8a5 5 0 11-1.6-3.7"/><path d="M13.5 2v3h-3"/>',
        trash:
            '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5A1 1 0 005.7 14.5h4.6a1 1 0 001-1L12 4"/>',
        clip:
            '<path d="M11 6.5L6.2 11.3a2 2 0 01-2.8-2.8l5.6-5.6a3 3 0 014.2 4.2l-5.6 5.6"/>',
        check: '<path d="M3 8.5l3.5 3.5L13 5"/>',
        chart:
            '<path d="M2.5 13.5V9M6 13.5V4M9.5 13.5V7M13 13.5V2.5"/>',
    };

    // Эмодзи в начале подписи → значок
    var BY_EMOJI = [
        ["📥", "download"], // 📥
        ["⬇", "download"], // ⬇
        ["📄", "file"], // 📄
        ["🖨", "printer"], // 🖨
        ["💾", "save"], // 💾
        ["➕", "plus"], // ➕
        ["＋", "plus"], // ＋
        ["✕", "close"], // ✕
        ["✖", "close"], // ✖
        ["↺", "rotate"], // ↺
        ["🗑", "trash"], // 🗑
        ["📎", "clip"], // 📎
        ["✔", "check"], // ✔
        ["📊", "chart"], // 📊
        ["📈", "chart"], // 📈
    ];

    function svg(name) {
        return (
            '<svg class="uk-ico" viewBox="0 0 16 16" fill="none" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' +
            ICONS[name] +
            "</svg>"
        );
    }

    function injectStyles() {
        if (document.getElementById("uiKitStyles")) return;
        var css = document.createElement("style");
        css.id = "uiKitStyles";
        css.textContent = [
            ".uk-ico{width:14px;height:14px;flex:0 0 14px;vertical-align:-2px}",
            "button .uk-ico,.btn .uk-ico{margin-right:2px}",
            /* кнопка = значок + подпись в одну линию */
            "button,.btn{display:inline-flex;align-items:center;gap:7px;",
            "white-space:nowrap;line-height:1}",
            /* Панель под таблицей: одна главная кнопка, остальные спокойные.
               Раньше «Excel» и «Печать» были одинаково зелёными, а «Вернуть
               типовые строки» — оранжевой, и глазу не за что зацепиться. */
            ".sx-bar,.buttons{align-items:center}",
            ".buttons .btn-success,.buttons .btn-secondary{",
            "background:#fff!important;color:var(--c-gray-700)!important;",
            "border:1px solid var(--c-gray-300)!important;box-shadow:none!important}",
            ".buttons .btn-success:hover,.buttons .btn-secondary:hover{",
            "background:var(--c-gray-50)!important;border-color:var(--accent)!important;",
            "color:var(--accent)!important}",
            ".buttons .btn-success .uk-ico{color:var(--c-success)}",
            ".buttons .btn-danger{background:#fff!important;",
            "color:#b91c1c!important;border:1px solid #fecaca!important;",
            "box-shadow:none!important}",
            ".buttons .btn-danger:hover{background:#fef2f2!important;",
            "border-color:#f87171!important}",
            /* ── Чтобы цифры не плыли ──────────────────────────────
               Три причины, по которым числа в одной колонке стояли в трёх
               разных местах:
                 • .formula-cell прижата вправо, а .auto-cell не имела
                   правила выравнивания и наследовала «по центру» от td;
                 • поле ввода смещено внутрь ячейки на свою рамку и отступ,
                   поэтому его цифры не совпадали с расчётными;
                 • на наведении и фокусе у поля менялась рамка — строка
                   дёргалась.
               Ниже всё приводится к одной геометрии: отступ 6/10 у любой
               ячейки с числом, рамка рисуется внутренней тенью и потому
               не занимает места. */
            "td.formula-cell,td.auto-cell,tr.total-row td,tr.summary-row td,",
            "tr.grand-total-row td,tr.fot-row td,tr.sx-total td,",
            ".sc-value,.summary-card .value,td.editable input{",
            "font-variant-numeric:tabular-nums}",
            "td.auto-cell,td.formula-cell{text-align:right!important}",
            "td.editable{padding:0!important}",
            "td.editable input{width:100%;height:100%;min-height:26px;",
            "padding:6px 10px!important;text-align:right;",
            "border:0!important;box-shadow:none!important;border-radius:0!important}",
            "td.editable input[type=text]{text-align:left}",
            "td.editable input:hover{",
            "box-shadow:inset 0 0 0 1px var(--c-gray-300,#cbd5e1)!important}",
            "td.editable input:focus{background:#fff;",
            "box-shadow:inset 0 0 0 2px var(--c-primary,#2563eb)!important}",
            /* Число не переносится и не меняет высоту строки */
            "td.formula-cell,td.auto-cell,tr.sx-total td{white-space:nowrap}",
            /* Подпись поверх поля ввода: показывает число с разрядами,
               пока поле не в фокусе.
               overflow:hidden обязателен — без него длинное число вылезало
               из узкой ячейки и наезжало на соседнюю колонку. */
            "td.editable{position:relative;overflow:hidden}",
            /* У закреплённых колонок position задаёт sheet-ux.js. Правило
               выше по весу перебивало его на relative, а relative вместе с
               выставленным left реально сдвигает ячейку — колонка наезжала
               на соседнюю. sticky тоже позиционирован, поэтому подпись
               поверх поля внутри него работает как надо. */
            "td.editable.sux-freeze{position:sticky}",
            // отступы совпадают с полем ввода — при входе в ячейку число
            // остаётся на месте, а не подпрыгивает
            ".uk-shadow{position:absolute;inset:0;display:flex;align-items:center;",
            "justify-content:flex-end;padding:6px 10px;pointer-events:none;",
            "overflow:hidden;white-space:nowrap;",
            "font-family:var(--font-mono,monospace);font-size:12px;",
            "font-variant-numeric:tabular-nums;",
            "color:var(--c-gray-900);background:inherit}",
            "td.editable.uk-editing .uk-shadow{display:none}",
            "td.editable.uk-shaded input{color:transparent;caret-color:transparent}",
            "td.editable.uk-editing input{color:inherit;caret-color:auto}",
            /* Масштаб таблиц: zoom не ломает поток и полосы прокрутки,
               в отличие от transform: scale */
            ".uk-zoom{display:inline-flex;align-items:center;gap:2px;",
            "border:1px solid var(--c-gray-300,#cbd5e1);border-radius:8px;",
            "background:#fff;overflow:hidden}",
            ".uk-zoom button{padding:3px 9px;border:0;background:none;",
            "font:600 12px/1 var(--font,system-ui);color:var(--c-gray-600,#475569);",
            "cursor:pointer;gap:0}",
            ".uk-zoom button:hover{background:var(--c-gray-50,#f8fafc);",
            "color:var(--c-primary,#2563eb)}",
            ".uk-zoom .uk-zoom-val{min-width:46px;text-align:center;",
            "font-variant-numeric:tabular-nums}",
            "@media print{.uk-zoom{display:none}}",
        ].join("");
        document.head.appendChild(css);
    }

    /* ── Замена эмодзи на значки ───────────────────────────────── */
    function decorate(root) {
        var nodes = (root || document).querySelectorAll(
            "button:not([data-uk]),.btn:not([data-uk])",
        );
        Array.prototype.forEach.call(nodes, function (el) {
            el.dataset.uk = "1";
            // только простая подпись: где внутри уже своя разметка, не лезем
            if (el.children.length) return;
            var text = el.textContent;
            for (var i = 0; i < BY_EMOJI.length; i++) {
                var emoji = BY_EMOJI[i][0];
                if (text.indexOf(emoji) === -1) continue;
                var rest = text
                    .split(emoji)
                    .join("")
                    .replace(/[️‍]/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                el.innerHTML = svg(BY_EMOJI[i][1]) + (rest ? "<span>" + rest + "</span>" : "");
                return;
            }
        });
    }

    /* ── Числа ─────────────────────────────────────────────────── */
    var NBSP = " ";

    function toNumber(raw) {
        var t = String(raw == null ? "" : raw)
            .replace(/[\s ₸]/g, "")
            .replace(",", ".");
        if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
        var n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
    }

    function money(n) {
        return n.toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    var CELLS =
        "td.formula-cell,td.auto-cell,tr.total-row td,tr.summary-row td," +
        "tr.grand-total-row td,tr.fot-row td,tr.sx-total td";

    // На карточках сверху лежат и суммы, и счётчики («Строк в таблице»,
    // «Штатных единиц»). Счётчик, превращённый в «16,00», читается хуже
    // исходного, поэтому там формат наводим только там, где дробная часть
    // уже есть — то есть где это деньги.
    var CARDS = ".sc-value,.summary-card .value";

    function paintCell(el, onlyIfDecimal) {
        if (el.hasAttribute("data-plain")) return;
        if (el.querySelector("input,select,button")) return;
        var text = el.textContent;
        if (onlyIfDecimal && text.indexOf(",") === -1 && text.indexOf(".") === -1) {
            return;
        }
        var n = toNumber(text);
        if (n === null) return;
        var next = money(n);
        // пишем, только если поменялось — иначе MutationObserver будет
        // будить сам себя без конца
        if (text !== next) el.textContent = next;
    }

    function formatCells(root) {
        var scope = root || document;
        Array.prototype.forEach.call(scope.querySelectorAll(CELLS), function (el) {
            paintCell(el, false);
        });
        Array.prototype.forEach.call(scope.querySelectorAll(CARDS), function (el) {
            paintCell(el, true);
        });
    }

    /* ── Подпись поверх поля ввода ─────────────────────────────── */
    function shadeInputs(root) {
        var inputs = (root || document).querySelectorAll(
            'td.editable input[type="number"]',
        );
        Array.prototype.forEach.call(inputs, function (inp) {
            var td = inp.parentNode;
            if (!td || td.tagName !== "TD") return;

            var span = td.querySelector(".uk-shadow");
            if (!span) {
                span = document.createElement("span");
                span.className = "uk-shadow";
                td.appendChild(span);
                td.classList.add("uk-shaded");

                inp.addEventListener("focus", function () {
                    td.classList.add("uk-editing");
                });
                inp.addEventListener("blur", function () {
                    td.classList.remove("uk-editing");
                    paint();
                });
                inp.addEventListener("input", paint);
                // клик по ячейке мимо поля — всё равно в поле
                td.addEventListener("mousedown", function (e) {
                    if (e.target === span) inp.focus();
                });
            }

            paint();

            function paint() {
                var n = toNumber(inp.value);
                var next = n === null ? inp.value : money(n);
                if (span.textContent !== next) span.textContent = next;
            }
        });
    }

    /* ── Ширины колонок ────────────────────────────────────────── */
    /* По умолчанию браузер пересчитывает ширину колонок под содержимое:
       набрал лишнюю цифру — колонка стала шире, а весь ряд поехал вбок.
       Поэтому один раз замеряем сложившиеся ширины, записываем их в
       colgroup и переводим таблицу в режим фиксированных колонок. Дальше
       ввод на разметку не влияет. */
    // Сколько колонок в строке с учётом объединений
    function spanCount(tr) {
        var n = 0;
        for (var i = 0; i < tr.cells.length; i++) {
            n += parseInt(tr.cells[i].getAttribute("colspan"), 10) || 1;
        }
        return n;
    }

    function freezeWidths(table) {
        if (table.dataset.ukFrozen) return;

        /* Таблицы с закреплёнными первыми колонками не трогаем. Их геометрию
           ведёт sheet-ux.js: он выставляет каждой такой колонке смещение
           left, и оно должно совпадать с шириной предыдущих. Если ширины
           здесь переопределить, закреплённая колонка начинает наезжать на
           соседнюю и закрывать собой числа — ровно то, что и требовалось
           убрать. Выравнивание и отступы к таким таблицам применяются всё
           равно, а ширины остаются на усмотрение браузера. */
        if (table.querySelector(".sux-freeze")) return;
        if (table.dataset.stickyCols && Number(table.dataset.stickyCols) > 0) return;

        /* Мерить по шапке нельзя: в многоярусной шапке нижняя строка
           содержит только те подписи, что не растянуты вниз через rowspan.
           У «План-Факта» это три ячейки на тринадцать колонок — записав
           такие ширины, таблицу бы перекосило. Поэтому берём строку данных:
           в ней ячеек ровно столько же, сколько колонок. */
        var cols = 0;
        var bodies = table.tBodies;
        var b, r;
        for (b = 0; b < bodies.length; b++) {
            for (r = 0; r < bodies[b].rows.length; r++) {
                var n = spanCount(bodies[b].rows[r]);
                if (n > cols) cols = n;
            }
        }
        if (cols < 2) return;

        var row = null;
        for (b = 0; b < bodies.length && !row; b++) {
            for (r = 0; r < bodies[b].rows.length; r++) {
                var tr = bodies[b].rows[r];
                if (tr.cells.length !== cols) continue;
                if (spanCount(tr) !== cols) continue; // есть объединения
                row = tr;
                break;
            }
        }
        if (!row) return; // не нашли ровной строки — не рискуем

        var cells = row.cells;
        var widths = [];
        var sum = 0;
        for (var c = 0; c < cells.length; c++) {
            var w = Math.round(cells[c].getBoundingClientRect().width);
            widths.push(w);
            sum += w;
        }
        // Ничего не отрисовано (страница скрыта, тест) — замерять нечего
        if (sum <= 0) return;

        var group = table.querySelector("colgroup");
        if (group) group.parentNode.removeChild(group);

        group = document.createElement("colgroup");
        widths.forEach(function (w) {
            var col = document.createElement("col");
            col.style.width = w + "px";
            group.appendChild(col);
        });
        table.insertBefore(group, table.firstChild);

        table.style.tableLayout = "fixed";
        table.style.width = sum + "px";
        table.style.minWidth = "100%";
        table.dataset.ukFrozen = String(cells.length);
    }

    function freezeAll() {
        var tables = document.querySelectorAll("table");
        Array.prototype.forEach.call(tables, function (t) {
            if (t.closest(".finka-nav")) return;
            // Состав колонок изменился (сменили филиал, дорисовали месяц) —
            // замеряем заново
            if (t.dataset.ukFrozen) {
                var group = t.querySelector("colgroup");
                var body = t.tBodies[0];
                var now = body && body.rows.length ? spanCount(body.rows[0]) : 0;
                if (group && now && now !== group.children.length) {
                    delete t.dataset.ukFrozen;
                    t.style.tableLayout = "";
                    t.style.width = "";
                }
            }
            freezeWidths(t);
        });
    }

    /* ── Масштаб таблиц ────────────────────────────────────────── */
    /* Таблицы бюджета широкие: у штатного расписания 33 колонки, у
       тарификации 90. На обычном экране всё это либо не влезает, либо
       читается с трудом. Масштаб запоминается для каждой страницы
       отдельно — у «Сводной общей» и у «Доходов» нужды разные. */
    var STEPS = [60, 70, 80, 90, 100, 110, 125, 150];
    var ZOOM_KEY = "zoom_" + (location.pathname.split("/").pop() || "index.html");

    function zoomValue() {
        var v = parseInt(localStorage.getItem(ZOOM_KEY), 10);
        return STEPS.indexOf(v) === -1 ? 100 : v;
    }

    function applyZoom() {
        var v = zoomValue();
        var boxes = document.querySelectorAll(".table-container, .table-wrap");
        Array.prototype.forEach.call(boxes, function (el) {
            el.style.zoom = v === 100 ? "" : v / 100;
        });
        var label = document.querySelector(".uk-zoom .uk-zoom-val");
        if (label) label.textContent = v + " %";
    }

    function stepZoom(dir) {
        var i = STEPS.indexOf(zoomValue());
        var next = STEPS[Math.min(STEPS.length - 1, Math.max(0, i + dir))];
        localStorage.setItem(ZOOM_KEY, String(next));
        applyZoom();
    }

    function buildZoom() {
        if (document.querySelector(".uk-zoom")) return;
        if (!document.querySelector(".table-container, .table-wrap")) return;

        var box = document.createElement("div");
        box.className = "uk-zoom";
        box.title = "Масштаб таблицы. Нажмите на число, чтобы вернуть 100 %";
        box.innerHTML =
            '<button type="button" data-z="-1" aria-label="Мельче">−</button>' +
            '<button type="button" class="uk-zoom-val" data-z="0">100 %</button>' +
            '<button type="button" data-z="1" aria-label="Крупнее">+</button>';

        box.addEventListener("click", function (e) {
            var btn = e.target.closest("button");
            if (!btn) return;
            var d = Number(btn.dataset.z);
            if (d === 0) {
                localStorage.setItem(ZOOM_KEY, "100");
                applyZoom();
            } else {
                stepZoom(d);
            }
        });

        // В шапку рядом с состоянием базы, а если шапки нет — над таблицей
        var slot = document.querySelector(".finka-nav-right");
        if (slot) {
            slot.insertBefore(box, slot.firstChild);
        } else {
            var t = document.querySelector(".table-container, .table-wrap");
            t.parentNode.insertBefore(box, t);
            box.style.marginBottom = "8px";
        }
        applyZoom();
    }

    /* ── Запуск ────────────────────────────────────────────────── */
    var timer = null;
    var observer = null;

    /* Собственные правки не должны будить наблюдателя.
       Одного флага «занят» мало: MutationObserver отдаёт записи не сразу, а
       после выхода из apply, когда флаг уже снят. Тогда ui-kit будит
       sheet-edit, тот дописывает итоги, будит ui-kit — и страница
       перерисовывается без остановки. Поэтому на время работы наблюдение
       выключаем, а накопившиеся записи выбрасываем. */
    function apply() {
        if (observer) observer.disconnect();
        try {
            decorate();
            formatCells();
            shadeInputs();
            buildZoom();
            freezeAll();
            // sheet-ux.js закрепил первые колонки до наших правок отступов —
            // просим пересчитать смещения, иначе они наедут на соседние
            document.dispatchEvent(new CustomEvent("finka:layout"));
        } finally {
            if (observer) {
                observer.takeRecords();
                observer.observe(document.body, { childList: true, subtree: true });
            }
        }
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(apply, 140);
    }

    function start() {
        injectStyles();
        observer = new MutationObserver(schedule);
        apply();

        // страницы пересчитывают ячейки при вводе — подхватываем
        document.addEventListener("input", schedule);
    }

    window.finkaUi = {
        apply: apply,
        money: money,
        toNumber: toNumber,
        zoom: zoomValue,
        setZoom: function (v) {
            localStorage.setItem(ZOOM_KEY, String(v));
            applyZoom();
        },
        steps: STEPS,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
