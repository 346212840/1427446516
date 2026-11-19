/* One send sheet: direct bot, forward through the owner's bot chat, or as me. */
(function (root) {
  "use strict";
  var recentKey = "viktorych-voice-recent";

  function tr(key, vars) {
    var fn = root.t;
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch];
    });
  }
  function apiBase() {
    var accounts = root.ViktorychAccounts;
    var cur = accounts && accounts.currentApi ? accounts.currentApi() : "";
    if (!cur && root.VIKTORYCH_ACCOUNTS) cur = root.VIKTORYCH_ACCOUNTS.api || "";
    return String(cur || "").replace(/\/$/, "");
  }
  function token() {
    var accounts = root.ViktorychAccounts;
    return accounts && accounts.token ? accounts.token() : "";
  }
  function recent() {
    try { return JSON.parse(localStorage.getItem(recentKey) || "[]") || []; }
    catch (err) { return []; }
  }
  function remember(row) {
    var next = recent().filter(function (item) { return item.id !== row.id; });
    next.unshift({ id: row.id, name: row.name || "" });
    localStorage.setItem(recentKey, JSON.stringify(next.slice(0, 8)));
  }

  var view = { open: false, status: "", chats: [], bot: "", transcript: "", blob: null, query: "" };

  function sheet() {
    if (!view.open) return "";
    var account = root.ViktorychTgAccount;
    var flood = account ? account.floodWait() : 0;
    var rows = chatRows();
    var me = account && account.on()
      ? "<button type=\"button\" class=\"ac-btn\" data-vs=\"me\"" + (flood ? " disabled" : "") + ">" + esc(tr("As me")) + "</button>" +
        (flood ? "<p class=\"ac-note\">" + esc(tr("Retry")) + " " + Math.ceil(flood / 1000) + "</p>" : "")
      : "";
    return "<div class=\"ac-sheet\" data-voice-sheet><div class=\"ac-sheet-card\" role=\"dialog\" aria-label=\"" + esc(tr("Send")) + "\">" +
      "<h3>" + esc(tr("Send")) + "</h3>" +
      "<p class=\"ac-note\" data-vs-status>" + esc(view.status || "") + "</p>" +
      "<input class=\"ac-search\" data-vs=\"q\" placeholder=\"" + esc(tr("Direct")) + "\" value=\"" + esc(view.query) + "\">" +
      "<div data-vs-list>" + rows + "</div>" +
      "<button type=\"button\" class=\"ac-btn\" data-vs=\"forward\">" + esc(tr("Anyone else")) + "</button>" +
      "<button type=\"button\" class=\"ac-btn\" data-vs=\"invite\">" + esc(tr("Invite to bot")) + "</button>" +
      me +
      "<button type=\"button\" class=\"ac-btn\" data-vs=\"close\">" + esc(tr("Cancel")) + "</button>" +
      "</div></div>";
  }

  function chatRows() {
    return (view.chats || []).filter(function (chat) {
      if (chat.unavailable) return false;
      var q = view.query.toLowerCase();
      if (!q) return true;
      return (chat.name + " " + chat.username).toLowerCase().indexOf(q) >= 0;
    }).map(function (chat) {
      return "<button type=\"button\" class=\"ac-row\" data-vs=\"direct\" data-id=\"" + esc(chat.id) + "\"><b>" + esc(chat.name || chat.username || tr("Direct")) + "</b></button>";
    }).join("");
  }

  function paint() {
    var old = document.querySelector("[data-voice-sheet]");
    if (old) old.remove();
    if (!view.open) return;
    var holder = document.createElement("div");
    holder.innerHTML = sheet();
    document.body.appendChild(holder.firstElementChild);
  }

  function authHeaders() {
    return { Authorization: "Bearer " + token() };
  }

  function setStatus(text) {
    view.status = text;
    var node = document.querySelector("[data-vs-status]");
    if (node) node.textContent = text;
    else paint();
  }

  function sendBot(chatId) {
    var base = apiBase();
    if (!base || !token()) {
      setStatus(tr("The voice bot is not configured yet."));
      return;
    }
    setStatus(tr("Sending"));
    var body = new FormData();
    body.set("chat_id", chatId);
    body.set("file", view.blob, "voice.ogg");
    body.set("caption", view.transcript || "");
    fetch(base + "/tg/voice", { method: "POST", headers: authHeaders(), body: body }).then(function (res) {
      return res.json().then(function (payload) { return { ok: res.ok, status: res.status, payload: payload }; });
    }).then(function (out) {
      if (out.ok && out.payload && out.payload.forward) {
        var bot = out.payload.bot || view.bot;
        setStatus(tr("Delivered"));
        var link = document.createElement("a");
        link.href = "tg://resolve?domain=" + bot;
        link.textContent = tr("Open in Telegram to forward");
        var card = document.querySelector(".ac-sheet-card");
        if (card) {
          card.appendChild(link);
          var hint = document.createElement("p");
          hint.className = "ac-note";
          hint.textContent = tr("Hide sender name");
          card.appendChild(hint);
        }
        return;
      }
      if (!out.ok) throw new Error((out.payload && out.payload.error) || "send");
      remember({ id: chatId, name: chatId });
      setStatus(tr("Delivered"));
    }).catch(function () {
      setStatus(tr("Retry"));
    });
  }

  function bind(node) {
    node.addEventListener("click", function (event) {
      var button = event.target.closest("[data-vs]");
      if (!button) return;
      var act = button.getAttribute("data-vs");
      if (act === "close") { view.open = false; paint(); }
      if (act === "direct") sendBot(button.getAttribute("data-id") || "");
      if (act === "forward") sendBot("owner");
      if (act === "invite") {
        fetch(apiBase() + "/v1/owner/telegram-voice/invite", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
          body: JSON.stringify({ label: "" })
        }).then(function (res) { return res.json(); }).then(function (body) {
          setStatus(body && body.url ? body.url : tr("The voice bot is not configured yet."));
        }).catch(function () { setStatus(tr("Retry")); });
      }
      if (act === "me" && root.ViktorychTgAccount) {
        setStatus(tr("Sending"));
        root.ViktorychTgAccount.send(view.blob, view.transcript).then(function () {
          setStatus(tr("Delivered"));
        }).catch(function (err) {
          setStatus(err && err.code === "flood" ? tr("Retry") : tr("Retry"));
        });
      }
    });
    node.addEventListener("input", function (event) {
      if (event.target.getAttribute("data-vs") !== "q") return;
      view.query = event.target.value || "";
      var list = node.querySelector("[data-vs-list]");
      if (list) list.innerHTML = chatRows();
    });
  }

  function open(blob, transcript) {
    view.open = true;
    view.blob = blob;
    view.transcript = transcript || "";
    view.status = tr("Converting");
    paint();
    var node = document.querySelector("[data-voice-sheet]");
    if (node && node.dataset.bound !== "1") {
      node.dataset.bound = "1";
      bind(node);
    }
    var base = apiBase();
    if (!base || !token()) {
      setStatus(tr("The voice bot is not configured yet."));
      return;
    }
    fetch(base + "/v1/owner/telegram-voice", { headers: authHeaders() }).then(function (res) { return res.ok ? res.json() : { configured: false }; }).then(function (body) {
      view.bot = body && body.bot || "";
      if (!body || !body.configured) {
        setStatus(tr("The voice bot is not configured yet."));
        return null;
      }
      return fetch(base + "/v1/owner/telegram-voice/chats", { headers: authHeaders() }).then(function (res) { return res.json(); });
    }).then(function (body) {
      if (!body) return;
      view.chats = body.chats || [];
      view.status = "";
      paint();
      var again = document.querySelector("[data-voice-sheet]");
      if (again) bind(again);
    }).catch(function () { setStatus(tr("Retry")); });
  }

  root.ViktorychVoiceSheet = { open: open, sheet: sheet };
})(typeof globalThis !== "undefined" ? globalThis : this);
