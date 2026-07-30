/**
 * Шаблон быстрых входов для локальной разработки.
 *
 * Скопировать в dev-logins.js и вписать реальные пароли:
 *     cp dev-logins.example.js dev-logins.js
 *
 * dev-logins.js в git не попадает (.gitignore), не деплоится на Vercel
 * (.vercelignore) и не попадает в образ (.dockerignore). Кнопки быстрого
 * входа появляются только если файл физически лежит рядом И страница
 * открыта на localhost.
 */
window.FINKA_DEV_LOGINS = [
    {
        role: "Просмотр",
        accounts: [
            { branch: "ЦА", email: "view@rfmsh.kz", password: "" },
            { branch: "Алматы", email: "view.ala@rfmsh.kz", password: "" },
            { branch: "Астана", email: "view.ast@rfmsh.kz", password: "" },
            { branch: "Уральск", email: "view.ura@rfmsh.kz", password: "" },
        ],
    },
    {
        role: "Работа",
        accounts: [
            { branch: "ЦА", email: "edit@rfmsh.kz", password: "" },
            { branch: "Алматы", email: "edit.ala@rfmsh.kz", password: "" },
            { branch: "Астана", email: "edit.ast@rfmsh.kz", password: "" },
            { branch: "Уральск", email: "edit.ura@rfmsh.kz", password: "" },
        ],
    },
    {
        role: "Огранич.",
        accounts: [
            { branch: "ЦА", email: "lim@rfmsh.kz", password: "" },
            { branch: "Алматы", email: "lim.ala@rfmsh.kz", password: "" },
            { branch: "Астана", email: "lim.ast@rfmsh.kz", password: "" },
            { branch: "Уральск", email: "lim.ura@rfmsh.kz", password: "" },
        ],
    },
    {
        role: "Инициатор",
        accounts: [
            { branch: "ЦА", email: "init@rfmsh.kz", password: "" },
            { branch: "Алматы", email: "init.ala@rfmsh.kz", password: "" },
            { branch: "Астана", email: "init.ast@rfmsh.kz", password: "" },
            { branch: "Уральск", email: "init.ura@rfmsh.kz", password: "" },
        ],
    },
    {
        role: "Админ",
        accounts: [{ branch: "ЦА", email: "admin@rfmsh.kz", password: "" }],
    },
];
