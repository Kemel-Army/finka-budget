/**
 * shared-export.js — Единый модуль экспорта (Excel, PDF, Печать) + год для всех страниц
 * Требует: SheetJS (xlsx.full.min.js) подключённый до этого скрипта
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
            el.textContent = year;
        });
        document.querySelectorAll(".dyn-year-range").forEach(function (el) {
            el.textContent = label;
        });
        document.querySelectorAll(".dyn-year-label").forEach(function (el) {
            el.textContent = label;
        });
    }

    /* ── Helpers ──────────────────────────────────────────── */
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
            alert("Библиотека XLSX не загружена");
            return;
        }
        var table = opts.table || document.querySelector("table");
        if (typeof table === "string") table = document.querySelector(table);
        if (!table) {
            alert("Таблица не найдена");
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
            alert("Библиотека XLSX не загружена");
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
    };

    // Auto-apply year if page has dyn-year elements
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyBudgetYear);
    } else {
        applyBudgetYear();
    }
})();
