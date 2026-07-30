/**
 * Небольшой DOM с настоящим деревом узлов.
 *
 * dom-stub.mjs хранит элементы плоским списком по id — этого хватает
 * страницам, которые пишут разметку строкой. Новые движки (plan-fact-core.js,
 * monthly-plan-core.js) строят таблицу узлами и ищут ячейки селекторами вида
 * `#pfBody input[data-row="111"][data-col="plan"]`, поэтому им нужно дерево.
 *
 * Поддерживаются селекторы: тег, #id, .класс, [атрибут], [атрибут="значение"],
 * :last-child и вложенность через пробел. Больше нигде в проекте не нужно.
 */

let uid = 0;

function parseSelector(sel) {
    return sel
        .trim()
        .split(/\s+(?![^[]*\])/)
        .filter(Boolean)
        .map((part) => {
            const step = { tag: null, id: null, classes: [], attrs: [], lastChild: false };
            let rest = part;

            rest = rest.replace(/:last-child/g, () => {
                step.lastChild = true;
                return "";
            });
            rest = rest.replace(/\[([\w-]+)(?:=("?)([^\]"]*)\2)?\]/g, (_, name, __, value) => {
                step.attrs.push([name, value === undefined ? null : value]);
                return "";
            });
            rest = rest.replace(/#([\w-]+)/g, (_, v) => {
                step.id = v;
                return "";
            });
            rest = rest.replace(/\.([\w-]+)/g, (_, v) => {
                step.classes.push(v);
                return "";
            });
            if (rest.trim()) step.tag = rest.trim().toLowerCase();
            return step;
        });
}

function matchStep(el, step) {
    if (step.tag && el.tagName.toLowerCase() !== step.tag) return false;
    if (step.id && el.id !== step.id) return false;
    if (step.classes.some((c) => !el.classList.contains(c))) return false;
    if (
        step.attrs.some(([name, value]) => {
            const actual = el.getAttribute(name);
            if (actual === null) return true;
            return value !== null && String(actual) !== value;
        })
    )
        return false;
    if (step.lastChild) {
        const p = el.parentNode;
        if (!p || p.children[p.children.length - 1] !== el) return false;
    }
    return true;
}

function makeElement(tagName, doc) {
    const attrs = new Map();
    const el = {
        _uid: ++uid,
        tagName: String(tagName).toUpperCase(),
        parentNode: null,
        children: [],
        style: {},
        value: "",
        type: "",
        step: "",
        title: "",
        disabled: false,
        checked: false,
        _text: "",
        _listeners: {},
        ownerDocument: doc,
    };

    el.dataset = new Proxy(
        {},
        {
            get: (_, k) => attrs.get("data-" + kebab(k)),
            set: (_, k, v) => {
                attrs.set("data-" + kebab(k), String(v));
                return true;
            },
            has: (_, k) => attrs.has("data-" + kebab(k)),
        },
    );

    Object.defineProperty(el, "id", {
        get: () => attrs.get("id") || "",
        set: (v) => {
            attrs.set("id", String(v));
            doc._index.set(String(v), el);
        },
    });

    Object.defineProperty(el, "className", {
        get: () => attrs.get("class") || "",
        set: (v) => attrs.set("class", String(v)),
    });

    el.classList = {
        add(...cs) {
            const set = new Set(el.className.split(/\s+/).filter(Boolean));
            cs.forEach((c) => set.add(c));
            el.className = [...set].join(" ");
        },
        remove(...cs) {
            const set = new Set(el.className.split(/\s+/).filter(Boolean));
            cs.forEach((c) => set.delete(c));
            el.className = [...set].join(" ");
        },
        contains: (c) => el.className.split(/\s+/).includes(c),
        toggle(c, on) {
            if (on === undefined ? el.classList.contains(c) : !on) el.classList.remove(c);
            else el.classList.add(c);
        },
    };

    Object.defineProperty(el, "textContent", {
        get() {
            if (el.children.length) {
                return el.children.map((c) => c.textContent).join("");
            }
            return el._text;
        },
        set(v) {
            el.children.length = 0;
            el._text = String(v);
        },
    });

    Object.defineProperty(el, "innerHTML", {
        get: () => el._html || "",
        set(v) {
            el._html = String(v);
            el.children.length = 0;
            hydrate(el, String(v), doc);
        },
    });

    el.setAttribute = (n, v) => {
        if (n === "id") el.id = v;
        else if (n === "class") el.className = v;
        else attrs.set(n, String(v));
    };
    el.getAttribute = (n) => {
        if (n === "id") return attrs.get("id") || null;
        if (n === "class") return attrs.get("class") || null;
        if (n === "type" && el.type) return el.type;
        return attrs.has(n) ? attrs.get(n) : null;
    };
    el.removeAttribute = (n) => attrs.delete(n);

    el.appendChild = (child) => {
        child.parentNode = el;
        el.children.push(child);
        return child;
    };
    el.removeChild = (child) => {
        el.children = el.children.filter((c) => c !== child);
        child.parentNode = null;
    };

    el.focus = () => {};
    el.blur = () => {};
    el.click = () => el.dispatch("click");

    el.addEventListener = (ev, fn) => {
        (el._listeners[ev] = el._listeners[ev] || []).push(fn);
    };
    el.dispatch = (ev, payload) => {
        const e = Object.assign({ target: el, preventDefault() {}, stopPropagation() {} }, payload);
        // всплытие: обработчик может висеть на предке
        let node = el;
        while (node) {
            (node._listeners[ev] || []).forEach((fn) => fn.call(node, e));
            node = node.parentNode;
        }
    };
    el.closest = (sel) => {
        const steps = parseSelector(sel);
        let node = el;
        while (node) {
            if (matchStep(node, steps[steps.length - 1])) return node;
            node = node.parentNode;
        }
        return null;
    };
    el.matches = (sel) => matchStep(el, parseSelector(sel)[0]);

    el.querySelectorAll = (sel) => queryAll(el, sel);
    el.querySelector = (sel) => queryAll(el, sel)[0] || null;

    return el;
}

function kebab(k) {
    return String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function descendants(root, out = []) {
    root.children.forEach((c) => {
        out.push(c);
        descendants(c, out);
    });
    return out;
}

function queryAll(root, sel) {
    const groups = sel.split(",").map((s) => parseSelector(s));
    const all = descendants(root);
    const hit = [];
    all.forEach((el) => {
        if (groups.some((steps) => matchChain(el, steps, root))) hit.push(el);
    });
    hit.forEach = Array.prototype.forEach;
    return hit;
}

function matchChain(el, steps, root) {
    if (!matchStep(el, steps[steps.length - 1])) return false;
    let i = steps.length - 2;
    let node = el.parentNode;
    while (i >= 0) {
        if (!node || node === root.parentNode) return false;
        if (matchStep(node, steps[i])) i--;
        node = node.parentNode;
        if (!node && i >= 0) return false;
    }
    return true;
}

/* Разбор html-строки: движки собирают шапку и подвал таблицы строкой,
   а потом ищут в них ячейки по id — значит эти узлы должны появиться. */
function hydrate(parent, html, doc) {
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
    let node = parent;
    let m;
    while ((m = re.exec(html))) {
        if (m[5] !== undefined) {
            const text = m[5].replace(/\s+/g, " ");
            if (text.trim() && node !== parent) node._text += text;
            continue;
        }
        const [, close, tag, attrStr, selfClose] = m;
        if (close) {
            if (node !== parent) node = node.parentNode || parent;
            continue;
        }
        const el = makeElement(tag, doc);
        for (const a of attrStr.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
            if (!a[1]) continue;
            el.setAttribute(a[1], a[2] === undefined ? "" : a[2]);
        }
        if (el.getAttribute("value") !== null) el.value = el.getAttribute("value");
        if (el.getAttribute("type") !== null) el.type = el.getAttribute("type");
        node.appendChild(el);
        const VOID = ["input", "br", "hr", "img", "col", "meta", "link"];
        if (!selfClose && !VOID.includes(tag.toLowerCase())) node = el;
    }
}

export function makeMiniDom() {
    const store = new Map();
    const doc = { _index: new Map() };

    doc.createElement = (tag) => makeElement(tag, doc);
    doc.getElementById = (id) => {
        const el = doc._index.get(id);
        return el && isAttached(el, doc.body) ? el : el || null;
    };
    doc.querySelectorAll = (sel) => queryAll(doc.body, sel);
    doc.querySelector = (sel) => queryAll(doc.body, sel)[0] || null;
    doc.addEventListener = () => {};
    doc.body = makeElement("body", doc);
    doc.head = makeElement("head", doc);
    doc.readyState = "complete";

    const window = {
        document: doc,
        addEventListener: () => {},
        print: () => {},
        matchMedia: () => ({ matches: false }),
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
            clear: () => store.clear(),
            get length() {
                return store.size;
            },
            key: (i) => [...store.keys()][i],
        },
    };
    window.window = window;

    return { window, document: doc, storage: window.localStorage };
}

function isAttached() {
    return true;
}
