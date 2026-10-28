// Una stanza tematica = un Durable Object. Nessun messaggio viene conservato:
// chi entra vede solo ciò che viene scritto dopo il suo ingresso.
import { DurableObject } from "cloudflare:workers";
import { messaggioBloccato, paroleVietate, valutaBan } from "./lib.js";

const MAX_MSG = 500;

export class Stanza extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }

  aperti() { return this.ctx.getWebSockets().filter((w) => w.readyState === 1); }
  st(w) { return w.deserializeAttachment() || {}; }
  inv(w, o) { try { w.send(JSON.stringify(o)); } catch {} }
  tutti(o, tranne) {
    const m = JSON.stringify(o);
    this.aperti().forEach((w) => { if (w !== tranne) { try { w.send(m); } catch {} } });
  }
  membri(lista = this.aperti()) {
    const mappa = new Map();
    for (const w of lista) { const s = this.st(w); mappa.set(s.u, { id: s.u, nome: s.n, av: s.a, r: s.r }); }
    return [...mappa.values()];
  }
  async aggiornaOnline(sid, lista) {
    if (!sid) return;
    try { await this.env.DB.prepare("UPDATE stanze SET online = ? WHERE id = ?").bind(this.membri(lista).length, sid).run(); } catch (e) { console.error(e); }
  }
  limite(ws) {
    const s = this.st(ws), now = Math.floor(Date.now() / 1000);
    let { rw, rn } = s;
    if (now - rw >= 5) { rw = now; rn = 0; }
    rn++;
    ws.serializeAttachment({ ...s, rw, rn });
    if (rn > 6) { this.inv(ws, { t: "lento" }); return true; }
    return false;
  }

  async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("Atteso WebSocket", { status: 426 });
    const info = JSON.parse(decodeURIComponent(req.headers.get("x-info")));
    const { 0: client, 1: server } = new WebSocketPair();
    const prima = this.aperti();
    this.ctx.acceptWebSocket(server);
    // una sola sessione per utente: la precedente viene chiusa
    for (const w of prima) {
      if (this.st(w).u === info.u) { this.inv(w, { t: "rifiutato", x: "Sei entrato da un altro dispositivo o scheda." }); try { w.close(1000, "altra sessione"); } catch {} }
    }
    const altri = prima.filter((w) => this.st(w).u !== info.u);
    if (altri.length >= info.max) {
      this.inv(server, { t: "rifiutato", x: "La stanza è piena." });
      try { server.close(1000, "piena"); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }
    const { stanza, ...base } = info;
    server.serializeAttachment({ ...base, rw: 0, rn: 0 });
    this.inv(server, { t: "benvenuto", ruolo: info.r, io: info.u, info: stanza, membri: this.membri() });
    if (!prima.some((w) => this.st(w).u === info.u)) this.tutti({ t: "entra", m: { id: info.u, nome: info.n, av: info.a, r: info.r } }, server);
    await this.aggiornaOnline(info.sid);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const s = this.st(ws);
    if (!s.u) return;
    try {
      switch (m.t) {
        case "msg": {
          const x = String(m.x || "").trim().slice(0, MAX_MSG);
          if (!x || this.limite(ws)) break;
          const blocco = messaggioBloccato(x, await paroleVietate(this.env));
          if (blocco) { this.inv(ws, { t: "bloccato", motivo: blocco }); break; }
          this.tutti({ t: "msg", da: { id: s.u, nome: s.n, av: s.a, r: s.r }, x });
          break;
        }
        case "espelli": {
          const id = String(m.id || "");
          if (s.r !== "o" || !/^[a-f0-9]{16}$/.test(id) || id === s.u) break;
          const bersagli = this.aperti().filter((w) => this.st(w).u === id);
          const nome = bersagli.length ? this.st(bersagli[0]).n : "L’utente";
          await this.env.DB.prepare("INSERT OR IGNORE INTO stanze_ban (stanza, utente) VALUES (?, ?)").bind(s.sid, id).run();
          bersagli.forEach((w) => { this.inv(w, { t: "espulso" }); try { w.close(1000, "espulso"); } catch {} });
          this.tutti({ t: "sistema", x: nome + " è stato espulso dalla stanza." });
          break;
        }
        case "segnala": {
          const id = String(m.id || "");
          if (!/^[a-f0-9]{16}$/.test(id) || id === s.u) break;
          const bersagli = this.aperti().filter((w) => this.st(w).u === id);
          if (!bersagli.length) break;
          await this.env.DB.prepare("INSERT INTO segnalazioni (segnalato, segnalante, tipo) VALUES (?, ?, 'utente')").bind("u_" + id, "u_" + s.u).run();
          const ban = await valutaBan(this.env, "u_" + id);
          this.inv(ws, { t: "segnalato" });
          const nome = this.st(bersagli[0]).n;
          this.aperti().filter((w) => this.st(w).r === "o").forEach((w) => this.inv(w, { t: "sistema", x: s.n + " ha segnalato " + nome + "." }));
          if (ban) bersagli.forEach((w) => { this.inv(w, { t: "banned", fino: ban.permanente ? null : ban.scade_il, permanente: !!ban.permanente }); try { w.close(1000, "ban"); } catch {} });
          break;
        }
        case "modifica": {
          if (s.r !== "o") break;
          const descrizione = String(m.descrizione || "").trim().slice(0, 200);
          const regole = String(m.regole || "").trim().slice(0, 1000);
          if (regole.length < 10) { this.inv(ws, { t: "errore", x: "Scrivi le regole della stanza (almeno 10 caratteri)." }); break; }
          const parole = await paroleVietate(this.env);
          if (messaggioBloccato(descrizione, parole) || messaggioBloccato(regole, parole)) { this.inv(ws, { t: "errore", x: "Il testo contiene link, contatti o parole non consentite." }); break; }
          await this.env.DB.prepare("UPDATE stanze SET descrizione = ?, regole = ? WHERE id = ? AND proprietario = ?").bind(descrizione, regole, s.sid, s.u).run();
          this.tutti({ t: "info", descrizione, regole });
          this.tutti({ t: "sistema", x: "Le regole della stanza sono state aggiornate." });
          break;
        }
        case "elimina": {
          if (s.r !== "o") break;
          await this.env.DB.prepare("UPDATE stanze SET stato = 'eliminata', online = 0 WHERE id = ? AND proprietario = ?").bind(s.sid, s.u).run();
          this.tutti({ t: "eliminata" });
          this.aperti().forEach((w) => { try { w.close(1000, "eliminata"); } catch {} });
          break;
        }
      }
    } catch (e) {
      console.error(e);
      this.inv(ws, { t: "errore", x: "Si è verificato un errore. Riprova." });
    }
  }

  async uscito(ws) {
    const s = this.st(ws);
    const restano = this.aperti().filter((w) => w !== ws);
    if (s.u && !restano.some((w) => this.st(w).u === s.u)) this.tutti({ t: "esce", id: s.u }, ws);
    await this.aggiornaOnline(s.sid, restano);
  }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    await this.uscito(ws);
  }
  async webSocketError(ws) { await this.uscito(ws); }
}
