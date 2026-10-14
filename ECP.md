# Подпись ЭЦП заявок-потребностей

Устроено как в qoltanba/tamga: браузер подписывает через NCALayer, а
проверяет подпись сервер через **NCANode**. Браузеру база не верит: подпись
вида «ЭЦП» записывается только после проверки на сервере.

```
NCALayer (ПК пользователя)        Vercel                       NCANode            Supabase
  ключ SIGN, detached CMS  ──►  /api/ecp-sign  ──►  /cms/verify (цепочка НУЦ,
  над текстом заявки             (api/_lib/ecp.js)   отзыв OCSP, метка времени)
                                       └──────────────────────────────────►  budget.add_ecp_signature
                                                                              (секрет сервера + триггер)
```

Что проверяется:

| Проверка | Где |
|---|---|
| Кто подписывает — по токену Supabase | api/_lib/ecp.js |
| Что подписано — текст заявки **из базы** (CMS без вложенных данных) | api/_lib/ecp.js → NCANode |
| Подпись верна, сертификат НУЦ действует и не отозван (OCSP) | NCANode |
| Ключ для подписи (SIGN), а не для входа (AUTH) | api/_lib/ecp.js |
| Ключ свой: ИИН учётки (если задан), иначе фамилия | api/_lib/ecp.js, триггер |
| Право на графу (автор, АХР, закупки, экономист, директор), статус | триггер `requests_guard` |
| ЭЦП из браузера в обход сервера не записать | флаг `budget.ecp_verified` + секрет (миграция 0005) |

Без настройки сервера заявки работают с отметкой «без ЭЦП». Кнопка ЭЦП
тогда сразу говорит, что проверка не настроена, и не просит пароль ключа.

## Запуск — четыре шага

### 1. База

SQL Editor → выполнить `supabase/migrations/0005_budget_ecp_verified.sql`.

### 2. Секрет

```
node scripts/ecp-secret.mjs
```

Скрипт печатает значение `ECP_SECRET` для Vercel и SQL с **хешем** секрета.
SQL выполнить в SQL Editor. Сам секрет — только в Vercel.

### 3. NCANode

NCANode — Java-сервис (`malikzh/ncanode`), на Vercel он не запускается. На
сервере qoltanba он уже работает (`docker-compose.prod.yaml`, сервис
`ncanode`), но открыт только внутри docker-сети. Открываем наружу через
тот же Caddy: только два адреса и только с токеном.

DNS: `ncanode.abai.live` → IP сервера. В `.env` сервера:
`NCANODE_TOKEN=<длинная случайная строка>`. В `Caddyfile` дописать:

```
ncanode.abai.live {
	@allowed {
		header X-Ncanode-Token {$NCANODE_TOKEN}
		path /cms/verify /actuator/health
	}
	handle @allowed {
		reverse_proxy ncanode:14579
	}
	respond 403
}
```

`docker compose -f docker-compose.prod.yaml up -d caddy` — Caddy сам
получит сертификат. Проверка:

```
curl -H "X-Ncanode-Token: <токен>" https://ncanode.abai.live/actuator/health   → {"status":"UP"}
curl https://ncanode.abai.live/actuator/health                                → 403
```

Для OCSP/CRL серверу NCANode нужен выход в интернет к `pki.gov.kz`.

### 4. Vercel

Settings → Environment Variables (Production):

| Переменная | Значение |
|---|---|
| `NCANODE_URL` | `https://ncanode.abai.live` |
| `NCANODE_TOKEN` | тот же токен, что в Caddy |
| `ECP_SECRET` | из шага 2 |
| `NCANODE_REVOCATION` | необязательно: `OCSP` (по умолчанию), `CRL` или `OCSP,CRL` |

Redeploy. Проверка: `https://<сайт>/api/ecp-sign` → `{"ready":true,"ncanode":true}`.

## Привязка ключа к учётке (по желанию)

По умолчанию сверяется фамилия в сертификате с ФИО учётки. Строже — ИИН:
добавить `"iin": "…"` нужным людям в `scripts/initiators-*.local.json` и
перезапустить `node scripts/create-users.mjs --file …` (пароли не меняются).
Тогда и сервер, и база примут подпись только ключом с этим ИИН.

## Проверка руками

1. Инициатор: новая заявка → «Подписать ЭЦП и подать» → NCALayer → ключ
   **RSA…/GOST… без AUTH** → пароль. На бланке — «Подписано ЭЦП · проверено
   НУЦ», ФИО, ИИН, метка времени.
2. Выбрать ключ AUTH — сервер откажет с понятным сообщением.
3. Экономист/директор подписывают свои графы так же.

Тесты без сети: `node tests/ecp.mjs` (сервер), `node tests/sql-local.mjs`
(база), `node tests/e2e-zayavki.mjs` (весь путь в браузере).
