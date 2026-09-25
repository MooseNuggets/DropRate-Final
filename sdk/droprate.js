/* DropRate Game SDK — browser client. v1
 *
 *   <script src="https://droprate.xyz/sdk/droprate.js"></script>
 *   const dr = await DropRate.ready();
 *   await dr.achievements.unlock("first_blood");
 *
 * Works in three places with no code change:
 *   • inside the DropRate web player  — the ticket arrives over postMessage
 *   • inside the DropRate desktop app — a native build reads DROPRATE_TICKET
 *     from its environment (see the C#/GDScript samples); web builds launched
 *     by the app also get postMessage
 *   • standalone / your own site      — pass {ticket, api} to ready() yourself,
 *     or the player is a guest and every call resolves {guest:true}
 *
 * Guests never throw: unlock/save/submit quietly no-op so your game logic can
 * stay the same whether the player signed in or not. Check dr.guest if you
 * want to show a "sign in to save progress" prompt — dr.requestSignIn() asks
 * the player page to open the wallet.
 */
(function (root) {
  "use strict";
  const VERSION = "1.0.0";
  const DEFAULT_API = "https://droprate.xyz/sdk/v1";

  function b64(bytes) {
    if (typeof bytes === "string") return btoa(unescape(encodeURIComponent(bytes)));
    let s = ""; const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function unb64(str, asText) {
    const bin = atob(str); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return asText ? decodeURIComponent(escape(bin)) : u;
  }

  class Client {
    constructor(opts) {
      this.api = (opts.api || DEFAULT_API).replace(/\/+$/, "");
      this.ticket = opts.ticket || null;
      this.wallet = opts.wallet || null;
      this.productId = opts.product_id || null;
      this.guest = !this.ticket;
      this._listeners = {};
      const self = this;
      this.achievements = {
        list: () => self._call("ach-list"),
        unlock: (key) => self._call("ach-unlock", { key }),
      };
      this.saves = {
        list: () => self._call("save-list"),
        /* data: string | object (JSON) | Uint8Array. version: pass what you last
           read to avoid overwriting a newer save from another device. */
        put: (slot, data, opts) => {
          let payload;
          if (data instanceof Uint8Array || data instanceof ArrayBuffer) payload = b64(data);
          else if (typeof data === "string") payload = b64(data);
          else payload = b64(JSON.stringify(data));
          return self._call("save-put", Object.assign({ slot: slot || "default", data: payload }, opts || {}));
        },
        get: async (slot, as) => {
          const r = await self._call("save-get", { slot: slot || "default" });
          if (!r || !r.exists) return r;
          if (as === "bytes") r.value = unb64(r.data, false);
          else if (as === "text") r.value = unb64(r.data, true);
          else { const t = unb64(r.data, true); try { r.value = JSON.parse(t); } catch { r.value = t; } }
          return r;
        },
        delete: (slot) => self._call("save-delete", { slot: slot || "default" }),
      };
      this.leaderboards = {
        list: () => self._call("board-list", { product_id: self.productId }),
        submit: (board, score, meta) => self._call("score-submit", { board, score, meta }),
        top: (board, limit) => self._call("score-top", { board, limit: limit || 25, product_id: self.productId }),
      };
    }
    on(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); return this; }
    _emit(evt, data) { (this._listeners[evt] || []).forEach((f) => { try { f(data); } catch {} }); }
    async whoami() { return this._call("whoami"); }
    requestSignIn() {
      // Ask the DropRate player page (our parent) to open the wallet prompt.
      try { if (root.parent && root.parent !== root) root.parent.postMessage({ type: "droprate:signin" }, "*"); } catch {}
    }
    async _call(action, body) {
      // Reads that don't need a ticket still work for guests (top scores, board list).
      const readOnly = action === "score-top" || action === "board-list";
      if (this.guest && !readOnly) return { ok: false, guest: true };
      const headers = { "Content-Type": "application/json" };
      if (this.ticket) headers.Authorization = "Bearer " + this.ticket;
      let r, j;
      try {
        r = await fetch(this.api + "/" + action, { method: "POST", headers, body: JSON.stringify(body || {}) });
        j = await r.json();
      } catch (e) { return { ok: false, error: "network: " + (e && e.message || e) }; }
      if (r.status === 401 && j && /expired/i.test(j.error || "")) { this._emit("expired", j); }
      if (action === "ach-unlock" && j && j.new) this._emit("unlock", j.achievement);
      return j;
    }
  }

  let readyPromise = null;
  function ready(opts) {
    if (readyPromise) return readyPromise;
    opts = opts || {};
    readyPromise = new Promise((resolve) => {
      // 1. explicit
      if (opts.ticket) return resolve(new Client(opts));
      // 2. Node/Electron-ish: environment (a web build run through a wrapper)
      try {
        if (typeof process !== "undefined" && process.env && process.env.DROPRATE_TICKET) {
          return resolve(new Client({ ticket: process.env.DROPRATE_TICKET, api: process.env.DROPRATE_API, wallet: process.env.DROPRATE_WALLET, product_id: Number(process.env.DROPRATE_PRODUCT) }));
        }
      } catch {}
      // 3. inside the DropRate player: ask the parent, wait briefly
      const inFrame = root.parent && root.parent !== root;
      if (!inFrame) return resolve(new Client({ api: opts.api }));
      let done = false;
      const finish = (c) => { if (done) return; done = true; root.removeEventListener("message", onMsg); resolve(c); };
      function onMsg(e) {
        const d = e.data || {};
        if (d.type !== "droprate:ticket") return;
        const c = new Client({ ticket: d.guest ? null : d.ticket, api: d.api, wallet: d.wallet, product_id: d.product_id });
        if (done) { // a later sign-in upgrades the guest client in place
          const cur = current; if (cur && d.ticket) { cur.ticket = d.ticket; cur.wallet = d.wallet; cur.guest = false; cur._emit("signin", { wallet: d.wallet }); }
          return;
        }
        current = c; finish(c);
      }
      root.addEventListener("message", onMsg);
      try { root.parent.postMessage({ type: "droprate:hello", sdk: VERSION }, "*"); } catch {}
      setTimeout(() => { if (!done) { current = new Client({ api: opts.api }); // keep listening for a late sign-in
        done = true; resolve(current); } }, opts.timeout || 2500);
    });
    return readyPromise;
  }
  let current = null;

  root.DropRate = { ready, version: VERSION, Client };
})(typeof window !== "undefined" ? window : globalThis);
