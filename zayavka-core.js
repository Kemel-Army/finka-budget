/**
 * Заявка-потребность (приложение № 2) — расчёты и правила без DOM.
 *
 * Страница zayavki.html рисует форму и ходит в базу, а всё, что можно
 * проверить без браузера, лежит здесь: итоги строк, проверка перед подачей,
 * текст, который подписывается ЭЦП, и разбор сертификата подписанта из
 * CMS. Тесты — tests/zayavki.mjs.
 *
 * Права здесь только для интерфейса (какие кнопки показать). Настоящая
 * проверка — триггер budget.requests_guard (миграция 0004).
 */
(function (root) {
    "use strict";

    /* ── Графы подписей — как в бланке, сверху вниз ─────────────── */
    var SLOTS = [
        {
            key: "director",
            group: "Утверждаю",
            label: "Директор филиала",
            labelNao: "Руководитель НАО «РФМШ»",
        },
        {
            key: "ahr",
            group: "Согласовано",
            label: "Заместитель директора по административно-хозяйственной работе",
        },
        { key: "zakup", group: "Согласовано", label: "Специалист по закупкам" },
        { key: "economist", group: "Согласовано", label: "Экономист" },
        {
            key: "initiator",
            group: "",
            label: "Инициатор / ответственное лицо",
        },
    ];

    var STATUS = {
        draft: { label: "Черновик", tone: "gray" },
        submitted: { label: "На согласовании", tone: "blue" },
        returned: { label: "Возвращена на доработку", tone: "amber" },
        approved: { label: "Утверждена", tone: "green" },
        rejected: { label: "Отклонена", tone: "red" },
    };

    // Источник финансирования — для экономиста: из какого бюджета закуп
    var SOURCES = [
        "Республиканский бюджет",
        "Подушевое финансирование (республиканский бюджет)",
        "Образовательные услуги на возмездной основе",
        "Иные доходы",
        "Депозит",
    ];

    var BRANCH_CITY = {
        nao: "",
        almaty: "Алматы",
        astana: "Астана",
        uralsk: "Уральск",
    };

    /* ── Числа ─────────────────────────────────────────────────── */
    function num(v) {
        if (typeof v === "number") return Number.isFinite(v) ? v : 0;
        var t = String(v == null ? "" : v)
            .replace(/[\s ₸]/g, "")
            .replace(",", ".");
        var n = parseFloat(t);
        return Number.isFinite(n) ? n : 0;
    }

    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    function rowTotal(row) {
        return round2(num(row && row.qty) * num(row && row.price));
    }

    function docTotal(doc) {
        var s = 0;
        ((doc && doc.rows) || []).forEach(function (r) {
            s += rowTotal(r);
        });
        return round2(s);
    }

    function money(n) {
        return num(n).toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    /* ── Содержимое формы ──────────────────────────────────────── */
    function str(v, max) {
        return String(v == null ? "" : v).trim().slice(0, max || 500);
    }

    function isBlankRow(r) {
        return !str(r.name) && !str(r.unit) && !num(r.qty) && !num(r.price) &&
            !str(r.period) && !str(r.purpose);
    }

    /* Приводит форму к одному виду: лишние поля отбрасываются, пустые
       строки таблицы убираются. Именно это и подписывается, поэтому
       результат должен быть одинаковым при каждом вызове. */
    function normalizeDoc(doc, opts) {
        doc = doc || {};
        var year = (opts && opts.year) || new Date().getFullYear() + 1;
        var rows = (Array.isArray(doc.rows) ? doc.rows : [])
            .filter(function (r) {
                return r && !isBlankRow(r);
            })
            .slice(0, 200)
            .map(function (r) {
                return {
                    name: str(r.name, 2000),
                    unit: str(r.unit, 50),
                    qty: num(r.qty),
                    price: num(r.price),
                    period: str(r.period, 300),
                    purpose: str(r.purpose, 2000),
                };
            });
        return {
            year: Math.round(num(doc.year)) || year,
            date: str(doc.date, 10),
            initiator: str(doc.initiator, 300),
            position: str(doc.position, 300),
            fio: str(doc.fio, 200),
            source: str(doc.source, 200),
            spec: str(doc.spec, 50),
            rows: rows,
        };
    }

    // Что мешает подать заявку. Пустой список — можно подписывать
    function validate(doc) {
        var d = normalizeDoc(doc);
        var errs = [];
        if (!d.date) errs.push("Укажите дату заявки");
        if (!d.position) errs.push("Укажите должность");
        if (!d.fio) errs.push("Укажите ФИО");
        if (!d.rows.length) errs.push("Добавьте хотя бы одну позицию");
        d.rows.forEach(function (r, i) {
            var n = "Строка " + (i + 1) + ": ";
            if (!r.name) errs.push(n + "нет наименования");
            if (!r.unit) errs.push(n + "нет единицы измерения");
            if (!(r.qty > 0)) errs.push(n + "количество должно быть больше нуля");
            if (!(r.price > 0)) errs.push(n + "цена должна быть больше нуля");
            if (!r.purpose) errs.push(n + "не указана целесообразность закупа");
        });
        return errs;
    }

    /* ── Что подписывается ─────────────────────────────────────── */
    // JSON с ключами по алфавиту: тот же объект — тот же текст
    function stable(v) {
        if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
        if (v && typeof v === "object") {
            return "{" + Object.keys(v).sort().map(function (k) {
                return JSON.stringify(k) + ":" + stable(v[k]);
            }).join(",") + "}";
        }
        return JSON.stringify(v === undefined ? null : v);
    }

    /* Подписывается номер заявки, филиал и содержимое формы с итогом.
       Подпись согласующего относится к тому же тексту, что и подпись
       инициатора: форма после первой подписи заморожена (триггер). */
    function signedText(req) {
        var doc = normalizeDoc(req.doc);
        return stable({
            form: "Заявка-потребность (приложение № 2)",
            id: req.id,
            no: req.no,
            branch: req.branch,
            doc: doc,
            total: docTotal(doc),
        });
    }

    function utf8ToBase64(s) {
        var bytes = new TextEncoder().encode(s);
        var bin = "";
        for (var i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    /* ── Права (только для интерфейса) ─────────────────────────── */
    function signedSlot(req, slot) {
        var sigs = (req && req.signatures) || [];
        for (var i = 0; i < sigs.length; i++) if (sigs[i].slot === slot) return sigs[i];
        return null;
    }

    function isStaff(p) {
        return !!p && ["admin", "view", "edit", "limited"].indexOf(p.roleKey) !== -1;
    }

    function readsBranch(p, b) {
        if (!p) return false;
        if (p.roleKey === "admin") return true;
        if (p.roleKey !== "initiator" && p.branchKey === "nao") return true;
        return p.branchKey === b;
    }

    // Зеркало budget.can_sign + правила триггера
    function canSign(slot, p, req, uid) {
        if (!p || !req || signedSlot(req, slot)) return false;
        if (slot === "initiator") {
            return req.author === uid && (req.status === "draft" || req.status === "returned");
        }
        if (req.status !== "submitted" && req.status !== "approved") return false;
        if (!signedSlot(req, "initiator")) return false;
        if (slot === "economist") {
            return (p.roleKey === "edit" || p.signer === "economist") && readsBranch(p, req.branch);
        }
        if (slot === "ahr" || slot === "zakup" || slot === "director") {
            return p.signer === slot && p.branchKey === req.branch;
        }
        return false;
    }

    function isReviewer(p) {
        return isStaff(p) || !!(p && p.signer);
    }

    function canEdit(p, req, uid) {
        return !!req && req.author === uid &&
            (req.status === "draft" || req.status === "returned") &&
            !((req.signatures || []).length);
    }

    function canReturn(p, req) {
        return isReviewer(p) && !!req &&
            (req.status === "submitted" || req.status === "approved");
    }

    function canWithdraw(p, req, uid) {
        if (!req || req.author !== uid) return false;
        if (req.status !== "submitted" && req.status !== "returned") return false;
        return !(req.signatures || []).some(function (s) {
            return s.slot !== "initiator";
        });
    }

    function canDelete(p, req, uid) {
        return !!req && req.author === uid &&
            (req.status === "draft" || req.status === "returned") &&
            !((req.signatures || []).length);
    }

    // Графы, которые ждут подписи именно этого пользователя
    function waitingFor(p, req, uid) {
        return SLOTS.filter(function (s) {
            return s.key !== "initiator" && canSign(s.key, p, req, uid);
        }).map(function (s) {
            return s.key;
        });
    }

    /* ── Сертификат подписанта из CMS ──────────────────────────── */
    /* Минимальный разбор DER: из SignedData берётся первый сертификат и из
       него — владелец (ФИО, ИИН, организация, БИН) и срок действия. Это
       подпись к штампу «Подписано ЭЦП», а не проверка подписи: её
       выполняет NCALayer при подписании, а юридически — НУЦ по CMS,
       который хранится целиком. */
    var OID_NAMES = {
        "2.5.4.3": "cn",
        "2.5.4.4": "surname",
        "2.5.4.5": "serial",
        "2.5.4.6": "country",
        "2.5.4.10": "org",
        "2.5.4.11": "ou",
        "2.5.4.42": "given",
        "1.2.840.113549.1.9.1": "email",
    };

    function b64ToBytes(b64) {
        var bin = atob(String(b64).replace(/[^A-Za-z0-9+/=]/g, ""));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function readNode(buf, pos) {
        var tag = buf[pos];
        var p = pos + 1;
        var len = buf[p++];
        if (len & 0x80) {
            var nb = len & 0x7f;
            if (nb === 0 || nb > 4) throw new Error("длина DER");
            len = 0;
            for (var i = 0; i < nb; i++) len = len * 256 + buf[p++];
        }
        if (p + len > buf.length) throw new Error("выход за границу DER");
        return { tag: tag, start: p, end: p + len, next: p + len };
    }

    function children(buf, node) {
        var out = [];
        var p = node.start;
        while (p < node.end) {
            var c = readNode(buf, p);
            out.push(c);
            p = c.next;
        }
        return out;
    }

    function oid(buf, node) {
        var b = buf.subarray(node.start, node.end);
        var parts = [Math.floor(b[0] / 40), b[0] % 40];
        var v = 0;
        for (var i = 1; i < b.length; i++) {
            v = v * 128 + (b[i] & 0x7f);
            if (!(b[i] & 0x80)) {
                parts.push(v);
                v = 0;
            }
        }
        return parts.join(".");
    }

    function text(buf, node) {
        var b = buf.subarray(node.start, node.end);
        if (node.tag === 0x1e) {
            // BMPString — UTF-16BE
            var s = "";
            for (var i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] * 256 + b[i + 1]);
            return s;
        }
        return new TextDecoder("utf-8").decode(b);
    }

    function time(buf, node) {
        var t = text(buf, node);
        // UTCTime YYMMDDhhmmssZ / GeneralizedTime YYYYMMDDhhmmssZ
        var m = node.tag === 0x17
            ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(t)
            : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)/.exec(t);
        if (!m) return "";
        var y = node.tag === 0x17 ? (+m[1] < 50 ? "20" : "19") + m[1] : m[1];
        return y + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":00Z";
    }

    function name(buf, node) {
        var out = {};
        children(buf, node).forEach(function (set) {
            children(buf, set).forEach(function (atv) {
                var kv = children(buf, atv);
                if (kv.length < 2 || kv[0].tag !== 0x06) return;
                var key = OID_NAMES[oid(buf, kv[0])];
                if (key && !out[key]) out[key] = text(buf, kv[1]);
            });
        });
        return out;
    }

    function parseCms(b64) {
        try {
            var buf = b64ToBytes(b64);
            var ci = children(buf, readNode(buf, 0)); // ContentInfo
            var sd = children(buf, children(buf, ci[1])[0]); // SignedData
            var certs = null;
            for (var i = 0; i < sd.length; i++) if (sd[i].tag === 0xa0) certs = sd[i];
            if (!certs) return null;
            var cert = children(buf, certs)[0];
            var tbs = children(buf, children(buf, cert)[0]);
            var k = tbs[0].tag === 0xa0 ? 1 : 0; // version [0] — необязательна
            var validity = children(buf, tbs[k + 3]);
            var subj = name(buf, tbs[k + 4]);
            var issuer = name(buf, tbs[k + 2]);
            var serialHex = Array.prototype.map.call(
                buf.subarray(tbs[k].start, tbs[k].end),
                function (x) {
                    return ("0" + x.toString(16)).slice(-2);
                },
            ).join("");
            var iin = /^IIN(\d{12})$/.exec(subj.serial || "");
            var bin = /^BIN(\d{12})$/.exec(subj.ou || "");
            return {
                cn: subj.cn || "",
                // В казахстанских сертификатах SURNAME — фамилия, CN — фамилия
                // и имя, GIVENNAME — отчество
                fio: [subj.cn, subj.given].filter(Boolean).join(" "),
                iin: iin ? iin[1] : "",
                bin: bin ? bin[1] : "",
                org: subj.org || "",
                email: subj.email || "",
                issuer: issuer.cn || "",
                serial: serialHex,
                notBefore: time(buf, validity[0]),
                notAfter: time(buf, validity[1]),
            };
        } catch (e) {
            return null;
        }
    }

    var api = {
        SLOTS: SLOTS,
        STATUS: STATUS,
        SOURCES: SOURCES,
        BRANCH_CITY: BRANCH_CITY,
        num: num,
        money: money,
        rowTotal: rowTotal,
        docTotal: docTotal,
        normalizeDoc: normalizeDoc,
        validate: validate,
        stable: stable,
        signedText: signedText,
        utf8ToBase64: utf8ToBase64,
        signedSlot: signedSlot,
        canSign: canSign,
        canEdit: canEdit,
        canReturn: canReturn,
        canWithdraw: canWithdraw,
        canDelete: canDelete,
        isReviewer: isReviewer,
        waitingFor: waitingFor,
        parseCms: parseCms,
    };

    root.ZayavkaCore = api;
})(typeof window !== "undefined" ? window : globalThis);
