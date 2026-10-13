/**
 * shared-export.js — Единый модуль экспорта (Excel, PDF, Печать) + год для всех страниц
 * Требует: SheetJS (vendor/xlsx-0.20.3.full.min.js) подключённый до этого скрипта
 *
 * Панель «Excel / PDF / Печать» рисуется здесь же, по заглушке в разметке:
 *
 *   <div data-export-bar></div>
 *
 * Необязательные атрибуты заглушки:
 *   data-excel="имяФункции"  — своя выгрузка страницы (window[имя]()); без него
 *                              выгружается таблица целиком через exportTableToExcel
 *   data-table="#селектор"   — какую таблицу выгружать (по умолчанию первая)
 *   data-file="Имя.xlsx"     — имя файла (по умолчанию заголовок страницы
 *                              и выбранный филиал)
 *   data-title="…"           — заголовок первой строки листа
 *   data-pdf="имяФункции"    — своя «PDF» (по умолчанию печать в альбомной)
 *   data-print="имяФункции"  — своя печать (по умолчанию window.print)
 *
 * Страница, которая рисует заглушку позже (через innerHTML), может вызвать
 * SharedExport.mountBars(корень) сама — повторный вызов ничего не ломает.
 */
(function () {
    "use strict";

    /* ── Budget Year helpers ─────────────────────────────── */
    function getBudgetYear() {
        return (
            parseInt(localStorage.getItem("budget_year"), 10) ||
            new Date().getFullYear()
        );
    }
    function getBudgetYearEnd() {
        var start = getBudgetYear();
        var end =
            parseInt(localStorage.getItem("budget_year_end"), 10) || start + 2;
        return Math.max(end, start);
    }
    function getBudgetYearRange() {
        var s = getBudgetYear(),
            e = getBudgetYearEnd();
        var years = [];
        for (var y = s; y <= e; y++) years.push(y);
        return years;
    }
    function getBudgetYearLabel() {
        var s = getBudgetYear(),
            e = getBudgetYearEnd();
        return s === e ? "" + s : s + "–" + e;
    }

    /** Apply year to page — update dyn-year spans and title */
    function applyBudgetYear() {
        var year = getBudgetYear();
        var label = getBudgetYearLabel();
        document.querySelectorAll(".dyn-year").forEach(function (el) {
            el.textContent = String(year);
        });
        document.querySelectorAll(".dyn-year-range").forEach(function (el) {
            el.textContent = label;
        });
        document.querySelectorAll(".dyn-year-label").forEach(function (el) {
            el.textContent = label;
        });
    }

    /* ── Helpers ──────────────────────────────────────────── */
    // Сообщение пользователю: всплывашка, если она есть на странице
    function notify(msg, type) {
        if (typeof window.finkaToast === "function") {
            window.finkaToast(msg, type || "warning");
        } else if (window.console) {
            console.warn(msg);
        }
    }

    function fmt(v) {
        var n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
        return isNaN(n) ? v : n;
    }

    function cellText(td) {
        var inp = td.querySelector("input, select");
        if (inp) return inp.value;
        return td.textContent.trim();
    }

    function cellValue(td, colIdx) {
        var inp = td.querySelector("input, select");
        if (inp) {
            var v = parseFloat(inp.value) || 0;
            return v;
        }
        var txt = td.textContent.trim();
        var num = parseFloat(txt.replace(/\s/g, "").replace(",", "."));
        return isNaN(num) || colIdx < 2 ? txt : num;
    }

    /* ── Считать таблицу в AOA (Array of Arrays) ───────── */
    function tableToAOA(table) {
        var rows = [];
        // thead
        var ths = table.querySelectorAll("thead tr");
        ths.forEach(function (tr) {
            var r = [];
            tr.querySelectorAll("th, td").forEach(function (cell) {
                r.push(cell.textContent.trim());
                // colspan → пустые ячейки
                var cs = parseInt(cell.getAttribute("colspan")) || 1;
                for (var i = 1; i < cs; i++) r.push("");
            });
            rows.push(r);
        });
        // tbody
        var trs = table.querySelectorAll("tbody tr");
        trs.forEach(function (tr) {
            // Проверим section-hdr / col-hdr
            if (tr.classList.contains("col-hdr")) return;
            if (tr.classList.contains("section-hdr")) {
                rows.push([tr.textContent.trim()]);
                return;
            }
            var r = [];
            tr.querySelectorAll("td").forEach(function (td, i) {
                r.push(cellValue(td, i));
            });
            rows.push(r);
        });
        // tfoot
        var tfoot = table.querySelectorAll("tfoot tr");
        tfoot.forEach(function (tr) {
            var r = [];
            tr.querySelectorAll("td, th").forEach(function (td, i) {
                r.push(cellValue(td, i));
            });
            rows.push(r);
        });
        return rows;
    }

    /* ── Определить ширину колонок по данным ──────────── */
    function autoColWidths(aoa) {
        if (!aoa.length) return [];
        var maxCols = 0;
        aoa.forEach(function (r) {
            if (r.length > maxCols) maxCols = r.length;
        });
        var widths = [];
        for (var c = 0; c < maxCols; c++) {
            var maxW = 8;
            aoa.forEach(function (r) {
                if (r[c] !== undefined) {
                    var len = String(r[c]).length;
                    if (len > maxW) maxW = len;
                }
            });
            widths.push({ wch: Math.min(maxW + 2, 50) });
        }
        return widths;
    }

    /* ── Excel экспорт ──────────────────────────────────── */
    function exportTableToExcel(opts) {
        if (typeof XLSX === "undefined") {
            notify("Не удалось выгрузить в Excel: модуль выгрузки не загрузился. Обновите страницу.", "error");
            return;
        }
        var table = opts.table || document.querySelector("table");
        if (typeof table === "string") table = document.querySelector(table);
        if (!table) {
            notify("На странице нет таблицы для выгрузки", "warning");
            return;
        }

        var title = opts.title || document.title;
        var fileName =
            opts.fileName ||
            title.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\- ]/g, "_") + ".xlsx";
        var sheetName = opts.sheetName || "Данные";

        var wb = XLSX.utils.book_new();
        var aoa = [];

        // Заголовок
        if (opts.headerRows) {
            opts.headerRows.forEach(function (r) {
                aoa.push(r);
            });
        } else {
            aoa.push([title]);
            aoa.push([]);
        }

        // Данные таблицы
        var tableData = tableToAOA(table);
        aoa = aoa.concat(tableData);

        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = opts.colWidths || autoColWidths(aoa);

        XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
        XLSX.writeFile(wb, fileName);
    }

    /* ── Excel экспорт нескольких таблиц ────────────────── */
    function exportMultiTableExcel(opts) {
        if (typeof XLSX === "undefined") {
            notify("Не удалось выгрузить в Excel: модуль выгрузки не загрузился. Обновите страницу.", "error");
            return;
        }
        var wb = XLSX.utils.book_new();
        var fileName = opts.fileName || "export.xlsx";

        opts.tables.forEach(function (tOpts) {
            var table = tOpts.table;
            if (typeof table === "string")
                table = document.querySelector(table);
            if (!table) return;

            var aoa = [];
            if (tOpts.headerRows) {
                tOpts.headerRows.forEach(function (r) {
                    aoa.push(r);
                });
            }
            aoa = aoa.concat(tableToAOA(table));

            var ws = XLSX.utils.aoa_to_sheet(aoa);
            ws["!cols"] = tOpts.colWidths || autoColWidths(aoa);
            var name = (tOpts.sheetName || "Лист").substring(0, 31);
            XLSX.utils.book_append_sheet(wb, ws, name);
        });

        XLSX.writeFile(wb, fileName);
    }

    /* ── PDF (через окно печати в ландшафт) ─────────────── */
    function exportToPDF() {
        var style = document.createElement("style");
        style.id = "shared-pdf-print-style";
        style.textContent =
            "@media print {" +
            "  @page { size: landscape; margin: 8mm; }" +
            "  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }" +
            "  .controls, .back-link, .branch-selector, .finka-nav," +
            "  .import-zone, .params-bar, .summary-cards, .info-bar," +
            "  .buttons, .month-selector, .sections-nav," +
            "  .export-bar { display: none !important; }" +
            "  .header { border-bottom: none; padding-bottom: 4px; }" +
            '  input[type="number"], input[type="text"] { border: none !important; background: none !important; padding: 0 !important; }' +
            "  table { font-size: 9px; border-collapse: collapse; width: 100%; }" +
            "  td, th { padding: 3px 5px !important; border: 1px solid #999 !important; }" +
            "  th { background: #e2e8f0 !important; font-weight: 600; }" +
            "  .total-row td, tfoot td { background: #f1f5f9 !important; font-weight: 600; }" +
            "}";
        document.head.appendChild(style);
        window.print();
        setTimeout(function () {
            style.remove();
        }, 1500);
    }

    /* ── Панель «Excel / PDF / Печать» ─────────────────── */
    // Значки те же, что рисует ui-kit.js вместо эмодзи: 16×16, обводкой
    // в currentColor. Свои — чтобы панель выглядела одинаково и там, где
    // ui-kit.js не подключён.
    var BAR_ICONS = {
        excel:
            '<path d="M8 2v8M5 7l3 3 3-3M2 12v1a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 13v-1"/>',
        pdf:
            '<path d="M4 1.5h5l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z"/>' +
            '<path d="M9 1.5v3h3M5.5 8h5M5.5 11h3"/>',
        print:
            '<path d="M4 5.5V2h8v3.5M4 11H2.5v-5h11v5H12M4 11v3h8v-3H4z"/>',
    };

    // Порядок на всех страницах один: Excel → PDF → Печать
    var BAR_BUTTONS = [
        ["excel", "Excel", "Скачать таблицу в Excel"],
        ["pdf", "PDF", "Сохранить в PDF (печать в альбомной ориентации)"],
        ["print", "Печать", "Распечатать страницу"],
    ];

    function barButton(b) {
        return (
            '<button type="button" class="btn export-btn export-btn-' + b[0] +
            '" data-export-action="' + b[0] + '" data-uk="1" title="' + b[2] + '">' +
            '<svg class="uk-ico" viewBox="0 0 16 16" fill="none" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' +
            BAR_ICONS[b[0]] +
            "</svg><span>" + b[1] + "</span></button>"
        );
    }

    /** Нарисовать панели по заглушкам [data-export-bar]; повторно не рисует */
    function mountBars(root) {
        var bars = (root || document).querySelectorAll("[data-export-bar]");
        Array.prototype.forEach.call(bars, function (bar) {
            if (bar.getAttribute("data-export-ready")) return;
            bar.setAttribute("data-export-ready", "1");
            bar.classList.add("export-bar");
            bar.setAttribute("role", "toolbar");
            bar.setAttribute("aria-label", "Выгрузка и печать");
            bar.innerHTML = BAR_BUTTONS.map(barButton).join("");
        });
    }

    // Подпись выбранного филиала — чтобы выгрузки разных филиалов
    // не назывались одинаково
    function activeBranchLabel() {
        var btn = document.querySelector(".branch-btn.active");
        if (!btn) return "";
        return btn.textContent
            .replace(/^[^0-9A-Za-zА-Яа-яЁё«]+/, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function defaultExcel(bar) {
        var title = bar.getAttribute("data-title") || document.title;
        var branch = activeBranchLabel();
        if (branch && title.indexOf(branch) === -1) title += " — " + branch;
        // В имени файла убираем только то, что запрещено в Windows:
        // «ёлочки» и тире названия листа оставляем как есть
        var fileName =
            bar.getAttribute("data-file") ||
            title.replace(/[\\/:*?"<>|]+/g, "_") + ".xlsx";
        exportTableToExcel({
            table: bar.getAttribute("data-table") || null,
            title: title,
            fileName: fileName,
        });
    }

    function runBarAction(bar, kind) {
        var fnName = bar.getAttribute("data-" + kind);
        if (fnName) {
            var fn = /** @type {any} */ (window)[fnName];
            if (typeof fn === "function") {
                fn();
            } else {
                notify("Действие недоступно: страница ещё не загрузилась", "warning");
            }
            return;
        }
        if (kind === "excel") defaultExcel(bar);
        else if (kind === "pdf") exportToPDF();
        else window.print();
    }

    document.addEventListener("click", function (e) {
        var t = e.target;
        var btn = t && t.closest ? t.closest("[data-export-action]") : null;
        if (!btn) return;
        var bar = btn.closest("[data-export-bar]");
        if (!bar) return;
        runBarAction(bar, btn.getAttribute("data-export-action"));
    });

    /* ── Глобальные функции ─────────────────────────────── */
    window.SharedExport = {
        tableToAOA: tableToAOA,
        exportTableToExcel: exportTableToExcel,
        exportMultiTableExcel: exportMultiTableExcel,
        exportToPDF: exportToPDF,
        autoColWidths: autoColWidths,
        getBudgetYear: getBudgetYear,
        getBudgetYearEnd: getBudgetYearEnd,
        getBudgetYearRange: getBudgetYearRange,
        getBudgetYearLabel: getBudgetYearLabel,
        applyBudgetYear: applyBudgetYear,
        mountBars: mountBars,
    };

    // Год на странице и панели экспорта — когда разметка готова
    function onReady() {
        applyBudgetYear();
        mountBars();
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onReady);
    } else {
        onReady();
    }
})();
