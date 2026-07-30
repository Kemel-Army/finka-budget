/**
 * FINKA Budget System — поведение таблиц «как в Excel»
 *
 * Подключается одной строкой перед </body>:
 *     <script src="sheet-ux.js"></script>
 *
 * Что даёт:
 *   • закрепление шапки и первых колонок при прокрутке
 *   • ходьба по ячейкам стрелками, Tab, Enter (как в Excel)
 *   • вставка диапазона из Excel — заполняет сразу много ячеек
 *   • протяжка значения вниз по Ctrl+D
 *   • подсветка текущей строки и колонки
 *   • выделение содержимого при входе в ячейку — сразу можно печатать
 *
 * Настройка на таблице через атрибуты:
 *     <table data-sheet data-sticky-cols="2">
 * Без data-sheet берутся все таблицы внутри .table-container.
 *
 * ВАЖНО: значение поля не форматируется разделителями разрядов.
 * Страницы читают его через parseFloat(el.value), а «1 234,50»
 * parseFloat превращает в 1. Разряды показываются только в расчётных
 * ячейках, которые страницы форматируют сами.
 */
(function () {
    "use strict";

    var STICKY_DEFAULT = 0;

    /* ── Стили ─────────────────────────────────────────────────── */
    function injectStyles() {
        if (document.getElementById("sheetUxStyles")) return;
        var css = document.createElement("style");
        css.id = "sheetUxStyles";
        css.textContent = [
            /* закреплённые колонки */
            ".sux-freeze{position:sticky;z-index:2;background:#fff}",
            "thead .sux-freeze{z-index:11;background:var(--c-gray-50)}",
            ".sux-freeze-last{box-shadow:inset -1px 0 0 var(--c-gray-300)}",
            /* подсветка активной строки и колонки */
            ".sux-row-active > td{background:var(--c-primary-light)!important}",
            ".sux-col-active{background:var(--c-primary-light)!important}",
            /* активная ячейка */
            ".sux-cell-active{outline:2px solid var(--c-primary);outline-offset:-2px;border-radius:3px}",
            /* подсказка снизу */
            ".sux-hint{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);",
            "z-index:9998;display:flex;align-items:center;gap:10px;padding:6px 12px;",
            "font-family:var(--font);font-size:11.5px;color:var(--c-gray-500);",
            "background:#fff;border:1px solid var(--c-gray-200);border-radius:20px;",
            "box-shadow:var(--shadow);pointer-events:none;opacity:0;transition:opacity 200ms ease}",
            ".sux-hint.show{opacity:1}",
            ".sux-hint kbd{font-family:var(--font-mono);font-size:10.5px;padding:1px 4px;",
            "background:var(--c-gray-100);border:1px solid var(--c-gray-300);",
            "border-bottom-width:2px;border-radius:3px;color:var(--c-gray-600)}",
            "@media print{.sux-hint{display:none}}",
        ].join("");
        (document.head || document.documentElement).appendChild(css);
    }

    /* ── Разбор числа: принимает «1 234,56», «1234.56», «-» ─────── */
    function parseNumber(raw) {
        if (raw === null || raw === undefined) return null;
        var s = String(raw).trim();
        if (!s || s === "-" || s === "—" || s === "·") return 0;
        // формулы из буфера не переносим — берём только значения
        if (s.charAt(0) === "=") return null;
        s = s
            .replace(/ | |\s/g, "")
            .replace(/[₸%]/g, "")
            .replace(",", ".");
        var n = parseFloat(s);
        return isNaN(n) ? null : n;
    }

    /* ── Сетка редактируемых ячеек таблицы ─────────────────────── */
    function buildGrid(table) {
        var grid = [];
        var rows = table.tBodies.length
            ? table.tBodies[0].rows
            : table.rows;
        for (var r = 0; r < rows.length; r++) {
            var inputs = rows[r].querySelectorAll(
                'input:not([type="checkbox"]):not([type="hidden"]):not([disabled])',
            );
            if (inputs.length) grid.push(Array.prototype.slice.call(inputs));
        }
        return grid;
    }

    function locate(grid, el) {
        for (var r = 0; r < grid.length; r++) {
            var c = grid[r].indexOf(el);
            if (c !== -1) return { r: r, c: c };
        }
        return null;
    }

    function focusCell(grid, r, c) {
        if (r < 0 || r >= grid.length) return false;
        var row = grid[r];
        if (!row || !row.length) return false;
        var el = row[Math.max(0, Math.min(c, row.length - 1))];
        if (!el) return false;
        el.focus();
        if (el.select) el.select();
        return true;
    }

    /* ── Закрепление первых колонок ────────────────────────────── */
    function freezeColumns(table, count) {
        if (!count) return;

        /* Смещения берём из фактического положения колонок, а не складываем
           измеренные ширины. Сложение копило погрешность: у штатного
           расписания третья закреплённая колонка получала смещение на 20 px
           больше нужного и наезжала на соседнюю — первая буква заголовка
           уходила под неё. */
        function apply() {
            // Сначала снимаем прошлое закрепление, иначе замерим уже
            // сдвинутые колонки и ошибка повторится
            var frozen = table.querySelectorAll(".sux-freeze");
            for (var f = 0; f < frozen.length; f++) {
                frozen[f].classList.remove("sux-freeze", "sux-freeze-last");
                frozen[f].style.left = "";
            }

            var row = null;
            for (var b = 0; b < table.tBodies.length && !row; b++) {
                var rows = table.tBodies[b].rows;
                for (var r = 0; r < rows.length; r++) {
                    if (rows[r].cells.length >= count) {
                        row = rows[r];
                        break;
                    }
                }
            }
            if (!row) return;

            var base = row.cells[0].getBoundingClientRect().left;
            var offsets = [];
            for (var i = 0; i < count; i++) {
                offsets.push(
                    Math.round(row.cells[i].getBoundingClientRect().left - base),
                );
            }

            for (i = 0; i < count; i++) {
                var cells = table.querySelectorAll(
                    "tr > *:nth-child(" + (i + 1) + ")",
                );
                for (var k = 0; k < cells.length; k++) {
                    cells[k].classList.add("sux-freeze");
                    cells[k].style.left = offsets[i] + "px";
                    if (i === count - 1) cells[k].classList.add("sux-freeze-last");
                }
            }
        }

        apply();
        // ширины меняются при перерисовке таблицы страницей
        window.addEventListener("resize", apply);
        /* ui-kit.js правит отступы ячеек и фиксирует ширины уже после нас,
           и замеренные смещения устаревают: закреплённая колонка наезжает
           на соседнюю. Поэтому пересчитываем по его сигналу. */
        (window.finkaSheetUx = window.finkaSheetUx || { apps: [] }).apps.push(apply);
        document.addEventListener("finka:layout", apply);
        var mo = new MutationObserver(function () {
            apply();
        });
        if (table.tBodies.length) {
            mo.observe(table.tBodies[0], { childList: true });
        }
    }

    /* ── Подсветка строки и колонки ────────────────────────────── */
    function highlight(table, el) {
        clearHighlight(table);
        if (!el) return;
        var td = el.closest("td");
        var tr = el.closest("tr");
        if (tr) tr.classList.add("sux-row-active");
        if (td) {
            td.classList.add("sux-col-active");
            el.classList.add("sux-cell-active");
        }
    }

    function clearHighlight(table) {
        var marked = table.querySelectorAll(
            ".sux-row-active,.sux-col-active,.sux-cell-active",
        );
        for (var i = 0; i < marked.length; i++) {
            marked[i].classList.remove(
                "sux-row-active",
                "sux-col-active",
                "sux-cell-active",
            );
        }
    }

    /* ── Подсказка по горячим клавишам ─────────────────────────── */
    var hintEl = null;
    var hintTimer = null;

    function showHint() {
        if (!hintEl) {
            hintEl = document.createElement("div");
            hintEl.className = "sux-hint";
            hintEl.innerHTML =
                "<span><kbd>↑↓←→</kbd> переход</span>" +
                "<span><kbd>Enter</kbd> вниз</span>" +
                "<span><kbd>Tab</kbd> вправо</span>" +
                "<span><kbd>Ctrl</kbd>+<kbd>D</kbd> протянуть</span>" +
                "<span><kbd>Ctrl</kbd>+<kbd>V</kbd> вставить из Excel</span>";
            document.body.appendChild(hintEl);
        }
        hintEl.classList.add("show");
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () {
            hintEl.classList.remove("show");
        }, 4000);
    }

    /* ── Запись значения с уведомлением страницы ───────────────── */
    function setValue(el, value) {
        if (el.disabled || el.readOnly) return false;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    /* ── Вставка диапазона из Excel ────────────────────────────── */
    function handlePaste(table, grid, e) {
        var el = e.target;
        if (!el || el.tagName !== "INPUT") return;

        var raw = (e.clipboardData || window.clipboardData).getData(
            "text/plain",
        );
        if (!raw || raw.indexOf("\t") === -1) {
            if (raw.indexOf("\n") === -1) return; // одна ячейка — обычная вставка
        }

        e.preventDefault();

        var matrix = raw
            .replace(/\r/g, "")
            .replace(/\n$/, "")
            .split("\n")
            .map(function (line) {
                return line.split("\t");
            });

        var at = locate(grid, el);
        if (!at) return;

        var written = 0;
        var skippedFormulas = 0;

        for (var r = 0; r < matrix.length; r++) {
            var targetRow = grid[at.r + r];
            if (!targetRow) break;
            for (var c = 0; c < matrix[r].length; c++) {
                var target = targetRow[at.c + c];
                if (!target) break;
                var cellText = matrix[r][c];
                if (String(cellText).trim().charAt(0) === "=") {
                    skippedFormulas++;
                    continue;
                }
                var value;
                if (target.type === "number") {
                    var n = parseNumber(cellText);
                    if (n === null) continue;
                    value = n;
                } else {
                    value = cellText;
                }
                if (setValue(target, value)) written++;
            }
        }

        if (window.finkaToast) {
            var msg = "Вставлено ячеек: " + written;
            if (skippedFormulas) {
                msg += ", формул пропущено: " + skippedFormulas;
            }
            window.finkaToast(msg, skippedFormulas ? "warning" : "success");
        }
    }

    /* ── Клавиатура ────────────────────────────────────────────── */
    function handleKey(table, grid, e) {
        var el = e.target;
        if (!el || el.tagName !== "INPUT") return;
        var at = locate(grid, el);
        if (!at) return;

        var key = e.key;
        var isText = el.type === "text";

        // Ctrl+D — протянуть значение из строки выше
        if ((e.ctrlKey || e.metaKey) && (key === "d" || key === "в")) {
            e.preventDefault();
            var above = grid[at.r - 1];
            if (above && above[at.c]) setValue(el, above[at.c].value);
            return;
        }

        // В текстовых полях стрелки влево/вправо двигают курсор
        if (isText && (key === "ArrowLeft" || key === "ArrowRight")) return;

        switch (key) {
            case "ArrowUp":
                e.preventDefault();
                focusCell(grid, at.r - 1, at.c);
                break;
            case "ArrowDown":
                e.preventDefault();
                focusCell(grid, at.r + 1, at.c);
                break;
            case "ArrowLeft":
                e.preventDefault();
                if (at.c > 0) focusCell(grid, at.r, at.c - 1);
                else focusCell(grid, at.r - 1, 1e6);
                break;
            case "ArrowRight":
                e.preventDefault();
                if (at.c < grid[at.r].length - 1) focusCell(grid, at.r, at.c + 1);
                else focusCell(grid, at.r + 1, 0);
                break;
            case "Enter":
                e.preventDefault();
                focusCell(grid, e.shiftKey ? at.r - 1 : at.r + 1, at.c);
                break;
            case "Tab":
                // Tab уводит за таблицу на краю — переносим на новую строку
                if (!e.shiftKey && at.c === grid[at.r].length - 1) {
                    if (grid[at.r + 1]) {
                        e.preventDefault();
                        focusCell(grid, at.r + 1, 0);
                    }
                } else if (e.shiftKey && at.c === 0) {
                    if (grid[at.r - 1]) {
                        e.preventDefault();
                        focusCell(grid, at.r - 1, 1e6);
                    }
                }
                break;
            case "Escape":
                el.blur();
                break;
            default:
                break;
        }
    }

    /* ── Подключение к таблице ─────────────────────────────────── */
    function attach(table) {
        if (table.dataset.suxOn) return;
        table.dataset.suxOn = "1";

        var sticky = parseInt(table.dataset.stickyCols, 10);
        if (isNaN(sticky)) sticky = STICKY_DEFAULT;

        var grid = buildGrid(table);

        function refresh() {
            grid = buildGrid(table);
        }

        // страницы перестраивают tbody — обновляем сетку
        if (table.tBodies.length) {
            new MutationObserver(refresh).observe(table.tBodies[0], {
                childList: true,
                subtree: true,
            });
        }

        table.addEventListener("keydown", function (e) {
            handleKey(table, grid, e);
        });
        table.addEventListener("paste", function (e) {
            handlePaste(table, grid, e);
        });
        table.addEventListener("focusin", function (e) {
            if (e.target.tagName !== "INPUT") return;
            highlight(table, e.target);
            if (e.target.select) e.target.select();
            showHint();
        });
        table.addEventListener("focusout", function () {
            clearHighlight(table);
        });

        freezeColumns(table, sticky);
    }

    /* ── Старт ─────────────────────────────────────────────────── */
    function init() {
        injectStyles();
        var tables = document.querySelectorAll(
            "table[data-sheet], .table-container table, .budget-table-wrapper table",
        );
        for (var i = 0; i < tables.length; i++) attach(tables[i]);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // страницы, которые строят таблицу позже, могут позвать вручную
    window.sheetUX = { attach: attach, refresh: init, parseNumber: parseNumber };
})();
