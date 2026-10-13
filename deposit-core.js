/**
 * FINKA Budget System — «Депозит»: свод доходной и расходной части денежных
 * средств, полученных за счёт размещения депозита.
 *
 * Источник — лист «Депозит» книги «За счет средств Депозита (доход и
 * расход).xlsx». Строки и тексты перенесены с листа как есть, id строки —
 * номер строки Excel (r17 — строка 17), чтобы сверять с файлом.
 *
 * Итоги в книге собраны с пропусками, здесь они считаются полностью:
 *   • «Итого доход» (D11) в книге пустой         → остатки + депозит;
 *   • «Итого расход» (H30) = 159 + непредвиденные → ФОТ + 159 + 169 целиком;
 *   • группы ФОТ (16) и 169 (22) в книге без сумм → сумма своих строк;
 *   • остаток (D32) = D11 − D30 ссылался на пустые ячейки → доход − расход.
 *
 * Колонки расходной части: «Сумма без НДС» и «Сумма НДС» вводятся,
 * «Сумма на 2026 год» = без НДС + НДС. «Стратегические расходы» — строки
 * со ссылкой на План реализации стратегических направлений (17, 18, 20):
 * по ним в книге и собрана строка 31 «в том числе … стратегических» = 16 + 19.
 *
 * Модуль без DOM: тот же код считает страницу deposit.html и тест
 * tests/deposit.mjs.
 */
(function (root) {
    "use strict";

    var BRANCHES = ["nao", "almaty", "astana", "uralsk"];

    var BRANCH_NAMES = {
        nao: "Центральный аппарат НАО «РФМШ»",
        almaty: "филиал НАО «РФМШ» в городе Алматы",
        astana: "филиал НАО «РФМШ» в городе Астана",
        uralsk: "филиал НАО «РФМШ» в городе Уральск",
    };

    var MRP_BY_YEAR = { 2024: 3692, 2025: 3932, 2026: 4325 };
    var MRP_LIMIT = 10000; // непредвиденные расходы — до 10 000 МРП на год

    var COLS = ["d", "e", "f", "g"];

    /* kind:
         section — заголовок раздела, без чисел;
         income  — строка дохода, вводится только «Сумма на 2026 год»;
         expense — строка расхода, вводятся без НДС и НДС;
         group   — сумма своих строк (sum);
         total   — итог (sum или diff), только чтение.
       cols — какие колонки у итога есть; по умолчанию все четыре. */
    var ROWS = [
        { id: "inc", kind: "section", num: "1.", name: "Доходная часть" },
        {
            id: "r9",
            kind: "income",
            num: "1",
            name: "Остатки денежных средств с 2025 года",
        },
        {
            id: "r10",
            kind: "income",
            num: "2",
            name:
                "Депозит – размещение денежных средств в банке. Для получения " +
                "вознаграждения не выводя деньги из оборота и направленные на " +
                "покрытие дополнительных расходов для развития НАО " +
                "«Республиканская физико-математическая школа» за вклад 12 " +
                "месяцев 2026 года (согласно данных 2025 года и увеличения " +
                "объема финансирования)",
        },
        {
            id: "r11",
            kind: "total",
            name: "Итого доход (прогноз) в сумме на 2026 год",
            sum: ["r9", "r10"],
            cols: ["d"],
        },

        { id: "exp", kind: "section", num: "2.", name: "Расходная часть" },
        {
            id: "r16",
            kind: "group",
            num: "1",
            name: "Фонд оплаты труда (112.113)",
            sum: ["r17", "r18"],
        },
        {
            id: "r17",
            kind: "expense",
            strategic: true,
            name:
                "Оказание социальной поддержки, гарантий и компенсационных " +
                "выплат работникам центрального аппарата НАО «РФМШ» и " +
                "директорам филиалов, работникам административно-" +
                "управленческого персонала и учителям школ (согласно списка). " +
                "Улучшение условий для педагогов (2.1. плана по реализации " +
                "стратегических направлений 2/4) 2026 года",
        },
        {
            id: "r18",
            kind: "expense",
            strategic: true,
            name:
                "Дополнительные денежные выплаты работникам центрального " +
                "аппарата и директорам филиалов НАО «РФМШ». Улучшение условий " +
                "для педагогов (2.5. плана по реализации стратегических " +
                "направлений 2/4) 2026 года",
        },
        {
            id: "r19",
            kind: "group",
            num: "2",
            name: "Оплата прочих услуг и работ (159)",
            sum: ["r20"],
        },
        {
            id: "r20",
            kind: "expense",
            strategic: true,
            name:
                "Повышение профессиональной квалификации работников " +
                "центрального аппарата НАО «РФМШ» и его филиалов. Улучшение " +
                "условий для педагогов (2.4. плана по реализации " +
                "стратегических направлений 2/4) 2026 года",
        },
        {
            id: "r22",
            kind: "group",
            num: "3",
            name: "Прочие текущие затраты (169)",
            sum: ["r23", "r24"],
        },
        {
            id: "r23",
            kind: "expense",
            name:
                "Оформительные документы на покупку здания. Госпошлина и т.п. " +
                "Нотариальные услуги (сделка, совершаемая в целях приобретения " +
                "недвижимости — 2 МРП + 2 МРП; выдача свидетельств о праве " +
                "собственности — 1 МРП + 4 МРП; доверенность на право " +
                "пользования имуществом — 0,5 МРП + 2 МРП, с проектом " +
                "тех. работ) и другие нотариальные и иные услуги",
        },
        {
            id: "r24",
            kind: "expense",
            // В консолидации раскладывается по ЦА и филиалам (строки 25–28)
            split: true,
            name:
                "Прочие непредвиденные расходы на 2026 год (включая " +
                "представительские расходы) до 10 000 МРП на год",
        },
        {
            id: "r30",
            kind: "total",
            name: "Итого расход в сумме на 2026 год",
            sum: ["r16", "r19", "r22"],
        },
        {
            id: "r31",
            kind: "total",
            name:
                "в том числе расходы в рамках Плана реализации стратегических " +
                "направлений",
            sum: ["r16", "r19"],
        },
        {
            id: "r32",
            kind: "total",
            name: "Остаток (доход − расход) на 2026 год",
            diff: ["r11", "r30"],
            cols: ["d"],
        },
    ];

    var BY_ID = {};
    ROWS.forEach(function (r) {
        BY_ID[r.id] = r;
    });

    function num(v) {
        var n = typeof v === "number" ? v : parseFloat(String(v || "").replace(",", "."));
        return isFinite(n) ? n : 0;
    }

    // Копейки: сумма 0.1 + 0.2 не должна показывать 0.30000000000000004
    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    function blank() {
        return { d: null, e: null, f: null, g: null };
    }

    /* Вводимые значения одного филиала → все колонки всех строк.
       sheet: { r9: {d}, r17: {f, g}, … } — как хранится на странице. */
    function compute(sheet) {
        sheet = sheet || {};
        var out = {};

        function get(id) {
            if (out[id]) return out[id];
            var row = BY_ID[id];
            var v = blank();
            var src = sheet[id] || {};

            if (row.kind === "income") {
                v.d = round2(num(src.d));
            } else if (row.kind === "expense") {
                v.f = round2(num(src.f));
                v.g = round2(num(src.g));
                v.d = round2(v.f + v.g);
                v.e = row.strategic ? v.d : 0;
            } else if (row.sum) {
                var cols = row.cols || COLS;
                cols.forEach(function (c) {
                    v[c] = round2(
                        row.sum.reduce(function (acc, child) {
                            return acc + (get(child)[c] || 0);
                        }, 0),
                    );
                });
            } else if (row.diff) {
                (row.cols || COLS).forEach(function (c) {
                    v[c] = round2(
                        (get(row.diff[0])[c] || 0) - (get(row.diff[1])[c] || 0),
                    );
                });
            }
            out[id] = v;
            return v;
        }

        ROWS.forEach(function (r) {
            if (r.kind !== "section") get(r.id);
        });
        return out;
    }

    /* Консолидация: вводимые значения складываются по ЦА и филиалам, затем
       считаются итоги. Так итоги консолидации совпадают с суммой итогов
       филиалов. */
    function consolidate(all) {
        all = all || {};
        var sum = {};
        ROWS.forEach(function (r) {
            if (r.kind !== "income" && r.kind !== "expense") return;
            var acc = {};
            BRANCHES.forEach(function (b) {
                var src = (all[b] && all[b][r.id]) || {};
                ["d", "f", "g"].forEach(function (c) {
                    acc[c] = (acc[c] || 0) + num(src[c]);
                });
            });
            sum[r.id] = acc;
        });
        return compute(sum);
    }

    // Строки 25–28: непредвиденные расходы ЦА и каждого филиала
    function splitRows(all, id) {
        return BRANCHES.map(function (b) {
            return {
                branch: b,
                name: BRANCH_NAMES[b],
                value: compute((all || {})[b])[id],
            };
        });
    }

    function mrp(year) {
        return MRP_BY_YEAR[year] || MRP_BY_YEAR[2026];
    }

    // Лимит непредвиденных расходов — на НАО целиком, а не на филиал
    function limitCheck(all, year) {
        var limit = MRP_LIMIT * mrp(year);
        var used = consolidate(all).r24.d;
        return { limit: limit, used: used, over: used > limit };
    }

    var api = {
        BRANCHES: BRANCHES,
        BRANCH_NAMES: BRANCH_NAMES,
        ROWS: ROWS,
        MRP_LIMIT: MRP_LIMIT,
        compute: compute,
        consolidate: consolidate,
        splitRows: splitRows,
        limitCheck: limitCheck,
        mrp: mrp,
    };

    root.DepositCore = api;
})(typeof window !== "undefined" ? window : globalThis);
