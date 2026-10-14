/**
 * Подпись ЭЦП через NCALayer (НУЦ РК).
 *
 * NCALayer — программа на компьютере пользователя, она держит веб-сокет
 * wss://127.0.0.1:13579 и сама показывает окно выбора ключа и ввода
 * пароля. Ключ и пароль в браузер не попадают, наружу отдаётся только
 * готовая подпись CMS (base64). Установка: https://pki.gov.kz/ncalayer/
 *
 * Пробуем модуль kz.gov.pki.knca.basics (NCALayer 1.4+), если его нет —
 * старый kz.gov.pki.knca.commonUtils.
 *
 *     finkaNcaLayer.signBase64(base64).then(cms => …)
 *
 * Разрешение wss://127.0.0.1:13579 в Content-Security-Policy — vercel.json
 * и docker/security-headers.conf.
 */
(function () {
    "use strict";

    var URL = "wss://127.0.0.1:13579/";
    var CONNECT_MS = 4000;

    function NcaError(code, message) {
        var e = new Error(message);
        e.code = code;
        return e;
    }

    // Один запрос — одно соединение: NCALayer держит окно подписи модальным,
    // параллельных запросов всё равно не бывает
    function call(payload) {
        return new Promise(function (resolve, reject) {
            var ws;
            var done = false;
            try {
                ws = new WebSocket(URL);
            } catch (e) {
                reject(NcaError("offline", "NCALayer недоступен"));
                return;
            }
            var timer = setTimeout(function () {
                finish(null, NcaError("offline", "NCALayer не отвечает. Запустите NCALayer и повторите."));
            }, CONNECT_MS);

            function finish(value, err) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try {
                    ws.close();
                } catch (e) {
                    /* уже закрыт */
                }
                if (err) reject(err);
                else resolve(value);
            }

            ws.onopen = function () {
                // Дальше ждём человека: он выбирает ключ и вводит пароль
                clearTimeout(timer);
                ws.send(JSON.stringify(payload));
            };
            ws.onerror = function () {
                finish(null, NcaError(
                    "offline",
                    "Нет связи с NCALayer. Установите NCALayer (pki.gov.kz), запустите его и повторите.",
                ));
            };
            ws.onclose = function () {
                finish(null, NcaError("offline", "NCALayer закрыл соединение"));
            };
            ws.onmessage = function (ev) {
                var msg;
                try {
                    msg = JSON.parse(ev.data);
                } catch (e) {
                    return;
                }
                // Первым сообщением NCALayer присылает свою версию
                if (msg && msg.result && msg.result.version && !("status" in msg)) return;
                finish(msg, null);
            };
        });
    }

    function pick(result) {
        if (Array.isArray(result)) return result[0];
        return result;
    }

    function viaBasics(b64) {
        return call({
            module: "kz.gov.pki.knca.basics",
            method: "sign",
            args: {
                allowedStorages: null,
                format: "cms",
                data: b64,
                signingParams: { decode: true, encapsulate: true, digested: false },
                // Ключ для подписи (не для входа): EKU «защита эл. почты»
                signerParams: { extKeyUsageOids: ["1.3.6.1.5.5.7.3.4"] },
                locale: "ru",
            },
        }).then(function (msg) {
            if (msg.status === true) {
                var cms = msg.body && pick(msg.body.result);
                if (!cms) throw NcaError("cancel", "Подписание отменено");
                return cms;
            }
            var details = String(msg.details || msg.message || msg.code || "");
            if (/cancel/i.test(details)) throw NcaError("cancel", "Подписание отменено");
            if (/module|not found|не найден/i.test(details)) {
                throw NcaError("nomodule", details);
            }
            throw NcaError("fail", "NCALayer: " + (details || "ошибка подписи"));
        });
    }

    function viaCommonUtils(b64) {
        return call({
            module: "kz.gov.pki.knca.commonUtils",
            method: "createCAdESFromBase64",
            args: ["PKCS12", "SIGNATURE", b64, true],
        }).then(function (msg) {
            if (String(msg.code) === "200" && msg.responseObject) return msg.responseObject;
            if (String(msg.code) === "500" && /action\.canceled/i.test(msg.message || "")) {
                throw NcaError("cancel", "Подписание отменено");
            }
            throw NcaError("fail", "NCALayer: " + (msg.message || msg.code || "ошибка подписи"));
        });
    }

    function signBase64(b64) {
        return viaBasics(b64).catch(function (err) {
            if (err.code === "nomodule") return viaCommonUtils(b64);
            throw err;
        });
    }

    window.finkaNcaLayer = { signBase64: signBase64 };
})();
