/**
 * Кейсы сверки с Excel.
 *
 * prepare(api, ensure) — раскладывает по полям страницы те же числа,
 * что стоят в исходном листе, и запускает пересчёт.
 * checks — [подпись, id ячейки результата, значение из Excel].
 */

export const CASES = [
    {
        title: "Доходная часть ПУ",
        file: "pu-income-pu.html",
        sheet: "Бюджет ПУ 2026 → ДОХОДНАЯ ЧАСТЬ ПУ",
        needle: "SHEET_KEY",
        exports: ["ROW_DEFS", "buildTable", "updateAllRows"],
        prepare(api, ensure) {
            api.buildTable();
            // Excel: единицы в тех месяцах, где они проставлены
            const months = [1, 2, 3, 4, 5, 9, 10, 11, 12];
            const XL = {
                1: { cont: 1, m: [], py: 1 }, // вступ. взнос: T = E*S
                2: { cont: 1, m: months, py: 1 },
                3: { cont: 1, m: months, py: 1 },
                4: { cont: 1, m: months, py: 1 },
                5: { cont: 1, m: months, py: 1 },
                6: { cont: 1, m: months, py: 1 },
                7: { cont: 1, m: [], py: 1 }, // АР: T = E*S
                8: { cont: 1, m: [10, 11, 12], py: 1 },
            };
            for (let r = 1; r <= api.ROW_DEFS.length; r++) {
                ensure(`row-${r}-cont`).value = XL[r].cont;
                ensure(`row-${r}-py`).value = XL[r].py;
                ensure(`row-${r}-pm`).value = 0;
                for (let m = 1; m <= 12; m++)
                    ensure(`row-${r}-m${m}`).value = XL[r].m.includes(m) ? 1 : 0;
            }
            api.updateAllRows();
        },
        checks: [
            ["T9  вступ. взнос = E×S", "row-1-total", 1],
            ["T10 сумма месяцев", "row-2-total", 9],
            ["T15 АР = E×S", "row-7-total", 1],
            ["T16 три месяца", "row-8-total", 3],
            ["E17 контингент = E10+E11+E12", "total-cont", 3],
            ["F17 январь", "total-m1", 5],
            ["K17 июнь (пусто)", "total-m6", 0],
            ["O17 октябрь", "total-m10", 6],
            ["T17 всего", "total-total", 50],
            ["T18 рентабельность 8%", "profit-total", 4],
            ["T19 всего со скидкой", "net-total", 46],
            ["O18 октябрь × 8%", "profit-m10", 0.48],
            ["O19 октябрь со скидкой", "net-m10", 5.52],
        ],
    },

    {
        title: "Свод ФОТ Алматы",
        file: "pu-fot-almaty.html",
        sheet: "Бюджет ПУ 2026 → Свод ФОТ Алматы",
        needle: 'KEY = "pu_fot_almaty"',
        exports: ["COLS", "ROWS", "buildTable", "calc"],
        prepare(api, ensure) {
            api.buildTable();
            // Excel: во всех заполненных ячейках единицы, часов нет
            ["r1", "r2", "r3"].forEach((id) => {
                api.COLS.forEach((c) => {
                    ensure(`${id}-${c.id}`).value = c.id === "hours" ? 0 : 1;
                });
            });
            api.calc();
        },
        checks: [
            // M7 = G+H+L+I+J+K = 6 составляющих
            ["M7  штатное расписание", "r1-fot", 6],
            ["M8  тарификация", "r2-fot", 6],
            ["M9  итого блок 1 = SUM(7:8)", "sub1-fot", 12],
            // M11 = G+I+J+K+L — без лечебно-оздоровительного пособия
            ["M11 иные выплаты (без H)", "r3-fot", 5],
            ["M12 итого блок 2", "sub2-fot", 5],
            ["M13 ВСЕГО = M12+M9", "grand-fot", 17],
            ["D9  численность блок 1", "sub1-cnt", 2],
            ["D13 численность ВСЕГО", "grand-cnt", 3],
            ["E13 часы ВСЕГО", "grand-hours", 0],
        ],
    },

    {
        title: "График родительской оплаты (Алматы)",
        file: "pu-grafik-almaty.html",
        sheet: "Бюджет ПУ 2026 → График род. оплаты Алматы",
        needle: 'KEY = "pu_grafik_almaty"',
        exports: ["TRANCHES", "buildTable", "calc"],
        prepare(api, ensure) {
            api.buildTable();
            // Excel D7:D10 и E7:E10
            const D = [300000, 600000, 600000, 500000];
            const E = [300000, 500000, 500000, 500000];
            D.forEach((v, i) => (ensure(`t${i + 1}-d`).value = v));
            E.forEach((v, i) => (ensure(`t${i + 1}-e`).value = v));
            ensure("cont7").value = 65; // N9 = 51+14
            ensure("cont811").value = 102; // P9
            api.calc();
        },
        checks: [
            ["D11 итог траншей 7 кл", "tot-d", 2000000],
            ["E11 итог траншей 8–11", "tot-e", 1800000],
            ["N7  7 кл сентябрь–декабрь", "ref-n7", 888888.8888888889],
            ["O7  7 кл январь–май", "ref-o7", 1111111.111111111],
            ["P7  8–11 сентябрь–декабрь", "ref-p7", 800000],
            ["Q7  8–11 январь–май", "ref-q7", 1000000],
            ["N8  доля периода, %", "ref-n8", 44.44444444444444],
            ["N10 доход 7 кл осень", "ref-n10", 57777777.777777776],
            ["P10 доход 8–11 осень", "ref-p10", 81600000],
            ["N11 доход 7 классов", "ref-n11", 130000000],
            ["P11 доход 8–11 классов", "ref-p11", 183600000],
            ["G7  поступление транша 1", "t1-g", 17940000],
            ["H7  % транша 1", "t1-h", 13.8],
            ["I7  поступление 8–11 транш 1", "t1-i", 28152000],
            ["J7  % 8–11 транш 1", "t1-j", 15.333333333333332],
            ["K7  итого транш 1", "t1-k", 46092000],
            ["L7  средний % транша 1", "t1-l", 14.566666666666666],
            ["G8  транш 2", "t2-g", 35880000],
            ["K10 транш 4", "t4-k", 76820000],
            ["G11 итого поступлений 7 кл", "tot-g", 119600000],
            ["I11 итого поступлений 8–11", "tot-i", 168912000],
            ["K11 итого по траншам", "tot-k", 288512000],
            ["H11 итого %", "tot-h", 92],
            ["N12 сентябрь–декабрь", "ref-n12", 139377777.7777778],
            ["N13 январь–май", "ref-n13", 174222222.2222222],
            ["N14 ВСЕГО", "ref-n14", 313600000],
            ["N15 рентабельность 8%", "ref-n15", 25088000],
            ["N16 ВСЕГО со скидкой", "ref-n16", 288512000],
        ],
    },

    {
        title: "План командировок РБ",
        file: "rb-plan-komandir.html",
        sheet: "Бюджет РБ 2026 → План командир 2026",
        needle: 'SHEET_KEY = "rb_plan_komandir"',
        exports: ["FIELDS", "rows", "buildTable", "calc"],
        prepare(api, ensure, document) {
            // Excel: две строки, во всех полях единицы, оргвзнос 0
            const mk = () => ({
                name: "Служебная поездка",
                dest: "г.Алматы-г.Астана",
                mrp: 1, trips: 1, days: 1, road: 1, people: 1,
                perNorm: 1, tripTo: 1, tripBack: 1, tripSum: 1,
                stayNorm: 1, stayNights: 1, staySum: 1, fee: 0,
            });
            // rows объявлена через let — подменяем через buildTable
            api.rows.length = 0;
            api.rows.push(mk(), mk());
            api.buildTable();
            [1, 2].forEach((r) => {
                const d = mk();
                api.FIELDS.filter((f) => !f.calc).forEach((f) => {
                    ensure(`r${r}-${f.id}`).value = d[f.id];
                });
            });
            api.calc();
        },
        checks: [
            // J18 = I*D*F*H = 1*1*1*1
            ["J18 суточные строка 1", "r1-perDiem", 1],
            // R18 = J+M+P+Q = 1+1+1+0
            ["R18 всего строка 1", "r1-total", 3],
            ["J19 суточные строка 2", "r2-perDiem", 1],
            ["R19 всего строка 2", "r2-total", 3],
            ["J33 итого суточные", "tot-perDiem", 2],
            ["M33 итого проезд", "tot-tripSum", 2],
            ["P33 итого проживание", "tot-staySum", 2],
            ["Q33 итого оргвзнос", "tot-fee", 0],
            ["R33 ВСЕГО", "totalSum", 6],
        ],
    },
];
