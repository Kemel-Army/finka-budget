/**
 * Подпись ЭЦП через NCALayer (НУЦ РК) — браузерная половина.
 *
 * Клиент — ncalayer-js-client от SIGEX (vendor/ncalayer-client-1.5.10.js,
 * npm-пакет без изменений, MIT; тот же, что в qoltanba/tamga). NCALayer —
 * программа на компьютере пользователя: она сама показывает окно выбора
 * ключа и пароля, наружу отдаёт только готовую подпись CMS. Ключ и пароль в
 * браузер не попадают. Установка: https://pki.gov.kz/ncalayer/
 *
 * Подписывается ключом SIGN (не AUTH), подпись без вложенных данных
 * (detached) с меткой времени TSP НУЦ. Сами данные сервер восстанавливает
 * из базы и проверяет подпись именно на них — см. api/ecp-sign.js.
 *
 *     finkaNcaLayer.signBase64(base64).then(cms => …)
 *
 * Ошибки: err.code = "offline" (NCALayer не запущен), "cancel" (человек
 * закрыл окно), "fail" — остальное.
 */
(function () {
    "use strict";

    function NcaError(code, message) {
        var e = new Error(message);
        e.code = code;
        return e;
    }

    // NCALayer отдаёт CMS то голым base64, то в PEM-обёртке
    function stripPem(s) {
        return String(s || "")
            .replace(/-----BEGIN [A-Z\s]+-----/g, "")
            .replace(/-----END [A-Z\s]+-----/g, "")
            .replace(/\s+/g, "");
    }

    function signBase64(b64) {
        var Client = window.NCALayerClient;
        if (!Client) {
            return Promise.reject(NcaError("fail", "Не загружен клиент NCALayer"));
        }
        // Один клиент — одно подключение: повторный connect() библиотека
        // запрещает
        var client = new Client();
        return client
            .connect()
            .catch(function () {
                throw NcaError(
                    "offline",
                    "Нет связи с NCALayer. Установите NCALayer (pki.gov.kz), запустите его и повторите.",
                );
            })
            .then(function () {
                return client.basicsSignCMS(
                    Client.basicsStorageAll,
                    b64,
                    Client.basicsCMSParamsDetached,
                    Client.basicsSignerSignAny,
                );
            })
            .then(function (cms) {
                var out = stripPem(Array.isArray(cms) ? cms[0] : cms);
                if (!out) throw NcaError("cancel", "Подписание отменено");
                return out;
            }, function (err) {
                if (err && err.code) throw err;
                if (err && err.canceledByUser) throw NcaError("cancel", "Подписание отменено");
                throw NcaError("fail", "NCALayer: " + ((err && err.message) || "ошибка подписи"));
            });
    }

    window.finkaNcaLayer = { signBase64: signBase64 };
})();
