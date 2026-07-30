/**
 * FINKA Budget System — общий движок отчётов ПЛАН-ФАКТ.
 *
 * Страница подключает модуль и передаёт только состав строк:
 *
 *     <div id="pfRoot"></div>
 *     <script src="plan-fact-core.js"></script>
 *     <script>PlanFact.init({ storageKey: "plan_fact_pu", rows: ROWS });</script>
 *
 * Разметку (шапку, тело, итоги, кнопки) строит сам модуль — иначе одну и ту же
 * таблицу на тринадцать колонок пришлось бы держать в трёх файлах сразу.
 *
 * Сводная страница задаётся полем sum: значения не вводятся, а складываются из
 * чужих ключей localStorage:
 *
 *     PlanFact.init({ storageKey: "plan_fact_pu_dt", rows: ROWS,
 *                     sum: ["plan_fact_pu", "plan_fact_dt"] });
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
        consolidated: "Сводный",
    };
    var REAL_BRANCHES = ["nao", "almaty", "astana", "uralsk"];

    // Вводятся руками; остальные колонки считаются
    var INPUT_COLS = ["finPlan", "plan", "spravka", "fact"];
    var ALL_COLS = [
        "finPlan", "plan", "spravka", "planOst", "fact",
        "ostatki", "planCum", "factMonth", "factCum", "ostCum",
    ];

    function fmt(v) {
        return (v || 0).toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    function parseFmt(s) {
        return parseFloat(String(s).replace(/\s/g, "").replace(",", ".")) || 0;
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function readStore(key) {
        try {
            return JSON.parse(localStorage.getItem(key)) || {};
        } catch (e) {
            return {};
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
        var rows = cfg.rows.map(function (r, i) {
            return {
                id: r.id || r.code,
                n: r.n != null ? r.n : i + 1,
                code: r.code || "",
                name: r.name,
                fot: !!r.fot,
            };
        });
        var storageKey = cfg.storageKey;
        var sumOf = cfg.sum || null; // сводная страница — только чтение
        var title = cfg.title || document.title;
        var subtitle = cfg.subtitle || "";
        var root = document.getElementById(cfg.mount || "pfRoot");

        var activeBranch = "nao";
        var activeMonth = 0;
        var saveTimer = null;

        function isReadOnly() {
            return !!sumOf || activeBranch === "consolidated";
        }

        /* ── Разметка ─────────────────────────────────────────────── */
        function render() {
            var html =
                '<div class="header">' +
                "<h1>📊 " + esc(title) + "</h1>" +
                (subtitle ? "<p>" + esc(subtitle) + "</p>" : "") +
                '<div class="branch-selector" id="pfBranches">' +
                Object.keys(BRANCHES)
                    .map(function (k) {
                        return (
                            '<button class="branch-btn' +
                            (k === "nao" ? " active" : "") +
                            '" data-branch="' + k + '"' +
                            (k === "consolidated"
                                ? ' style="border-color:#8e44ad;color:#8e44ad"'
                                : "") +
                            ">" +
                            (k === "consolidated" ? "📈 " : "") +
                            BRANCHES[k] +
                            "</button>"
                        );
                    })
                    .join("") +
                "</div>" +
                '<div class="month-selector" id="pfMonths"></div>' +
                "</div>" +
                '<div class="info-bar">' +
                '<div><span style="font-weight:bold">Филиал:</span> <span id="pfBranchLabel">' +
                BRANCHES.nao + "</span></div>" +
                '<div><span style="font-weight:bold">Период:</span> <span id="pfPeriod">—</span></div>' +
                '<div><span style="font-weight:bold">Последнее изменение:</span> <span id="pfLastUpdate">-</span></div>' +
                '<div class="auto-save-status saved" id="pfSaveStatus">' +
                (sumOf ? "🔒 Расчётная страница" : "✓ Сохранено") +
                "</div>" +
                "</div>" +
                '<div class="summary-cards">' +
                summaryCard("План (год)", "pfCardFinPlan", "") +
                summaryCard("Факт (нарастающий)", "pfCardFactCum", "") +
                summaryCard("Остатки (нарастающий)", "pfCardOstCum", "#10b981") +
                summaryCard("Экономия", "pfCardEcon", "#f59e0b") +
                "</div>" +
                '<div class="table-container"><table id="pfTable" data-sheet data-sticky-cols="3">' +
                buildHead() +
                '<tbody id="pfBody"></tbody>' +
                buildFoot() +
                "</table></div>" +
                '<div class="buttons">' +
                (sumOf
                    ? ""
                    : '<button class="btn btn-primary" id="pfSaveBtn">💾 Сохранить</button>') +
                '<button class="btn btn-success" id="pfExcelBtn">📥 Excel</button>' +
                '<button class="btn btn-secondary" id="pfPrintBtn">🖨️ Печать</button>' +
                "</div>";
            root.innerHTML = html;
        }

        function summaryCard(label, id, color) {
            return (
                '<div class="summary-card"' +
                (color ? ' style="border-top-color:' + color + '"' : "") +
                '><div class="sc-label">' + label + "</div>" +
                '<div class="sc-value" id="' + id + '">0,00</div></div>'
            );
        }

        function buildHead() {
            return (
                "<thead>" +
                "<tr>" +
                '<th rowspan="3">№</th>' +
                '<th rowspan="3">Спе-<br>ци-<br>фика</th>' +
                '<th rowspan="3">Наименование расходов</th>' +
                '<th rowspan="3">Финансовый<br>план на год</th>' +
                '<th colspan="5" id="pfMonthHead">ЯНВАРЬ ПЛАН-ФАКТ</th>' +
                '<th colspan="4">ОТЧЕТ исполнения ПЛАН-ФАКТ нарастающим</th>' +
                "</tr>" +
                "<tr>" +
                '<th rowspan="2">ПЛАН<br>за отчетный<br>месяц</th>' +
                '<th rowspan="2">СПРАВКА</th>' +
                '<th rowspan="2">План с<br>остатками</th>' +
                '<th rowspan="2">ФАКТ</th>' +
                '<th rowspan="2">ОСТАТКИ</th>' +
                "<th>ПЛАН со</th><th>ФАКТ с</th><th>ФАКТ с</th>" +
                '<th rowspan="2">ОСТАТКИ за<br>отчетный<br>месяц</th>' +
                "</tr>" +
                "<tr>" +
                "<th>справками с<br>нарастающим</th>" +
                "<th>за отчетный<br>месяц</th>" +
                "<th>нарастающим</th>" +
                "</tr>" +
                "</thead>"
            );
        }

        function buildFoot() {
            function line(cls, id, code, label) {
                return (
                    '<tr class="' + cls + '"><td></td><td>' + code + "</td>" +
                    '<td class="label-cell" style="font-weight:800">' + label + "</td>" +
                    ALL_COLS.map(function (c) {
                        return (
                            '<td class="formula-cell" id="' + id + capitalize(c) +
                            '">0,00</td>'
                        );
                    }).join("") +
                    "</tr>"
                );
            }
            return (
                "<tfoot>" +
                line("total-row", "pfT", "", "Итого:") +
                line("fot-row", "pfFot", "111-124", "Фонд оплаты труда") +
                "</tfoot>"
            );
        }

        function buildMonths() {
            var box = document.getElementById("pfMonths");
            MONTHS.forEach(function (m, i) {
                var btn = document.createElement("button");
                btn.className = "month-btn" + (i === 0 ? " active" : "");
                btn.textContent = m;
                btn.addEventListener("click", function () {
                    activeMonth = i;
                    box.querySelectorAll(".month-btn").forEach(function (b) {
                        b.classList.remove("active");
                    });
                    btn.classList.add("active");
                    updateMonthHeaders();
                    load();
                });
                box.appendChild(btn);
            });
        }

        function buildBody() {
            var tbody = document.getElementById("pfBody");
            tbody.innerHTML = "";
            rows.forEach(function (row) {
                var tr = document.createElement("tr");
                tr.dataset.id = row.id;

                [row.n, row.code].forEach(function (v) {
                    var td = document.createElement("td");
                    td.className = "label-cell";
                    td.style.textAlign = "center";
                    td.textContent = v;
                    tr.appendChild(td);
                });

                var tdName = document.createElement("td");
                tdName.className = "label-cell";
                tdName.style.textAlign = "left";
                tdName.style.whiteSpace = "normal";
                tdName.textContent = row.name;
                tr.appendChild(tdName);

                ALL_COLS.forEach(function (col) {
                    var td = document.createElement("td");
                    if (!sumOf && INPUT_COLS.indexOf(col) !== -1) {
                        td.className = "editable";
                        var inp = document.createElement("input");
                        inp.type = "number";
                        inp.step = "0.01";
                        inp.value = "0";
                        inp.dataset.row = row.id;
                        inp.dataset.col = col;
                        inp.addEventListener("input", function () {
                            recalcRow(row.id);
                            recalcTotals();
                            scheduleSave();
                        });
                        td.appendChild(inp);
                    } else {
                        td.className = "auto-cell";
                        td.id = "pfCell_" + row.id + "_" + col;
                        td.textContent = "0,00";
                    }
                    tr.appendChild(td);
                });

                tbody.appendChild(tr);
            });
        }

        function updateMonthHeaders() {
            var year = localStorage.getItem("budget_year") || "2026";
            document.getElementById("pfPeriod").textContent =
                MONTHS[activeMonth] + " " + year;
            document.getElementById("pfMonthHead").textContent =
                MONTHS[activeMonth].toUpperCase() + " ПЛАН-ФАКТ";
        }

        /* ── Значения ─────────────────────────────────────────────── */
        // На сводной странице полей ввода нет — там всё лежит в auto-ячейках
        function getVal(id, col) {
            var inp = document.querySelector(
                '#pfBody input[data-row="' + id + '"][data-col="' + col + '"]',
            );
            if (inp) return parseFloat(inp.value) || 0;
            var el = document.getElementById("pfCell_" + id + "_" + col);
            return el ? parseFmt(el.textContent) : 0;
        }

        function setVal(id, col, v) {
            var inp = document.querySelector(
                '#pfBody input[data-row="' + id + '"][data-col="' + col + '"]',
            );
            if (inp) {
                inp.value = v;
                return;
            }
            setAutoCell(id, col, v);
        }

        function setAutoCell(id, col, val) {
            var el = document.getElementById("pfCell_" + id + "_" + col);
            if (!el) return;
            el.textContent = fmt(val);
            el.classList.toggle("negative", val < 0);
        }

        /* Ключи localStorage, из которых страница берёт исходные значения:
           обычная страница — свой ключ, сводная — ключи слагаемых. */
        function sourceKeys() {
            return sumOf ? sumOf.slice() : [storageKey];
        }

        function branchesInScope() {
            return activeBranch === "consolidated"
                ? REAL_BRANCHES.slice()
                : [activeBranch];
        }

        // Сумма значения по всем источникам и филиалам за конкретный месяц
        function gather(month, id, col) {
            var sum = 0;
            sourceKeys().forEach(function (key) {
                branchesInScope().forEach(function (br) {
                    var d = readStore(key + "_" + br);
                    var m = d["m" + month];
                    if (m && m[id] && m[id][col] !== undefined) {
                        sum += parseFloat(m[id][col]) || 0;
                    }
                });
            });
            return sum;
        }

        function recalcRow(id) {
            var plan = getVal(id, "plan");
            var spravka = getVal(id, "spravka");
            var fact = getVal(id, "fact");

            var planOst = plan + spravka;
            var ostatki = planOst - fact;

            var prevPlanCum = 0;
            var prevFactCum = 0;
            for (var m = 0; m < activeMonth; m++) {
                prevPlanCum += gather(m, id, "plan") + gather(m, id, "spravka");
                prevFactCum += gather(m, id, "fact");
            }

            var planCum = prevPlanCum + planOst;
            var factCum = prevFactCum + fact;

            setAutoCell(id, "planOst", planOst);
            setAutoCell(id, "ostatki", ostatki);
            setAutoCell(id, "planCum", planCum);
            setAutoCell(id, "factMonth", fact);
            setAutoCell(id, "factCum", factCum);
            setAutoCell(id, "ostCum", planCum - factCum);
        }

        function recalcTotals() {
            var sums = {};
            var fotSums = {};
            ALL_COLS.forEach(function (c) {
                sums[c] = 0;
                fotSums[c] = 0;
            });

            rows.forEach(function (row) {
                ALL_COLS.forEach(function (col) {
                    var v = getVal(row.id, col);
                    sums[col] += v;
                    if (row.fot) fotSums[col] += v;
                });
            });

            ALL_COLS.forEach(function (col) {
                [["pfT", sums], ["pfFot", fotSums]].forEach(function (pair) {
                    var el = document.getElementById(pair[0] + capitalize(col));
                    if (!el) return;
                    el.textContent = fmt(pair[1][col]);
                    el.classList.toggle("negative", pair[1][col] < 0);
                });
            });

            setCard("pfCardFinPlan", sums.finPlan);
            setCard("pfCardFactCum", sums.factCum);
            setCard("pfCardOstCum", sums.ostCum);
            setCard("pfCardEcon", sums.ostCum);
        }

        function setCard(id, v) {
            var el = document.getElementById(id);
            if (!el) return;
            el.textContent = fmt(v);
            el.classList.toggle("negative", v < 0);
        }

        /* ── Загрузка и сохранение ────────────────────────────────── */
        function load() {
            rows.forEach(function (row) {
                INPUT_COLS.forEach(function (col) {
                    setVal(row.id, col, gather(activeMonth, row.id, col));
                });
                recalcRow(row.id);
            });
            recalcTotals();
            applyReadOnly();

            var stamp = "";
            sourceKeys().forEach(function (key) {
                branchesInScope().forEach(function (br) {
                    var d = readStore(key + "_" + br);
                    if (d._lastUpdate) stamp = d._lastUpdate;
                });
            });
            document.getElementById("pfLastUpdate").textContent = stamp || "-";
        }

        function save() {
            if (isReadOnly()) return;
            var key = storageKey + "_" + activeBranch;
            var data = readStore(key);
            var mKey = "m" + activeMonth;
            data[mKey] = {};
            rows.forEach(function (row) {
                var rec = {};
                INPUT_COLS.forEach(function (col) {
                    rec[col] = getVal(row.id, col);
                });
                data[mKey][row.id] = rec;
            });
            data._lastUpdate = new Date().toLocaleString("ru-RU");
            localStorage.setItem(key, JSON.stringify(data));
            document.getElementById("pfLastUpdate").textContent = data._lastUpdate;
            setStatus("✓ Сохранено", "saved");
        }

        function scheduleSave() {
            if (isReadOnly()) return;
            clearTimeout(saveTimer);
            setStatus("⏳ Сохранение...", "saving");
            saveTimer = setTimeout(save, 1000);
        }

        function setStatus(text, cls) {
            var el = document.getElementById("pfSaveStatus");
            if (!el || sumOf) return;
            el.textContent = text;
            el.className = "auto-save-status " + cls;
        }

        function applyReadOnly() {
            var ro = isReadOnly();
            document.querySelectorAll("#pfBody input").forEach(function (inp) {
                inp.disabled = ro;
                inp.style.opacity = ro ? ".7" : "1";
            });
        }

        /* ── Экспорт ──────────────────────────────────────────────── */
        function exportExcel() {
            var year = localStorage.getItem("budget_year") || "2026";
            var head = [
                [title + " за " + MONTHS[activeMonth].toLowerCase() + " " + year + " год"],
                ["Филиал: " + BRANCHES[activeBranch]],
                [],
                ["№", "Специфика", "Наименование расходов", "Фин. план " + year,
                 "ПЛАН", "СПРАВКА", "План с ост.", "ФАКТ", "ОСТАТКИ",
                 "ПЛАН нараст.", "ФАКТ за мес.", "ФАКТ нараст.", "ОСТАТКИ нараст."],
            ];

            var body = rows.map(function (row) {
                return [row.n, row.code, row.name].concat(
                    ALL_COLS.map(function (c) {
                        return getVal(row.id, c);
                    }),
                );
            });

            body.push(
                ["", "", "Итого:"].concat(
                    ALL_COLS.map(function (c) {
                        var el = document.getElementById("pfT" + capitalize(c));
                        return el ? parseFmt(el.textContent) : 0;
                    }),
                ),
            );
            body.push(
                ["", "111-124", "Фонд оплаты труда"].concat(
                    ALL_COLS.map(function (c) {
                        var el = document.getElementById("pfFot" + capitalize(c));
                        return el ? parseFmt(el.textContent) : 0;
                    }),
                ),
            );

            var ws = XLSX.utils.aoa_to_sheet(head.concat(body));
            ws["!cols"] = [{ wch: 4 }, { wch: 8 }, { wch: 40 }].concat(
                ALL_COLS.map(function () {
                    return { wch: 13 };
                }),
            );
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, BRANCHES[activeBranch]);
            XLSX.writeFile(
                wb,
                title.replace(/[\\/:*?"<>|]/g, "") + "_" +
                    BRANCHES[activeBranch] + "_" + MONTHS[activeMonth] + "_" +
                    year + ".xlsx",
            );
        }

        /* ── Запуск ───────────────────────────────────────────────── */
        render();
        buildMonths();
        buildBody();
        updateMonthHeaders();

        document.getElementById("pfBranches").addEventListener("click", function (e) {
            var btn = e.target.closest(".branch-btn");
            if (!btn) return;
            this.querySelectorAll(".branch-btn").forEach(function (b) {
                b.classList.remove("active");
            });
            btn.classList.add("active");
            activeBranch = btn.dataset.branch;
            document.getElementById("pfBranchLabel").textContent =
                BRANCHES[activeBranch];
            load();
        });

        var saveBtn = document.getElementById("pfSaveBtn");
        if (saveBtn) saveBtn.addEventListener("click", save);
        document.getElementById("pfExcelBtn").addEventListener("click", exportExcel);
        document.getElementById("pfPrintBtn").addEventListener("click", function () {
            window.print();
        });

        load();

        if (!sumOf) global.saveData = save;
        global.exportExcel = exportExcel;
    }

    global.PlanFact = { init: init, MONTHS: MONTHS };
})(window);
