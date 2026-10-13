/**
 * Глобалы FINKA Budget для проверки типов (npm run typecheck).
 *
 * Сборки нет: общие скрипты подключаются к страницам обычными <script> и
 * отдают своё API через window. Здесь описано, кто что кладёт в window, —
 * чтобы tsc видел связи между файлами. Описание намеренно неглубокое
 * (any там, где форма объекта не важна для проверки), главное — имена.
 */

export {};

declare global {
    /** Профиль учётки из auth.js (app_metadata пользователя Supabase). */
    interface FinkaProfile {
        email: string;
        title: string;
        roleKey: string | null;
        role: {
            label: string;
            zone: string;
            canEdit: boolean;
            canImport: boolean;
            canExport: boolean;
            pages: string[] | null;
        } | null;
        branchKey: string;
        branch: string;
        branchLocked: boolean;
    }

    interface Window {
        /* auth.js */
        finkaAuth: {
            getClient(): Promise<any>;
            signOut(): Promise<void>;
            getProfile(): Promise<FinkaProfile | null>;
        };
        /* db-sync.js */
        finkaSync: {
            pull(): Promise<number>;
            push(): Promise<number>;
            stats(): any;
            paint(): void;
            state(): { profile: FinkaProfile | null; lastError: string };
            [internal: string]: any;
        };
        /* shared-nav.js */
        finkaToast(message: string, type?: string): void;
        /* shared-export.js */
        SharedExport: any;
        /* formulas.js — ставки налогов, правятся на странице */
        finkaRates: {
            get(name: string): number;
            set(name: string, value: any): void;
            reset(): void;
            all: Record<string, any>;
        };
        /* sheet-ux.js */
        finkaSheetUx: { apps: Array<(...args: any[]) => any> };
        sheetUX: {
            attach(...args: any[]): any;
            refresh(...args: any[]): any;
            parseNumber(raw: any): number | null;
        };
        /* ui-kit.js */
        finkaUi: any;
        /* budget-rows.js */
        BUDGET_ROWS: Record<string, Array<{ code?: string; name: string; [k: string]: any }>>;
        BUDGET_CODE_FOR(name: string): string;
        /* derive.js */
        FinkaDerive: any;
        /* monthly-plan-core.js, plan-fact-core.js */
        MonthlyPlan: { init(cfg: any): void; MONTHS: string[] };
        PlanFact: { init(cfg: any): void; MONTHS: string[] };
        /* deposit-core.js */
        DepositCore: any;
        /* Кнопки «Сохранить» / «Excel» страниц зовут эти функции из onclick */
        saveData(): void;
        exportExcel(): void;

        /* Supabase SDK (CDN / vendor/) — ставит window.supabase */
        supabase: { createClient(url: string, key: string, options?: any): any };
        /* SheetJS */
        XLSX: any;
        /* Старый IE: буфер обмена на window, sheet-ux.js берёт его запасным */
        clipboardData?: DataTransfer;
    }

    /** SheetJS (xlsx.full.min.js) — подключается со страницы. */
    var XLSX: any;

    /* Страницы работают с DOM без приведения типов, как обычно и пишут
       на JS: e.target.closest(...), el.style, el.dataset у результата
       querySelector. На HTML-странице это всегда HTMLElement, но в
       типах DOM querySelector отдаёт Element, а event.target —
       EventTarget. Чтобы не обвешивать каждую строку JSDoc-приведением,
       эти три самых частых свойства объявлены шире. */
    interface EventTarget {
        closest?(selectors: string): Element | null;
    }
    interface Element {
        readonly dataset: DOMStringMap;
        readonly style: CSSStyleDeclaration;
    }
}
