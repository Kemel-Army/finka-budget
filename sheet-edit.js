/**
 * FINKA Budget System — редактирование поверх готовых страниц.
 *
 * Подключается одной строкой перед </body>, после скриптов страницы:
 *     <script src="sheet-edit.js"></script>
 *
 * Что добавляет любой таблице, ничего не ломая:
 *   • наименования строк и заголовки колонок правятся прямо на месте
 *   • ➕ добавить строку / ✕ удалить добавленную
 *   • строка «ИТОГО по таблице» — сумма по каждой числовой колонке
 *
 * Почему надстройка, а не переписывание страниц: у страниц свои расчёты,
 * сверенные с исходными книгами Excel (см. tests/run.mjs). Модуль их не
 * трогает — он читает уже посчитанные значения и хранит свои правки
 * отдельным ключом. Собственная строка итогов у страницы (.total-row)
 * из подсчёта исключается, иначе суммы удвоятся.
 *
 * Правки лежат в ключе  sheet_edits_<страница>_<филиал>  и накладываются
 * поверх данных страницы после её отрисовки.
 */
(function () {
    "use strict";

    var PAGE = location.pathname.split("/").pop() || "index.html";

    // Страницы без таблиц бюджета и страницы с собственным движком, где
    // всё это уже есть
    var SKIP = [
        "", "index.html", "index-budget.html", "dashboard.html", "login.html",
        "business-process.html", "import-excel.html", "osnovaniya.html",
        "shtatnoe.html", "spravki.html", "plan-finansirovaniya.html",
        "plan-fact-pu.html", "plan-fact-dt.html", "plan-fact-pu-dt.html",
    ];
    if (SKIP.indexOf(PAGE) !== -1) return;

    var LOCK = false; // защита от повторного входа
    var timer = null;
    var observer = null;

    /* ── Стили ─────────────────────────────────────────────────── */
    function injectStyles() {
        if (document.getElementById("sheetEditStyles")) return;
        var css = document.createElement("style");
        css.id = "sheetEditStyles";
        css.textContent = [
            ".sx-name{outline:none;cursor:text}",
            ".sx-name:hover{background:var(--c-primary-light)!important;",
            "box-shadow:inset 0 0 0 1px var(--c-gray-300)}",
            ".sx-name:focus{background:#fff!important;",
            "box-shadow:inset 0 0 0 2px var(--c-primary)}",
            ".sx-name.sx-changed{box-shadow:inset 2px 0 0 var(--c-primary)}",
            /* итоговая строка модуля — отличается от собственной строки страницы */
            ".sx-total td{font-weight:800!important;background:#eef2ff!important;",
            "color:#1e293b!important;border-top:2px solid var(--c-primary)!important;",
            "font-variant-numeric:tabular-nums}",
            ".sx-total td.sx-total-label{text-align:left}",
            /* добавленные строки */
            ".sx-extra td{background:#fffdf5!important}",
            ".sx-extra .sx-del{border:none;background:none;color:#e74c3c;",
            "cursor:pointer;font-size:13px;line-height:1;padding:0 6px 0 0}",
            ".sx-extra input{width:100%}",
            /* панель под таблицей */
            ".sx-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;",
            "margin:8px 0 18px;font-size:12px;color:var(--c-gray-500)}",
            ".sx-bar button{padding:6px 12px;font-size:12px;font-weight:600;",
            "border:1px solid var(--c-gray-300);border-radius:8px;background:#fff;",
            "color:var(--c-gray-700);cursor:pointer}",
            ".sx-bar button:hover{background:var(--c-gray-50);",
            "border-color:var(--c-primary);color:var(--c-primary)}",
            ".sx-bar .sx-add{border-color:#27ae60;color:#1e8449}",
            ".sx-bar .sx-add:hover{background:#eafaf1;border-color:#1e8449}",
            "@media print{.sx-bar{display:none}}",
        ].join("");
        document.head.appendChild(css);
    }

    /* ── Филиал ────────────────────────────────────────────────── */
    function activeBranch() {
        var btn = document.querySelector(".branch-btn.active[data-branch]");
        if (btn) return btn.getAttribute("data-branch");
        // часть страниц переключает филиал через onclick="switchBranch('almaty')"
        var alt = document.querySelector(".branch-btn.active[onclick]");
        if (alt) {
            var m = /switchBranch\(['"]([^'"]+)/.exec(alt.getAttribute("onclick"));
            if (m) return m[1];
        }
        return "nao";
    }

    function storageKey() {
        return "sheet_edits_" + PAGE + "_" + activeBranch();
    }

    function readEdits() {
        try {
            return JSON.parse(localStorage.getItem(storageKey())) || {};
        } catch (e) {
            return {};
        }
    }

    // Тихо: writeEdits зовётся на каждое нажатие клавиши, всплывашка на
    // каждый символ только мешает
    function writeEdits(data) {
        data._lastUpdate = new Date().toLocaleString("ru-RU");
        localStorage.setItem(storageKey(), JSON.stringify(data));
    }

    function toast(text) {
        if (window.finkaToast) window.finkaToast(text, "success");
    }

    /* ── Разбор таблицы ────────────────────────────────────────── */
    function tables() {
        var list = [];
        var all = document.querySelectorAll("table");
        for (var i = 0; i < all.length; i++) {
            var t = all[i];
            if (t.hasAttribute("data-no-sheet-edit")) continue;
            if (t.closest(".finka-nav")) continue;
            if (!t.tBodies.length) continue;
            list.push(t);
        }
        return list;
    }

    // Ячейки строки, разложенные по видимым колонкам с учётом colspan
    function byColumn(tr) {
        var map = [];
        var col = 0;
        for (var i = 0; i < tr.cells.length; i++) {
            var cell = tr.cells[i];
            var span = parseInt(cell.getAttribute("colspan"), 10) || 1;
            for (var s = 0; s < span; s++) map[col + s] = cell;
            col += span;
        }
        return map;
    }

    function isServiceRow(tr) {
        if (tr.classList.contains("sx-total")) return true;
        if (tr.classList.contains("total-row")) return true;
        if (tr.classList.contains("summary-row")) return true;
        if (tr.classList.contains("grand-total-row")) return true;
        if (tr.classList.contains("fot-row")) return true;
        if (tr.querySelector(".title-cell")) return true;
        return false;
    }

    // Строка с данными: есть поле ввода или расчётная ячейка.
    // Тип поля не проверяем: на части страниц суммы лежат в <input> без
    // type или в type="text" — там ориентируемся на содержимое колонки
    function isDataRow(tr) {
        if (isServiceRow(tr)) return false;
        return !!tr.querySelector("input, .formula-cell, .auto-cell");
    }

    function dataRows(table) {
        var out = [];
        for (var b = 0; b < table.tBodies.length; b++) {
            var rows = table.tBodies[b].rows;
            for (var i = 0; i < rows.length; i++) {
                if (isDataRow(rows[i])) out.push(rows[i]);
            }
        }
        return out;
    }

    function columnCount(table) {
        var max = 0;
        var scan = function (rows) {
            for (var i = 0; i < rows.length; i++) {
                var n = byColumn(rows[i]).length;
                if (n > max) max = n;
            }
        };
        if (table.tHead) scan(table.tHead.rows);
        for (var b = 0; b < table.tBodies.length; b++) scan(table.tBodies[b].rows);
        return max;
    }

    function toNumber(raw) {
        var t = String(raw == null ? "" : raw)
            .replace(/[\s ₸]/g, "")
            .replace(/%$/, "")
            .replace(",", ".");
        if (!t) return null;
        if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
        var n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
    }

    /* Значение ячейки для суммирования.
       null — «здесь не число», 0 — «число, но пусто».
       Пустое поле само по себе ни о чём не говорит: числовая колонка
       определяется по всей таблице в columnKinds(). */
    function numeric(cell) {
        if (!cell) return null;
        var inp = cell.querySelector("input");
        if (inp) {
            if (inp.type === "date" || inp.type === "checkbox") return null;
            var v = toNumber(inp.value);
            if (v !== null) return v;
            return inp.type === "number" ? 0 : null;
        }
        if (
            cell.classList.contains("formula-cell") ||
            cell.classList.contains("auto-cell")
        ) {
            var n = toNumber(cell.textContent);
            return n === null ? 0 : n;
        }
        return null; // текстовая колонка — не суммируем
    }

    /* Числовая ли колонка: да, если хоть в одной строке там разобралось
       число. Иначе колонка, где при первом открытии страницы все поля
       пустые, выпадала бы из итога целиком. */
    function columnKinds(rows, cols) {
        var kinds = new Array(cols).fill(false);
        rows.forEach(function (tr) {
            var map = byColumn(tr);
            var seen = [];
            for (var c = 0; c < cols; c++) {
                var cell = map[c];
                if (!cell || seen.indexOf(cell) !== -1) continue;
                seen.push(cell);
                if (kinds[c]) continue;
                if (cell.querySelector('input[type="number"]')) kinds[c] = true;
                else if (numeric(cell) !== null) kinds[c] = true;
            }
        });
        return kinds;
    }

    function fmt(v) {
        return v.toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    /* ── Редактируемые наименования ────────────────────────────── */
    function makeNamesEditable(table, tIdx, edits) {
        var names = edits.names || {};

        function attach(cell, key) {
            if (cell.dataset.sxName) return;
            if (cell.querySelector("input, select, button, a")) return;
            cell.dataset.sxName = key;
            cell.classList.add("sx-name");
            cell.setAttribute("contenteditable", "true");
            if (names[key] !== undefined && cell.textContent !== names[key]) {
                cell.textContent = names[key];
            }
            if (names[key] !== undefined) cell.classList.add("sx-changed");
            cell.addEventListener("blur", function () {
                var data = readEdits();
                data.names = data.names || {};
                var text = cell.textContent.replace(/\s+/g, " ").trim();
                if (text === (cell.dataset.sxOrig || "")) delete data.names[key];
                else data.names[key] = text;
                writeEdits(data);
                cell.classList.toggle("sx-changed", data.names[key] !== undefined);
                toast("Наименование сохранено");
            });
            cell.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    cell.blur();
                }
            });
            if (cell.dataset.sxOrig === undefined) {
                cell.dataset.sxOrig = names[key] !== undefined
                    ? ""
                    : cell.textContent.replace(/\s+/g, " ").trim();
            }
        }

        // заголовки колонок
        if (table.tHead) {
            for (var r = 0; r < table.tHead.rows.length; r++) {
                var hcells = table.tHead.rows[r].cells;
                for (var c = 0; c < hcells.length; c++) {
                    attach(hcells[c], "t" + tIdx + "h" + r + "c" + c);
                }
            }
        }

        // наименования строк
        dataRows(table).forEach(function (tr, ri) {
            var cells = tr.cells;
            for (var c = 0; c < cells.length; c++) {
                if (cells[c].querySelector("input")) continue;
                if (cells[c].classList.contains("formula-cell")) continue;
                if (cells[c].classList.contains("auto-cell")) continue;
                attach(cells[c], "t" + tIdx + "r" + ri + "c" + c);
            }
        });
    }

    /* ── Строка «ИТОГО по таблице» ─────────────────────────────── */
    function renderTotal(table) {
        // Считаем и по добавленным строкам тоже — они такие же данные
        var rows = dataRows(table);
        if (!rows.length) return;

        var cols = columnCount(table);
        var kinds = columnKinds(rows, cols);
        var sums = new Array(cols).fill(null);

        rows.forEach(function (tr) {
            var map = byColumn(tr);
            var seen = [];
            for (var c = 0; c < cols; c++) {
                if (!kinds[c]) continue;
                var cell = map[c];
                if (!cell || seen.indexOf(cell) !== -1) continue;
                seen.push(cell);
                var v = numeric(cell);
                sums[c] = (sums[c] || 0) + (v === null ? 0 : v);
            }
        });

        var body = table.tBodies[table.tBodies.length - 1];
        var tr = body.querySelector("tr.sx-total");
        if (!tr) {
            tr = document.createElement("tr");
            tr.className = "sx-total";
            for (var c = 0; c < cols; c++) {
                var td = document.createElement("td");
                if (c === 0) {
                    td.className = "sx-total-label";
                    td.textContent = "ИТОГО по таблице";
                }
                tr.appendChild(td);
            }
            body.appendChild(tr);
        }

        // Пишем, только если значение изменилось: иначе каждая запись —
        // мутация, MutationObserver снова зовёт apply(), и страница крутится
        // в бесконечном цикле перерисовок
        for (var i = 0; i < cols; i++) {
            var cell = tr.cells[i];
            if (!cell || i === 0) continue;
            var text = sums[i] === null ? "" : fmt(sums[i]);
            if (cell.textContent !== text) cell.textContent = text;
            cell.style.textAlign = "right";
        }
    }

    /* ── Добавленные строки ────────────────────────────────────── */
    // Шаблон новой строки: числовые колонки берём по всей таблице (в одной
    // строке они могут быть пустыми), остальные считаем текстовыми
    function rowShape(table) {
        var own = dataRows(table).filter(function (tr) {
            return !tr.classList.contains("sx-extra");
        });
        if (!own.length) return null;
        var cols = columnCount(table);
        var kinds = columnKinds(own, cols);
        var map = byColumn(own[0]);
        var shape = [];
        var seen = [];
        for (var c = 0; c < cols; c++) {
            var cell = map[c];
            if (cell && seen.indexOf(cell) !== -1) {
                shape.push("skip");
                continue;
            }
            if (cell) seen.push(cell);
            shape.push(kinds[c] ? "num" : "text");
        }
        return shape;
    }

    function buildExtraRow(table, tIdx, rec, idx) {
        var shape = rowShape(table);
        if (!shape) return null;
        var tr = document.createElement("tr");
        tr.className = "sx-extra";
        tr.dataset.sxExtra = String(idx);

        shape.forEach(function (kind, c) {
            if (kind === "skip") return;
            var td = document.createElement("td");

            if (c === 0) {
                var del = document.createElement("button");
                del.type = "button";
                del.className = "sx-del";
                del.textContent = "✕";
                del.title = "Удалить строку";
                del.addEventListener("click", function () {
                    if (!confirm("Удалить добавленную строку?")) return;
                    var data = readEdits();
                    (data.extra || []).splice(idx, 1);
                    writeEdits(data);
                    toast("Строка удалена");
                    apply();
                });
                td.appendChild(del);
            }

            if (kind === "num") {
                td.className = "editable";
                var num = document.createElement("input");
                num.type = "number";
                num.step = "0.01";
                num.value = rec.cells[c] != null ? rec.cells[c] : 0;
                num.addEventListener("input", function () {
                    var data = readEdits();
                    data.extra = data.extra || [];
                    if (!data.extra[idx]) data.extra[idx] = { cells: {} };
                    data.extra[idx].cells[c] = parseFloat(num.value) || 0;
                    writeEdits(data);
                    renderTotal(table);
                });
                td.appendChild(num);
            } else {
                td.className = "editable";
                var txt = document.createElement("input");
                txt.type = "text";
                txt.value = rec.cells[c] != null ? rec.cells[c] : "";
                txt.placeholder = c === 0 ? "" : "наименование";
                txt.addEventListener("input", function () {
                    var data = readEdits();
                    data.extra = data.extra || [];
                    if (!data.extra[idx]) data.extra[idx] = { cells: {} };
                    data.extra[idx].cells[c] = txt.value;
                    writeEdits(data);
                });
                td.appendChild(txt);
            }
            tr.appendChild(td);
        });

        return tr;
    }

    function renderExtra(table, tIdx, edits) {
        var body = table.tBodies[table.tBodies.length - 1];
        // Перестраиваем только когда состав добавленных строк действительно
        // изменился — иначе каждая перерисовка порождает мутацию и цикл
        var list = edits.extra || [];
        var sig = JSON.stringify(list);
        var present = body.querySelectorAll("tr.sx-extra").length;
        // страница могла перерисовать тело таблицы и стереть наши строки —
        // тогда подпись совпадает, а строк уже нет
        if (body.dataset.sxExtraSig === sig && present === list.length) return;
        body.dataset.sxExtraSig = sig;

        Array.prototype.slice
            .call(body.querySelectorAll("tr.sx-extra"))
            .forEach(function (tr) {
                tr.parentNode.removeChild(tr);
            });

        var anchor = body.querySelector("tr.sx-total");
        list.forEach(function (rec, i) {
            var tr = buildExtraRow(table, tIdx, rec || { cells: {} }, i);
            if (!tr) return;
            if (anchor) body.insertBefore(tr, anchor);
            else body.appendChild(tr);
        });
    }

    /* ── Панель под таблицей ───────────────────────────────────── */
    /* Пока в таблице нет ни одной строки, не по чему построить новую: на
       таких страницах (планы командировок) первую строку заводит собственная
       кнопка страницы. Состояние обновляем при каждой перерисовке. */
    function refreshAddState(table, add) {
        var ready = !!rowShape(table);
        add.disabled = !ready;
        add.style.opacity = ready ? "1" : ".5";
        add.style.cursor = ready ? "pointer" : "not-allowed";
        add.title = ready
            ? "Добавить строку в конец таблицы"
            : "Заведите первую строку кнопкой страницы — дальше строки добавляются отсюда";
    }

    function renderBar(table, tIdx) {
        var host = table.closest(".table-container, .table-wrap") || table;
        var existing = host.nextElementSibling;
        if (existing && existing.classList && existing.classList.contains("sx-bar")) {
            refreshAddState(table, existing.querySelector(".sx-add"));
            return;
        }

        var bar = document.createElement("div");
        bar.className = "sx-bar";

        var add = document.createElement("button");
        add.type = "button";
        add.className = "sx-add";
        add.textContent = "➕ Добавить строку";
        refreshAddState(table, add);
        add.addEventListener("click", function () {
            var data = readEdits();
            data.extra = data.extra || [];
            data.extra.push({ cells: {} });
            writeEdits(data);
            toast("Строка добавлена");
            apply();
            var last = table.querySelector("tr.sx-extra:last-of-type input");
            if (last) last.focus();
        });
        bar.appendChild(add);

        var reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "↺ Сбросить правки";
        reset.title = "Убрать переименования и добавленные строки на этой странице";
        reset.addEventListener("click", function () {
            if (!confirm(
                "Убрать все переименования и добавленные строки на этой странице? " +
                "Суммы, введённые в исходные поля, останутся.",
            )) return;
            localStorage.removeItem(storageKey());
            location.reload();
        });
        bar.appendChild(reset);

        var hint = document.createElement("span");
        hint.textContent =
            "Наименования строк и заголовки колонок правятся прямо в таблице";
        bar.appendChild(hint);

        host.parentNode.insertBefore(bar, host.nextSibling);
    }

    /* ── Сборка ────────────────────────────────────────────────── */
    /* Собственные правки не должны будить наблюдателя. Одного флага мало:
       MutationObserver отдаёт записи после выхода из apply, когда флаг уже
       снят — и два модуля оформления начинают будить друг друга без конца.
       Поэтому на время работы наблюдение выключаем, а накопившиеся записи
       выбрасываем. */
    function apply() {
        if (LOCK) return;
        LOCK = true;
        if (observer) observer.disconnect();
        try {
            var edits = readEdits();
            tables().forEach(function (table, i) {
                makeNamesEditable(table, i, edits);
                renderTotal(table);
                renderExtra(table, i, edits);
                renderTotal(table);
                renderBar(table, i);
            });
        } finally {
            LOCK = false;
            if (observer) {
                observer.takeRecords();
                observer.observe(document.body, { childList: true, subtree: true });
            }
        }
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(apply, 120);
    }

    function start() {
        injectStyles();
        apply();

        // страницы дорисовывают таблицы своими скриптами и по смене филиала
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });

        // пересчёт итогов при вводе в любые поля страницы
        document.addEventListener("input", function (e) {
            if (LOCK) return;
            var table = e.target.closest && e.target.closest("table");
            if (table) renderTotal(table);
        });

        // смена филиала — другой набор правок
        document.addEventListener("click", function (e) {
            var btn = e.target.closest && e.target.closest(".branch-btn");
            if (btn) setTimeout(apply, 150);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
