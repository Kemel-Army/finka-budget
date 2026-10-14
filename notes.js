/**
 * Примечания к документам — «окошечко», где можно оставить комментарий.
 *
 * На каждом листе с навигацией (shared-nav.js подключает этот файл сам)
 * внизу появляется блок «Примечания»: к выбранному филиалу этого листа.
 * Комментировать может любая бюджетная роль, видящая филиал, — в том
 * числе директор в режиме просмотра и ЦА по листу филиала. Хранятся в
 * budget.notes (миграция 0004), не в localStorage: это переписка, а не
 * данные листа.
 *
 * Заявки-потребности подключают тот же блок вручную, к своей заявке:
 *     finkaNotes.mount(el, { branch: "astana", page: "zayavka:<id>" })
 */
(function () {
    "use strict";

    var PAGE = location.pathname.split("/").pop() || "index.html";
    // Здесь блок ставит сама страница (или его там быть не должно)
    var MANUAL = { "index.html": 1, "login.html": 1, "zayavki.html": 1 };

    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function when(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return "";
        return d.toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    function table() {
        return window.finkaAuth.getClient().then(function (c) {
            return c.schema("budget").from("notes");
        });
    }

    function injectStyles() {
        if (document.getElementById("fnotesStyles")) return;
        var css = document.createElement("style");
        css.id = "fnotesStyles";
        css.textContent = [
            ".fnotes{margin:22px 0 8px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;",
            "box-shadow:0 1px 2px rgba(15,23,42,.04);font-size:13.5px;color:#334155}",
            ".fnotes-head{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;",
            "user-select:none;font-weight:650;color:#0f172a}",
            ".fnotes-head small{font-weight:500;color:#64748b}",
            ".fnotes-count{min-width:20px;padding:1px 7px;border-radius:999px;background:#e2e8f0;",
            "color:#334155;font-size:11.5px;text-align:center}",
            ".fnotes-count.has{background:#fef3c7;color:#92400e}",
            ".fnotes-arrow{margin-left:auto;color:#94a3b8;transition:transform .15s}",
            ".fnotes.open .fnotes-arrow{transform:rotate(180deg)}",
            ".fnotes-body{display:none;padding:0 14px 14px}",
            ".fnotes.open .fnotes-body{display:block}",
            ".fnotes-list{list-style:none;margin:0 0 10px;padding:0;max-height:340px;overflow:auto}",
            ".fnotes-item{padding:8px 10px;border-left:3px solid #f59e0b;background:#fffbeb;",
            "border-radius:6px;margin-bottom:6px}",
            ".fnotes-item.mine{border-left-color:#2563eb;background:#eff6ff}",
            ".fnotes-meta{display:flex;gap:8px;align-items:baseline;font-size:12px;color:#64748b;margin-bottom:3px}",
            ".fnotes-meta b{color:#0f172a;font-weight:600}",
            ".fnotes-del{margin-left:auto;border:0;background:none;color:#94a3b8;cursor:pointer;",
            "font-size:12px;padding:0 4px}",
            ".fnotes-del:hover{color:#b91c1c}",
            ".fnotes-text{white-space:pre-wrap;word-break:break-word}",
            ".fnotes-empty{color:#94a3b8;margin:4px 0 10px}",
            ".fnotes-form{display:flex;gap:8px;align-items:flex-end}",
            ".fnotes-form textarea{flex:1;min-height:56px;resize:vertical;padding:8px 10px;",
            "border:1px solid #d3dbe6;border-radius:6px;font:inherit}",
            ".fnotes-form button{padding:8px 14px;border:0;border-radius:6px;background:#2563eb;",
            "color:#fff;font:inherit;font-weight:600;cursor:pointer}",
            ".fnotes-form button:disabled{opacity:.5;cursor:default}",
            ".fnotes-msg{margin-top:6px;font-size:12px;color:#b91c1c}",
            "@media print{.fnotes{display:none}}",
        ].join("");
        (document.head || document.documentElement).appendChild(css);
    }

    /* ── Блок примечаний ───────────────────────────────────────── */
    function mount(host, opts) {
        injectStyles();
        opts = opts || {};
        var target = { branch: opts.branch, page: opts.page };
        var me = null;
        var seq = 0;

        var box = document.createElement("section");
        box.className = "fnotes" + (opts.open ? " open" : "");
        // auth.js не запирает этот блок в режиме просмотра: комментарий —
        // не правка бюджета, директору оставить его можно
        box.setAttribute("data-finka-free", "");
        box.innerHTML =
            '<div class="fnotes-head" role="button" tabindex="0">' +
            "💬 " + esc(opts.title || "Примечания") +
            ' <span class="fnotes-count">0</span>' +
            ' <small class="fnotes-where"></small>' +
            '<span class="fnotes-arrow">▾</span></div>' +
            '<div class="fnotes-body">' +
            '<ul class="fnotes-list"></ul>' +
            '<form class="fnotes-form">' +
            '<textarea maxlength="4000" placeholder="Текст примечания…"></textarea>' +
            '<button type="submit">Отправить</button>' +
            "</form>" +
            '<div class="fnotes-msg"></div>' +
            "</div>";
        host.appendChild(box);

        var head = box.querySelector(".fnotes-head");
        var list = box.querySelector(".fnotes-list");
        var count = box.querySelector(".fnotes-count");
        var where = box.querySelector(".fnotes-where");
        var form = box.querySelector(".fnotes-form");
        var area = form.querySelector("textarea");
        var send = form.querySelector("button");
        var msg = box.querySelector(".fnotes-msg");

        function toggle() {
            box.classList.toggle("open");
        }
        head.addEventListener("click", toggle);
        head.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
            }
        });

        function say(text) {
            msg.textContent = text || "";
        }

        function paint(rows) {
            count.textContent = String(rows.length);
            count.classList.toggle("has", rows.length > 0);
            if (!rows.length) {
                list.innerHTML = '<li class="fnotes-empty">Примечаний пока нет</li>';
                return;
            }
            list.innerHTML = rows.map(function (r) {
                var mine = me && r.author === me;
                return (
                    '<li class="fnotes-item' + (mine ? " mine" : "") + '" data-id="' + esc(r.id) + '">' +
                    '<div class="fnotes-meta"><b>' + esc(r.author_name || r.author_email) + "</b>" +
                    "<span>" + esc(when(r.created_at)) + "</span>" +
                    (mine ? '<button type="button" class="fnotes-del" title="Удалить своё примечание">✕</button>' : "") +
                    "</div>" +
                    '<div class="fnotes-text">' + esc(r.body) + "</div></li>"
                );
            }).join("");
            list.scrollTop = list.scrollHeight;
        }

        function load() {
            var my = ++seq;
            if (!target.branch || !target.page) return Promise.resolve();
            say("");
            return table()
                .then(function (t) {
                    return t
                        .select("id,body,author,author_email,author_name,created_at")
                        .eq("branch", target.branch)
                        .eq("page", target.page)
                        .order("created_at", { ascending: true })
                        .limit(500);
                })
                .then(function (res) {
                    if (my !== seq) return; // уже переключили филиал
                    if (res.error) throw res.error;
                    paint(res.data || []);
                    if (opts.onCount) opts.onCount(res.data.length);
                })
                .catch(function (err) {
                    if (my !== seq) return;
                    paint([]);
                    say(explain(err));
                });
        }

        form.addEventListener("submit", function (e) {
            e.preventDefault();
            var body = area.value.trim();
            if (!body) return;
            send.disabled = true;
            table()
                .then(function (t) {
                    return t.insert({ branch: target.branch, page: target.page, body: body });
                })
                .then(function (res) {
                    if (res.error) throw res.error;
                    area.value = "";
                    return load();
                })
                .catch(function (err) {
                    say(explain(err));
                })
                .then(function () {
                    send.disabled = false;
                });
        });

        list.addEventListener("click", function (e) {
            var del = e.target.closest(".fnotes-del");
            if (!del) return;
            var id = del.closest(".fnotes-item").getAttribute("data-id");
            if (!confirm("Удалить примечание?")) return;
            table()
                .then(function (t) {
                    return t.delete().eq("id", id);
                })
                .then(function (res) {
                    if (res.error) throw res.error;
                    return load();
                })
                .catch(function (err) {
                    say(explain(err));
                });
        });

        window.finkaAuth.getClient()
            .then(function (c) {
                return c.auth.getSession();
            })
            .then(function (res) {
                var s = res && res.data && res.data.session;
                me = s ? s.user.id : null;
            })
            .catch(function () {})
            .then(load);

        return {
            el: box,
            set: function (branch, page, label) {
                if (branch === target.branch && page === target.page) return;
                target = { branch: branch, page: page };
                where.textContent = label || "";
                load();
            },
            reload: load,
        };
    }

    function explain(err) {
        var m = String((err && (err.message || err.details)) || err || "");
        if (/relation .*notes.* does not exist|schema cache|PGRST20[05]|42P01/i.test(m + (err && err.code))) {
            return "Примечания заработают после обновления базы (миграция 0004).";
        }
        if (/row-level security|permission denied|42501/i.test(m + (err && err.code))) {
            return "Нет права оставлять примечания к этому филиалу.";
        }
        return "Не удалось: " + m;
    }

    /* ── Автоматически — на листах бюджета ─────────────────────── */
    var LABEL = {
        nao: "НАО «РФМШ»",
        almaty: "Алматы",
        astana: "Астана",
        uralsk: "Уральск",
        consolidated: "консолидация",
    };

    // Как в auth.js: филиал кнопки — data-branch или switchBranch('…')
    function branchOfButton(btn) {
        var attr = btn.getAttribute("data-branch");
        if (attr) return attr;
        var m = /switchBranch\(\s*['"]([^'"]+)/.exec(btn.getAttribute("onclick") || "");
        return m ? m[1] : "";
    }

    function activeBranch() {
        var btns = document.querySelectorAll(".branch-btn.active");
        for (var i = 0; i < btns.length; i++) {
            var b = branchOfButton(btns[i]);
            if (LABEL[b]) return b;
        }
        return "";
    }

    function auto() {
        if (MANUAL[PAGE] || !window.finkaAuth) return;
        window.finkaAuth.getProfile().then(function (p) {
            if (!p || !p.role || p.roleKey === "initiator") return;
            var host = document.querySelector(".container") || document.body;
            var ctl = mount(host, {});

            function sync() {
                var b = activeBranch() || p.branchKey;
                if (p.branchLocked) b = p.branchKey;
                // Консолидацию обсуждают в строке ЦА, отдельной темой
                var page = b === "consolidated" ? PAGE + "#consolidated" : PAGE;
                ctl.set(b === "consolidated" ? "nao" : b, page, "· " + (LABEL[b] || b));
            }
            sync();
            document.addEventListener("click", function (e) {
                if (e.target.closest && e.target.closest(".branch-btn")) setTimeout(sync, 0);
            });
            // auth.js переключает учётку филиала на свой город с задержкой
            setTimeout(sync, 900);
            setTimeout(sync, 2200);
        });
    }

    window.finkaNotes = { mount: mount };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", auto);
    } else {
        auto();
    }
})();
