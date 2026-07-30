/**
 * FINKA Budget System — разнесение данных «Сводной общей» по страницам.
 *
 * «Сводная общая 2026г.» — самый большой лист, в нём вся расшифровка
 * расходов. Лист «Свод» в исходной книге не вводится руками: каждая его
 * строка — ссылка на итог раздела «Сводной общей» либо на «СВОД ФЗП».
 * Формулы взяты из книги «Бюджет РБ 2026.xlsx» как есть:
 *
 *     Свод!C16 = 'Сводная общая 2026г.'!G18    продукты питания
 *     Свод!C17 = 'Сводная общая 2026г.'!H38    медикаменты
 *     Свод!C18 = 'Сводная общая 2026г.'!H79    ГСМ
 *     Свод!C19 = 'Сводная общая 2026г.'!H84    прочие запасы
 *     Свод!C20 = 'Сводная общая 2026г.'!H489   коммунальные услуги
 *     Свод!C21 = 'Сводная общая 2026г.'!H505   связь и интернет
 *     Свод!C22 = 'Сводная общая 2026г.'!H509   прочие услуги и работы
 *     Свод!C23 = 'Сводная общая 2026г.'!H531   командировки
 *     Свод!C24 = 'Сводная общая 2026г.'!G536   горячее питание
 *     Свод!C25 = 'Сводная общая 2026г.'!H561   прочие текущие затраты
 *     Свод!C26 = СУММ(C10:C25)
 *
 * Строки 10–15 «Свода» (оплата труда и налоги с неё) приходят не отсюда,
 * а из «СВОД ФЗП» — их эта функция не трогает.
 *
 * Страница «Сводная общая» хранит ячейки под ключами вида
 * sec{раздел}_row{строка}_col{колонка}, где строка — номер строки листа
 * минус единица (нумерация с нуля), а колонка — номер колонки с нуля:
 * G — это 6, H — 7.
 */
(function (global) {
    "use strict";

    // Строка «Свода» ← ячейка «Сводной общей». Номер строки Excel и колонка.
    var MAP = [
        { to: "C16", row: 18, col: 6, name: "Приобретение продуктов питания (питьевая вода)" },
        { to: "C17", row: 38, col: 7, name: "Приобретение медикаментов" },
        { to: "C18", row: 79, col: 7, name: "Приобретение горюче-смазочных материалов" },
        { to: "C19", row: 84, col: 7, name: "Приобретение прочих запасов" },
        { to: "C20", row: 489, col: 7, name: "Коммунальные услуги" },
        { to: "C21", row: 505, col: 7, name: "Услуги связи и интернет" },
        { to: "C22", row: 509, col: 7, name: "Прочие услуги и работы" },
        { to: "C23", row: 531, col: 7, name: "Командировки и служебные разъезды" },
        { to: "C24", row: 536, col: 6, name: "Организация горячим пятиразовым питанием" },
        { to: "C25", row: 561, col: 7, name: "Прочие текущие затраты" },
    ];

    // Итог «Свода» — сумма строк 10..25
    var TOTAL_CELL = "C26";
    var TOTAL_FROM = [];
    for (var r = 10; r <= 25; r++) TOTAL_FROM.push("C" + r);

    function read(key) {
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch (e) {
            return null;
        }
    }

    function toNumber(v) {
        if (typeof v === "number") return Number.isFinite(v) ? v : null;
        if (typeof v !== "string") return null;
        var t = v.replace(/[\s ₸]/g, "").replace(",", ".");
        if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
        return parseFloat(t);
    }

    /* Ячейку ищем по номеру строки и колонки, не привязываясь к номеру
       раздела: в исходном листе номер 6 носят сразу три подраздела, и
       угадывать, к какому из них отнесена строка, незачем. */
    function cellOf(svodnaya, excelRow, col) {
        var suffix = "_row" + (excelRow - 1) + "_col" + col;
        var keys = Object.keys(svodnaya);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].slice(-suffix.length) === suffix) {
                var n = toNumber(svodnaya[keys[i]]);
                if (n !== null) return n;
            }
        }
        return null;
    }

    /**
     * Переносит итоги разделов «Сводной общей» в «Свод расходов».
     * Возвращает отчёт: что перенесено, что не нашлось.
     */
    function toSvod(branch, options) {
        var opts = options || {};
        var svodnaya = read("rb_svodnaya_" + branch);
        if (!svodnaya) {
            return { ok: false, reason: "Сводная общая по этому филиалу ещё не заполнена" };
        }

        var key = "rb_svod_" + branch;
        var target = read(key) || { sheet: "rb_svod", branch: branch, cells: {} };
        if (!target.cells) target.cells = {};

        var moved = [];
        var missing = [];

        MAP.forEach(function (m) {
            var value = cellOf(svodnaya, m.row, m.col);
            if (value === null) {
                missing.push(m.name);
                return;
            }
            var before = toNumber(target.cells[m.to]);
            if (before === value) return; // уже такое же — не трогаем
            target.cells[m.to] = value;
            moved.push({ cell: m.to, name: m.name, was: before, now: value });
        });

        // Итог пересчитываем всегда: он зависит и от строк, пришедших
        // из «СВОД ФЗП», которые эта функция не меняет
        var total = 0;
        TOTAL_FROM.forEach(function (c) {
            var n = toNumber(target.cells[c]);
            if (n !== null) total += n;
        });
        target.cells[TOTAL_CELL] = total;

        target.lastModified = new Date().toISOString();

        if (!opts.dryRun) localStorage.setItem(key, JSON.stringify(target));

        return {
            ok: true,
            branch: branch,
            moved: moved,
            missing: missing,
            total: total,
            target: "Свод расходов",
        };
    }

    /* ── «Свод расходов» → «Калькуляция» ─────────────────────────
       В книге «Калькуляция 2026» тоже не заполняется руками:
           Калькуляция!C5  = 'Свод '!C10
           …                                 (подряд, шестнадцать строк)
           Калькуляция!C20 = 'Свод '!C25
           Калькуляция!D   = C / контингент
           Калькуляция!E   = D / 12
           Калькуляция!C21 = СУММ(C5:C20)

       Осторожно с подписями: в самой книге у строк 12 и 13 «Калькуляции»
       наименования ГСМ и медикаментов стоят наоборот относительно «Свода».
       Переносим по адресам ячеек, как считает Excel, а не по названиям. */
    var KALK_FIRST = 5; // строка «Калькуляции», куда ложится Свод!C10
    var KALK_ROWS = 16;
    var KALK_TOTAL = 21;

    function toKalkulyacia(branch, options) {
        var opts = options || {};
        var svod = read("rb_svod_" + branch);
        if (!svod || !svod.cells) {
            return { ok: false, reason: "«Свод расходов» по этому филиалу ещё не заполнен" };
        }

        var contingent = Number(opts.contingent) || 1186;
        var key = "rb_kalkulyacia_" + branch;
        var target = read(key) || { sheet: "rb_kalkulyacia", branch: branch, cells: {} };
        if (!target.cells) target.cells = {};

        var moved = [];
        var totalC = 0;
        var totalD = 0;
        var totalE = 0;

        for (var i = 0; i < KALK_ROWS; i++) {
            var from = "C" + (10 + i);
            var row = KALK_FIRST + i;
            var value = toNumber(svod.cells[from]);
            if (value === null) continue;

            var perYear = contingent ? value / contingent : 0;
            var perMonth = perYear / 12;

            if (toNumber(target.cells["C" + row]) !== value) {
                moved.push({ cell: "C" + row, was: toNumber(target.cells["C" + row]), now: value });
            }
            target.cells["C" + row] = value;
            target.cells["D" + row] = perYear;
            target.cells["E" + row] = perMonth;

            totalC += value;
            totalD += perYear;
            totalE += perMonth;
        }

        target.cells["C" + KALK_TOTAL] = totalC;
        target.cells["D" + KALK_TOTAL] = totalD;
        target.cells["E" + KALK_TOTAL] = totalE;
        target.lastModified = new Date().toISOString();

        if (!opts.dryRun) localStorage.setItem(key, JSON.stringify(target));

        return {
            ok: true,
            branch: branch,
            moved: moved,
            total: totalC,
            contingent: contingent,
            target: "Калькуляция расходов",
        };
    }

    /* ── «СВОД ФЗП» → «Свод расходов», строки 10–15 ──────────────
       В книге: Свод!C10 = 'СВОД ФЗП'!F14 … Свод!C15 = 'СВОД ФЗП'!K14.
       Четырнадцатая строка «СВОД ФЗП» — это итог по штатному расписанию
       и тарификации вместе. */
    var FZP_MAP = [
        { to: "C10", from: "F14", name: "Оплата труда" },
        { to: "C11", from: "G14", name: "Компенсационные выплаты" },
        { to: "C12", from: "H14", name: "Обязательные пенсионные взносы" },
        { to: "C13", from: "I14", name: "Социальный налог" },
        { to: "C14", from: "J14", name: "Социальные отчисления" },
        { to: "C15", from: "K14", name: "Обязательное медицинское страхование" },
    ];

    function fzpToSvod(branch, options) {
        var opts = options || {};
        var fzp = read("rb_fzp_" + branch);
        if (!fzp || !fzp.cells) {
            return { ok: false, reason: "«Свод ФЗП» по этому филиалу ещё не заполнен" };
        }

        var key = "rb_svod_" + branch;
        var target = read(key) || { sheet: "rb_svod", branch: branch, cells: {} };
        if (!target.cells) target.cells = {};

        var moved = [];
        var missing = [];
        FZP_MAP.forEach(function (m) {
            var value = toNumber(fzp.cells[m.from]);
            if (value === null) {
                missing.push(m.name);
                return;
            }
            if (toNumber(target.cells[m.to]) === value) return;
            moved.push({ cell: m.to, name: m.name, now: value });
            target.cells[m.to] = value;
        });

        var total = 0;
        TOTAL_FROM.forEach(function (c) {
            var n = toNumber(target.cells[c]);
            if (n !== null) total += n;
        });
        target.cells[TOTAL_CELL] = total;
        target.lastModified = new Date().toISOString();

        if (!opts.dryRun) localStorage.setItem(key, JSON.stringify(target));

        return { ok: true, branch: branch, moved: moved, missing: missing, total: total,
                 target: "Свод расходов" };
    }

    /** Разносит по всем филиалам, где «Сводная общая» заполнена. */
    function all(options) {
        return ["nao", "almaty", "astana", "uralsk"]
            .map(function (b) {
                return toSvod(b, options);
            })
            .filter(function (r) {
                return r.ok;
            });
    }

    /** Вся цепочка разом, в порядке зависимостей книги. */
    function chain(branch, options) {
        var out = [];
        var fzp = fzpToSvod(branch, options);   // ФЗП → строки 10–15 «Свода»
        if (fzp.ok) out.push(fzp);
        var svod = toSvod(branch, options);     // Сводная общая → строки 16–25
        if (svod.ok) out.push(svod);
        var kalk = toKalkulyacia(branch, options); // Свод → Калькуляция
        if (kalk.ok) out.push(kalk);
        return out;
    }

    global.FinkaDerive = {
        toSvod: toSvod,
        toKalkulyacia: toKalkulyacia,
        fzpToSvod: fzpToSvod,
        chain: chain,
        all: all,
        MAP: MAP,
        FZP_MAP: FZP_MAP,
    };
})(window);
