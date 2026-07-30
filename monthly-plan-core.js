/**
 * FINKA Budget System — общий движок таблиц вида
 * «наименование расходов × 12 месяцев».
 *
 * По этой форме сделаны две страницы:
 *   • План финансирования по платежам  (План Алматы РБ / ПУ / ФИНЦЕНТР 2026)
 *   • Справка на передвижку по платежам (Справка … Алматы РБ / ПУ)
 *
 * Строки здесь не зашиты в разметку: их можно добавлять и удалять, поэтому
 * состав расходов правится прямо на странице, без правки кода.
 *
 * Финансовый план на год — расчётный: это сумма двенадцати месяцев, как в
 * исходных книгах. Отдельно его никто не вводит.
 *
 * Вызов:
 *     MonthlyPlan.init({
 *         storageKey: "plan_fin",
 *         title: "План финансирования по платежам",
 *         variants: [{ key:"rb", label:"Республиканский бюджет", rows:[…] }, …],
 *         sumVariant: { key:"svod", label:"Свод ПУ + ДТ", of:["pu","dt"] },
 *         docFields: [{ key:"num", label:"№ справки" }, …],   // необязательно
 *     });
 */
(function (global) {
    "use strict";

    var MONTHS = [
        "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
        "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
    ];

    var BRANCHES = {
        nao: "НАО «РФМШ»",
        almaty: "Алматы",
        astana: "Астана",
        uralsk: "Уральск",
    };

    function fmt(v) {
        return (v || 0).toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    function readStore(key) {
        try {
            return JSON.parse(localStorage.getItem(key)) || null;
        } catch (e) {
            return null;
        }
    }

    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function init(cfg) {
        var root = document.getElementById(cfg.mount || "mpRoot");
        var storageKey = cfg.storageKey;
        var variants = cfg.variants;
        var sumVariant = cfg.sumVariant || null;
        var docFields = cfg.docFields || [];

        var allTabs = variants.concat(sumVariant ? [sumVariant] : []);
        var activeBranch = "almaty";
        var activeVariant = variants[0].key;
        var model = { rows: [], doc: {} };
        var saveTimer = null;

        function isSum() {
            return !!(sumVariant && activeVariant === sumVariant.key);
        }

        function key(variant, branch) {
            return storageKey + "_" + (variant || activeVariant) + "_" +
                (branch || activeBranch);
        }

        function defaultRows() {
            var v = variants.filter(function (x) {
                return x.key === activeVariant;
            })[0];
            return (v && v.rows ? v.rows : []).map(function (r) {
                return { code: r.code || "", name: r.name, m: new Array(12).fill(0) };
            });
        }

        /* ── Разметка ─────────────────────────────────────────────── */
        function render() {
            root.innerHTML =
                '<div class="header">' +
                "<h1>" + esc(cfg.icon || "🗓️") + " " + esc(cfg.title) + "</h1>" +
                (cfg.subtitle ? "<p>" + esc(cfg.subtitle) + "</p>" : "") +
                '<div class="branch-selector" id="mpBranches">' +
                Object.keys(BRANCHES)
                    .map(function (k) {
                        return (
                            '<button class="branch-btn' +
                            (k === activeBranch ? " active" : "") +
                            '" data-branch="' + k + '">' + BRANCHES[k] +
                            "</button>"
                        );
                    })
                    .join("") +
                "</div>" +
                '<div class="branch-selector" id="mpVariants" style="margin-top:8px">' +
                allTabs
                    .map(function (v) {
                        return (
                            '<button class="branch-btn' +
                            (v.key === activeVariant ? " active" : "") +
                            '" data-variant="' + v.key + '"' +
                            (sumVariant && v.key === sumVariant.key
                                ? ' style="border-color:#8e44ad;color:#8e44ad"'
                                : "") +
                            ">" + esc(v.label) + "</button>"
                        );
                    })
                    .join("") +
                "</div>" +
                "</div>" +
                (docFields.length ? docBlock() : "") +
                '<div class="info-bar">' +
                '<div><span style="font-weight:bold">Филиал:</span> <span id="mpBranchLabel"></span></div>' +
                '<div><span style="font-weight:bold">Вид бюджета:</span> <span id="mpVariantLabel"></span></div>' +
                '<div><span style="font-weight:bold">Последнее изменение:</span> <span id="mpLastUpdate">-</span></div>' +
                '<div class="auto-save-status saved" id="mpSaveStatus">✓ Сохранено</div>' +
                "</div>" +
                '<div class="summary-cards">' +
                '<div class="summary-card"><div class="sc-label">Финансовый план на год</div>' +
                '<div class="sc-value" id="mpCardYear">0,00</div></div>' +
                '<div class="summary-card" style="border-top-color:#10b981">' +
                '<div class="sc-label">Строк в таблице</div>' +
                '<div class="sc-value" id="mpCardRows">0</div></div>' +
                "</div>" +
                '<div class="table-container"><table id="mpTable" data-sheet data-sticky-cols="3">' +
                "<thead><tr>" +
                '<th rowspan="2" style="width:40px">№</th>' +
                '<th rowspan="2" style="width:70px">Спе-<br>ци-<br>фика</th>' +
                '<th rowspan="2" style="min-width:260px">Наименование расходов</th>' +
                '<th rowspan="2">Финансовый<br>план на год</th>' +
                '<th colspan="12">План по месяцам</th>' +
                '<th rowspan="2" style="width:56px">—</th>' +
                "</tr><tr>" +
                MONTHS.map(function (m) {
                    return "<th>" + m + "</th>";
                }).join("") +
                "</tr></thead>" +
                '<tbody id="mpBody"></tbody>' +
                "<tfoot><tr class='total-row' id='mpTotalRow'>" +
                '<td></td><td></td><td class="label-cell" style="font-weight:800">Всего:</td>' +
                '<td class="formula-cell" id="mpTotYear">0,00</td>' +
                MONTHS.map(function (_, i) {
                    return '<td class="formula-cell" id="mpTotM' + i + '">0,00</td>';
                }).join("") +
                "<td></td></tr></tfoot>" +
                "</table></div>" +
                '<div class="buttons">' +
                '<button class="btn btn-add-row" id="mpAddBtn">➕ Добавить строку</button>' +
                '<button class="btn btn-primary" id="mpSaveBtn">💾 Сохранить</button>' +
                '<button class="btn btn-success" id="mpExcelBtn">📥 Excel</button>' +
                '<button class="btn btn-secondary" id="mpPrintBtn">🖨️ Печать</button>' +
                '<button class="btn btn-danger" id="mpResetBtn">↺ Вернуть типовые строки</button>' +
                "</div>";
        }

        function docBlock() {
            return (
                '<div class="info-bar" id="mpDoc">' +
                docFields
                    .map(function (f) {
                        return (
                            "<div><span style=\"font-weight:bold\">" +
                            esc(f.label) + ":</span> " +
                            '<input class="editable-cell" style="width:' +
                            (f.width || 150) + 'px" data-doc="' + f.key +
                            '" type="' + (f.type || "text") + '"></div>'
                        );
                    })
                    .join("") +
                "</div>"
            );
        }

        /* ── Тело таблицы ─────────────────────────────────────────── */
        function buildBody() {
            var tbody = document.getElementById("mpBody");
            var ro = isSum();
            tbody.innerHTML = "";

            model.rows.forEach(function (row, idx) {
                var tr = document.createElement("tr");
                tr.dataset.idx = idx;

                var tdN = document.createElement("td");
                tdN.className = "label-cell";
                tdN.style.textAlign = "center";
                tdN.textContent = idx + 1;
                tr.appendChild(tdN);

                tr.appendChild(textCell(row, "code", idx, ro, "center"));
                tr.appendChild(textCell(row, "name", idx, ro, "left"));

                var tdYear = document.createElement("td");
                tdYear.className = "formula-cell";
                tdYear.id = "mpYear_" + idx;
                tr.appendChild(tdYear);

                for (var m = 0; m < 12; m++) {
                    tr.appendChild(numCell(row, idx, m, ro));
                }

                var tdDel = document.createElement("td");
                if (!ro) {
                    var btn = document.createElement("button");
                    btn.className = "btn-delete-row";
                    btn.type = "button";
                    btn.textContent = "✕";
                    btn.title = "Удалить строку";
                    btn.addEventListener("click", function () {
                        if (!confirm('Удалить строку «' + (row.name || "") + '»?')) return;
                        model.rows.splice(idx, 1);
                        buildBody();
                        recalc();
                        scheduleSave();
                    });
                    tdDel.appendChild(btn);
                }
                tr.appendChild(tdDel);

                tbody.appendChild(tr);
            });

            document.getElementById("mpAddBtn").disabled = ro;
            document.getElementById("mpSaveBtn").disabled = ro;
            document.getElementById("mpResetBtn").disabled = ro;
        }

        function textCell(row, field, idx, ro, align) {
            var td = document.createElement("td");
            td.style.textAlign = align;
            if (ro) {
                td.className = "label-cell";
                td.style.whiteSpace = "normal";
                td.textContent = row[field] || "";
                return td;
            }
            td.className = "editable";
            var inp = document.createElement("input");
            inp.type = "text";
            inp.className = "editable-cell";
            inp.value = row[field] || "";
            inp.addEventListener("input", function () {
                row[field] = inp.value;
                scheduleSave();
            });
            td.appendChild(inp);
            return td;
        }

        function numCell(row, idx, m, ro) {
            var td = document.createElement("td");
            if (ro) {
                td.className = "auto-cell";
                td.id = "mpCell_" + idx + "_" + m;
                td.textContent = fmt(row.m[m]);
                return td;
            }
            td.className = "editable";
            var inp = document.createElement("input");
            inp.type = "number";
            inp.step = "0.01";
            inp.value = row.m[m] || 0;
            inp.dataset.idx = idx;
            inp.dataset.m = m;
            inp.addEventListener("input", function () {
                row.m[m] = parseFloat(inp.value) || 0;
                recalc();
                scheduleSave();
            });
            td.appendChild(inp);
            return td;
        }

        /* ── Расчёт ───────────────────────────────────────────────── */
        function recalc() {
            var totYear = 0;
            var totM = new Array(12).fill(0);

            model.rows.forEach(function (row, idx) {
                var year = row.m.reduce(function (a, b) {
                    return a + (parseFloat(b) || 0);
                }, 0);
                var el = document.getElementById("mpYear_" + idx);
                if (el) {
                    el.textContent = fmt(year);
                    el.classList.toggle("negative", year < 0);
                }
                totYear += year;
                for (var m = 0; m < 12; m++) totM[m] += parseFloat(row.m[m]) || 0;
            });

            var ty = document.getElementById("mpTotYear");
            ty.textContent = fmt(totYear);
            ty.classList.toggle("negative", totYear < 0);
            for (var m = 0; m < 12; m++) {
                var c = document.getElementById("mpTotM" + m);
                c.textContent = fmt(totM[m]);
                c.classList.toggle("negative", totM[m] < 0);
            }

            document.getElementById("mpCardYear").textContent = fmt(totYear);
            document.getElementById("mpCardRows").textContent = model.rows.length;
        }

        /* ── Хранение ─────────────────────────────────────────────── */
        function load() {
            document.getElementById("mpBranchLabel").textContent =
                BRANCHES[activeBranch];
            document.getElementById("mpVariantLabel").textContent =
                (allTabs.filter(function (v) {
                    return v.key === activeVariant;
                })[0] || {}).label || "";

            if (isSum()) {
                model = { rows: buildSum(), doc: {} };
            } else {
                var stored = readStore(key());
                model = stored && stored.rows && stored.rows.length
                    ? normalize(stored)
                    : { rows: defaultRows(), doc: {} };
            }

            docFields.forEach(function (f) {
                var el = document.querySelector('[data-doc="' + f.key + '"]');
                if (el) el.value = model.doc[f.key] || "";
            });

            document.getElementById("mpLastUpdate").textContent =
                (readStore(key()) || {})._lastUpdate || "-";

            buildBody();
            recalc();
        }

        function normalize(stored) {
            return {
                rows: stored.rows.map(function (r) {
                    var m = new Array(12).fill(0);
                    (r.m || []).forEach(function (v, i) {
                        if (i < 12) m[i] = parseFloat(v) || 0;
                    });
                    return { code: r.code || "", name: r.name || "", m: m };
                }),
                doc: stored.doc || {},
            };
        }

        /* Сводная вкладка: строки слагаемых сливаются по паре «специфика +
           наименование», чтобы одна и та же статья не задваивалась. */
        function buildSum() {
            var order = [];
            var byKey = {};
            sumVariant.of.forEach(function (vKey) {
                var stored = readStore(key(vKey));
                var rows = stored && stored.rows && stored.rows.length
                    ? normalize(stored).rows
                    : (variants.filter(function (v) {
                          return v.key === vKey;
                      })[0] || {}).rows || [];
                rows.forEach(function (r) {
                    var m = r.m || new Array(12).fill(0);
                    var k = (r.code || "") + "|" + (r.name || "");
                    if (!byKey[k]) {
                        byKey[k] = {
                            code: r.code || "",
                            name: r.name || "",
                            m: new Array(12).fill(0),
                        };
                        order.push(k);
                    }
                    for (var i = 0; i < 12; i++) {
                        byKey[k].m[i] += parseFloat(m[i]) || 0;
                    }
                });
            });
            return order.map(function (k) {
                return byKey[k];
            });
        }

        function save() {
            if (isSum()) return;
            docFields.forEach(function (f) {
                var el = document.querySelector('[data-doc="' + f.key + '"]');
                if (el) model.doc[f.key] = el.value;
            });
            var payload = {
                rows: model.rows,
                doc: model.doc,
                _lastUpdate: new Date().toLocaleString("ru-RU"),
            };
            localStorage.setItem(key(), JSON.stringify(payload));
            document.getElementById("mpLastUpdate").textContent = payload._lastUpdate;
            setStatus("✓ Сохранено", "saved");
        }

        function scheduleSave() {
            if (isSum()) return;
            clearTimeout(saveTimer);
            setStatus("⏳ Сохранение...", "saving");
            saveTimer = setTimeout(save, 800);
        }

        function setStatus(text, cls) {
            var el = document.getElementById("mpSaveStatus");
            if (!el) return;
            el.textContent = text;
            el.className = "auto-save-status " + cls;
        }

        /* ── Экспорт ──────────────────────────────────────────────── */
        function exportExcel() {
            var vLabel = (allTabs.filter(function (v) {
                return v.key === activeVariant;
            })[0] || {}).label || "";
            var head = [
                [cfg.title],
                ["Филиал: " + BRANCHES[activeBranch] + " • " + vLabel],
            ];
            docFields.forEach(function (f) {
                head.push([f.label + ": " + (model.doc[f.key] || "")]);
            });
            head.push([]);
            head.push(
                ["№", "Специфика", "Наименование расходов", "Финансовый план на год"]
                    .concat(MONTHS),
            );

            var body = model.rows.map(function (row, i) {
                var year = row.m.reduce(function (a, b) {
                    return a + (parseFloat(b) || 0);
                }, 0);
                return [i + 1, row.code, row.name, year].concat(row.m);
            });

            var totM = new Array(12).fill(0);
            var totYear = 0;
            model.rows.forEach(function (row) {
                row.m.forEach(function (v, i) {
                    totM[i] += parseFloat(v) || 0;
                    totYear += parseFloat(v) || 0;
                });
            });
            body.push(["", "", "Всего:", totYear].concat(totM));

            var ws = XLSX.utils.aoa_to_sheet(head.concat(body));
            ws["!cols"] = [{ wch: 4 }, { wch: 10 }, { wch: 44 }, { wch: 16 }].concat(
                MONTHS.map(function () {
                    return { wch: 14 };
                }),
            );
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "План");
            XLSX.writeFile(
                wb,
                cfg.title.replace(/[\\/:*?"<>|]/g, "") + "_" +
                    BRANCHES[activeBranch] + "_" + vLabel + ".xlsx",
            );
        }

        /* ── Запуск ───────────────────────────────────────────────── */
        render();

        document.getElementById("mpBranches").addEventListener("click", function (e) {
            var btn = e.target.closest(".branch-btn");
            if (!btn) return;
            save();
            this.querySelectorAll(".branch-btn").forEach(function (b) {
                b.classList.remove("active");
            });
            btn.classList.add("active");
            activeBranch = btn.dataset.branch;
            load();
        });

        document.getElementById("mpVariants").addEventListener("click", function (e) {
            var btn = e.target.closest(".branch-btn");
            if (!btn) return;
            save();
            this.querySelectorAll(".branch-btn").forEach(function (b) {
                b.classList.remove("active");
            });
            btn.classList.add("active");
            activeVariant = btn.dataset.variant;
            load();
        });

        document.getElementById("mpAddBtn").addEventListener("click", function () {
            model.rows.push({ code: "", name: "", m: new Array(12).fill(0) });
            buildBody();
            recalc();
            var last = document.querySelector(
                "#mpBody tr:last-child input[type=text]",
            );
            if (last) last.focus();
            scheduleSave();
        });

        document.getElementById("mpResetBtn").addEventListener("click", function () {
            if (!confirm("Заменить строки типовым составом расходов? Введённые суммы будут потеряны.")) return;
            model.rows = defaultRows();
            buildBody();
            recalc();
            save();
        });

        document.getElementById("mpSaveBtn").addEventListener("click", save);
        document.getElementById("mpExcelBtn").addEventListener("click", exportExcel);
        document.getElementById("mpPrintBtn").addEventListener("click", function () {
            window.print();
        });

        docFields.forEach(function (f) {
            var el = document.querySelector('[data-doc="' + f.key + '"]');
            if (el) el.addEventListener("input", scheduleSave);
        });

        load();

        global.saveData = save;
        global.exportExcel = exportExcel;
    }

    global.MonthlyPlan = { init: init, MONTHS: MONTHS };
})(window);
