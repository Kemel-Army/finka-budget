// ESLint (flat config) для FINKA Budget.
//
//     npm run lint:js
//
// Сборки нет: общие *.js подключаются к страницам обычными <script> и
// общаются через window (finkaSync, finkaAuth, SharedExport, …). Поэтому
// для них sourceType "script" и явный список глобалов проекта.
//
// Правило: ошибкой (error) считается то, что ломает код в браузере, —
// необъявленная переменная, дубликат ключа, недостижимый код, присваивание
// константе и т. п. Стилистика — предупреждения (warn), чтобы не править
// массово чужие файлы ради линтера.
import js from "@eslint/js";
import globals from "globals";
import html from "eslint-plugin-html";

// Глобалы, которые одни файлы проекта кладут в window, а другие читают
const PROJECT_GLOBALS = {
    // auth.js, db-sync.js
    finkaAuth: "readonly",
    finkaSync: "readonly",
    // shared-nav.js
    finkaToast: "readonly",
    // shared-export.js
    SharedExport: "readonly",
    // sheet-ux.js, ui-kit.js
    finkaSheetUx: "readonly",
    sheetUX: "readonly",
    finkaUi: "readonly",
    // formulas.js, derive.js, budget-rows.js
    finkaRates: "readonly",
    FinkaDerive: "readonly",
    BUDGET_ROWS: "readonly",
    BUDGET_CODE_FOR: "readonly",
    // monthly-plan-core.js, plan-fact-core.js, deposit-core.js
    MonthlyPlan: "readonly",
    PlanFact: "readonly",
    DepositCore: "readonly",
    ZayavkaCore: "readonly",
    finkaNotes: "readonly",
    finkaNcaLayer: "readonly",
    // внешние библиотеки (CDN / vendor/)
    XLSX: "readonly",
    supabase: "readonly",
    html2pdf: "readonly",
    html2canvas: "readonly",
    jspdf: "readonly",
};

// Стилистика и «подозрительное, но рабочее» — только предупреждения
const SOFT = {
    "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    "no-empty": ["warn", { allowEmptyCatch: true }],
    "no-useless-escape": "warn",
    "no-prototype-builtins": "warn",
    "no-cond-assign": ["warn", "except-parens"],
    "no-fallthrough": "warn",
    "no-inner-declarations": "off",
    "no-control-regex": "warn",
    "no-misleading-character-class": "warn",
    "no-useless-assignment": "warn",
    "preserve-caught-error": "off",
};

// Неразрывные пробелы в регулярках и строках — намеренные: так
// toLocaleString("ru-RU") разделяет разряды
const WHITESPACE = {
    "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipRegExps: true, skipTemplates: true, skipComments: true },
    ],
};

// Реальные ошибки — явно error, даже если пресет когда-нибудь ослабит
const HARD = {
    "no-undef": "error",
    "no-dupe-keys": "error",
    "no-dupe-args": "error",
    "no-dupe-else-if": "error",
    "no-duplicate-case": "error",
    "no-unreachable": "error",
    "no-const-assign": "error",
    "no-func-assign": "error",
    "no-redeclare": "error",
    "no-self-assign": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-negation": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
};

export default [
    {
        ignores: [
            "node_modules/**",
            "vendor/**",
            "backup/**",
            "excel/**",
            "dist/**",
            "supabase/**",
            "docker/**",
            // локальные пароли для входа — шаблон, не код страниц
            "dev-logins*.js",
        ],
    },
    js.configs.recommended,
    {
        // Общие скрипты страниц: браузер, обычный <script>
        files: ["*.js"],
        ignores: ["vite.config.js"],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: "script",
            globals: { ...globals.browser, ...PROJECT_GLOBALS },
        },
        rules: { ...SOFT, ...HARD, ...WHITESPACE },
    },
    {
        // Встроенные <script> страниц (eslint-plugin-html): все скрипты
        // страницы — одна область видимости, как и в браузере. Функции,
        // которые зовутся из onclick="…", линтер не видит вызванными, —
        // поэтому no-unused-vars здесь выключено.
        files: ["*.html"],
        plugins: { html },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                ...PROJECT_GLOBALS,
                // объявлены во втором <script> страниц ПУ, зовутся из
                // первого — к моменту вызова функции уже есть, а линтер
                // смотрит скрипты по порядку
                addDetailToggles: "readonly",
                removeDetailToggles: "readonly",
            },
        },
        rules: {
            ...SOFT,
            ...HARD,
            ...WHITESPACE,
            "no-unused-vars": "off",
            // addDetailToggles и т. п. объявлены выше как глобалы
            "no-redeclare": ["error", { builtinGlobals: false }],
            // Неявный window.event: в обработчике, вызванном из кода, а не
            // кликом, его нет — передавайте кнопку/событие параметром
            "no-restricted-globals": ["error", "event"],
        },
    },
    {
        // Сам конфиг и прочие ES-модули node в корне
        files: ["*.mjs", "vite.config.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.node },
        },
        rules: { ...SOFT, ...HARD, ...WHITESPACE },
    },
    {
        // Тесты: node, ES-модули; внутри page.evaluate код выполняется в
        // браузере, поэтому глобалы браузера тоже разрешены
        files: ["tests/**/*.mjs", "scripts/**/*.mjs", "scripts/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.node, ...globals.browser, ...PROJECT_GLOBALS },
        },
        rules: { ...SOFT, ...HARD, ...WHITESPACE },
    },
];
