/**
 * Минимальная заглушка DOM: достаточно, чтобы выполнить расчётный скрипт
 * страницы и прочитать результаты. Никакой вёрстки — только id, value,
 * textContent, innerHTML, class.
 */
export function makeDom() {
    const byId = new Map();

    function mkEl(id, tag = "div") {
        const el = {
            id,
            tagName: tag,
            value: "",
            _text: "",
            disabled: false,
            className: "",
            style: {},
            get textContent() {
                return this._text;
            },
            set textContent(v) {
                this._text = String(v);
            },
            get innerHTML() {
                return this._html || "";
            },
            set innerHTML(v) {
                this._html = v;
                // Разбираем теги: создаём элементы по id и переносим value,
                // иначе страница, которая строит разметку сама, увидит нули
                for (const tag of v.matchAll(/<(\w+)\b([^>]*)>/g)) {
                    const attrs = tag[2];
                    const idm = attrs.match(/\bid="([^"]*)"/);
                    if (!idm) continue;
                    const id = idm[1];
                    const el = byId.get(id) || mkEl(id, tag[1]);
                    const vm = attrs.match(/\bvalue="([^"]*)"/);
                    if (vm) el.value = vm[1];
                }
            },
            classList: {
                add() {},
                remove() {},
                contains() {
                    return false;
                },
            },
            querySelectorAll: () => [],
            querySelector: () => null,
            appendChild() {},
            addEventListener() {},
            closest: () => null,
            matches: () => false,
            removeAttribute() {},
            setAttribute() {},
            getAttribute: () => null,
            scrollIntoView() {},
            focus() {},
            hidden: false,
        };
        byId.set(id, el);
        return el;
    }

    const store = new Map();

    const document = {
        getElementById: (id) => byId.get(id) || null,
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => mkEl("_" + Math.random(), tag),
        addEventListener() {},
        body: mkEl("body"),
        head: mkEl("head"),
        readyState: "complete",
        documentElement: mkEl("html"),
    };

    const window = {
        document,
        addEventListener(ev, fn) {
            if (ev === "load") window._onload = fn;
        },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
            get length() {
                return store.size;
            },
            key: (i) => [...store.keys()][i],
        },
        event: null,
    };

    return { window, document, byId, ensure: (id) => byId.get(id) || mkEl(id, "input") };
}
