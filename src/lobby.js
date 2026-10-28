// Server delle chat in tempo reale: abbinamento, messaggi, video (segnalazione), presenze.
// Tutto lo stato di ogni connessione sta nell'"attachment" del WebSocket, così regge anche
// quando il Durable Object va in ibernazione.
import { DurableObject } from "cloudflare:workers";
import { TAGS, banAttivo, valutaBan, normalizza, messaggioBloccato, sha256 } from "./lib.js";

const PERIODO = 15000; // ogni 15 s: statistiche + abbinamenti di riserva
const MAX_MSG = 500;

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.parole = null;
    this.paroleTs = 0;
  }

  async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("Atteso WebSocket", { status: 426 });
    const info = JSON.parse(decodeURIComponent(req.headers.get("x-info")));
    const { 0: client, 1: server } = new WebSocketPair();
    const c = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server, [c]);
    server.serializeAttachment({ c, ...info, st: "i", int: [], mode: "t", peer: null, last: null, m: 0, rw: 0, rn: 0, since: 0 });
    server.send(JSON.stringify({ t: "hello", ...this.stats() }));
    await this.programma();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- utilità ----
  aperti() { return this.ctx.getWebSockets().filter((w) => w.readyState === 1); }
  stato(w) { return w.deserializeAttachment() || {}; }
  agg(w, patch) { const s = { ...this.stato(w), ...patch }; w.serializeAttachment(s); return s; }
  invia(w, o) { try { w.send(JSON.stringify(o)); } catch {} }
  peerDi(ws) {
    const s = this.stato(ws);
    const p = s.peer ? this.ctx.getWebSockets(s.peer)[0] : null;
    return p && p.readyState === 1 ? p : null;
  }
  stats(ws = this.aperti()) {
    const interessi = TAGS.map(() => 0);
    ws.forEach((w) => (this.stato(w).int || []).forEach((i) => interessi[i]++));
    return { online: ws.length, interessi };
  }
  async programma() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + PERIODO);
  }
  async alarm() {
    const ws = this.aperti();
    if (!ws.length) return;
    this.abbinaInAttesa(ws);
    const m = JSON.stringify({ t: "stats", ...this.stats(ws) });
    ws.forEach((w) => { try { w.send(m); } catch {} });
    await this.ctx.storage.setAlarm(Date.now() + PERIODO);
  }
  async caricaParole() {
    if (!this.parole || Date.now() - this.paroleTs > 300000) {
      const { results } = await this.env.DB.prepare("SELECT parola FROM parole_vietate").all();
      this.parole = new Set(results.map((r) => normalizza(r.parola)));
      this.paroleTs = Date.now();
    }
    return this.parole;
  }
  limite(ws) {
    const s = this.stato(ws);
    const now = Math.floor(Date.now() / 1000);
    let { rw, rn } = s;
    if (now - rw >= 5) { rw = now; rn = 0; }
    rn++;
    this.agg(ws, { rw, rn });
    if (rn > 6) { this.invia(ws, { t: "lento" }); return true; }
    return false;
  }

  // ---- abbinamento ----
  compatibili(a, b) {
    return b.st === "q" && b.mode === a.mode && b.u !== a.u && b.u !== a.last && a.u !== b.last;
  }
  prova(ws) {
    const me = this.stato(ws);
    let best = null, bs = -1;
    for (const w of this.aperti()) {
      if (w === ws) continue;
      const s = this.stato(w);
      if (!this.compatibili(me, s)) continue;
      const ov = s.int.filter((i) => me.int.includes(i)).length;
      if (!ov && me.int.length && s.int.length) continue; // entrambi con interessi ma nessuno in comune: aspetta
      const score = ov * 1e9 + (Date.now() - s.since);
      if (score > bs) { best = w; bs = score; }
    }
    if (best) this.unisci(best, ws);
  }
  abbinaInAttesa(ws) {
    const att = ws.filter((w) => { const s = this.stato(w); return s.st === "q" && Date.now() - s.since > 12000; })
      .sort((x, y) => this.stato(x).since - this.stato(y).since);
    for (const a of att) {
      if (this.stato(a).st !== "q") continue;
      for (const b of att) {
        if (a === b || !this.compatibili(this.stato(a), this.stato(b))) continue;
        this.unisci(a, b);
        break;
      }
    }
  }
  unisci(a, b) {
    const sa = this.stato(a), sb = this.stato(b);
    this.agg(a, { st: "c", peer: sb.c, m: 0 });
    this.agg(b, { st: "c", peer: sa.c, m: 0 });
    const comuni = sa.int.filter((i) => sb.int.includes(i)).map((i) => TAGS[i]);
    const prof = (s) => ({
      nome: s.p ? s.n : "Sconosciuto", premium: !!s.p,
      eta: s.p ? s.e : null, sesso: s.p ? s.s : null,
      avatar: s.p && s.a ? "/api/avatar/" + s.u.slice(2) : null, id: s.p ? s.u.slice(2) : null,
    });
    this.invia(a, { t: "match", ruolo: "caller", mode: sa.mode, partner: prof(sb), comuni });
    this.invia(b, { t: "match", ruolo: "callee", mode: sb.mode, partner: prof(sa), comuni });
  }
  chiudi(ws) {
    try {
      const s = this.stato(ws);
      const p = s.st === "c" ? this.peerDi(ws) : null;
      if (p) {
        this.agg(p, { st: "i", peer: null, last: s.u, m: 0 });
        this.invia(p, { t: "peer_left" });
      }
      this.agg(ws, { st: "i", peer: null, last: p ? this.stato(p).u : s.last, m: 0 });
    } catch {}
  }

  // ---- messaggi dal browser ----
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 12000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const s = this.stato(ws);
    try {
      switch (m.t) {
        case "interessi": {
          const int = [...new Set((m.int || []).filter((i) => Number.isInteger(i) && i >= 0 && i < TAGS.length))];
          this.agg(ws, { int });
          break;
        }
        case "join": {
          if (s.st === "c") this.chiudi(ws);
          const ban = await banAttivo(this.env, s.u);
          if (ban) { this.invia(ws, { t: "banned", fino: ban.permanente ? null : ban.scade_il, motivo: ban.motivo, permanente: !!ban.permanente }); break; }
          const mode = m.mode === "v" ? "v" : "t";
          if (mode === "v" && !s.p) { this.invia(ws, { t: "errore", x: "La video chat è riservata agli utenti Premium." }); break; }
          this.agg(ws, { st: "q", mode, since: Date.now(), peer: null, m: 0 });
          this.invia(ws, { t: "cerco" });
          this.prova(ws);
          break;
        }
        case "skip":
        case "esci":
          this.chiudi(ws);
          this.invia(ws, { t: "chiuso" });
          break;
        case "msg": {
          const p = this.peerDi(ws);
          const x = String(m.x || "").trim().slice(0, MAX_MSG);
          if (s.st !== "c" || !p || !x || this.limite(ws)) break;
          const blocco = messaggioBloccato(x, await this.caricaParole());
          if (blocco) { this.invia(ws, { t: "bloccato", motivo: blocco }); break; }
          this.invia(p, { t: "msg", x });
          const ps = this.stato(p);
          if (s.m && ps.m && s.p && ps.p) {
            await this.env.DB.prepare("INSERT INTO dm (da, a, testo) VALUES (?, ?, ?)").bind(s.u.slice(2), ps.u.slice(2), x).run();
          }
          break;
        }
        case "sdp":
        case "ice": {
          const p = this.peerDi(ws);
          if (p && s.mode === "v") this.invia(p, { t: m.t, d: m.d });
          break;
        }
        case "report": {
          const p = this.peerDi(ws);
          if (s.st !== "c" || !p) break;
          const ps = this.stato(p);
          await this.env.DB.prepare("INSERT INTO segnalazioni (segnalato, segnalante, tipo) VALUES (?, ?, 'utente')").bind(ps.u, s.u).run();
          const ban = await valutaBan(this.env, ps.u);
          this.invia(ws, { t: "segnalato" });
          if (ban) {
            this.invia(p, { t: "banned", fino: ban.permanente ? null : ban.scade_il, motivo: ban.motivo, permanente: !!ban.permanente });
            this.chiudi(ws);
            this.invia(ws, { t: "peer_left" });
          }
          break;
        }
        case "salva": {
          const p = this.peerDi(ws);
          if (s.st !== "c" || !p) break;
          const ps = this.stato(p);
          if (!s.p || !ps.p) { this.invia(ws, { t: "errore", x: "Puoi salvare solo contatti con account Premium." }); break; }
          await this.env.DB.prepare("INSERT OR IGNORE INTO contatti (utente, contatto) VALUES (?, ?)").bind(s.u.slice(2), ps.u.slice(2)).run();
          const inverso = await this.env.DB.prepare("SELECT 1 AS ok FROM contatti WHERE utente=? AND contatto=?").bind(ps.u.slice(2), s.u.slice(2)).first();
          if (inverso) {
            this.agg(ws, { m: 1 }); this.agg(p, { m: 1 });
            this.invia(ws, { t: "salvato", mutuo: true }); this.invia(p, { t: "salvato", mutuo: true });
          } else {
            this.invia(ws, { t: "salvato", mutuo: false });
            this.invia(p, { t: "richiesta_salva", nome: s.n });
          }
          break;
        }
        case "foto": {
          const p = this.peerDi(ws);
          if (s.st !== "c" || !p || typeof m.tok !== "string") break;
          const r = await this.env.DB.prepare("UPDATE foto SET destinatario=? WHERE token_hash=? AND mittente=? AND destinatario=''")
            .bind(this.stato(p).u, await sha256(m.tok), s.u).run();
          if (r.meta.changes === 1) { this.invia(p, { t: "foto", tok: m.tok }); this.invia(ws, { t: "foto_ok" }); }
          break;
        }
        case "dm": {
          const a = String(m.a || "");
          const x = String(m.x || "").trim().slice(0, MAX_MSG);
          if (!s.p || !/^[a-f0-9]{16}$/.test(a) || !x || this.limite(ws)) break;
          const ok = await this.env.DB.prepare(
            "SELECT (SELECT 1 FROM contatti WHERE utente=?1 AND contatto=?2) AND (SELECT 1 FROM contatti WHERE utente=?2 AND contatto=?1) AS ok"
          ).bind(s.u.slice(2), a).first();
          if (!ok || !ok.ok) { this.invia(ws, { t: "errore", x: "Per scrivervi servono il salvataggio reciproco." }); break; }
          const blocco = messaggioBloccato(x, await this.caricaParole());
          if (blocco) { this.invia(ws, { t: "bloccato", motivo: blocco }); break; }
          await this.env.DB.prepare("INSERT INTO dm (da, a, testo) VALUES (?, ?, ?)").bind(s.u.slice(2), a, x).run();
          for (const w of this.aperti()) if (this.stato(w).u === "u_" + a) this.invia(w, { t: "dm", da: s.u.slice(2), nome: s.n, x });
          this.invia(ws, { t: "dm_ok" });
          break;
        }
      }
    } catch (e) {
      console.error(e);
      this.invia(ws, { t: "errore", x: "Si è verificato un errore. Riprova." });
    }
  }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    this.chiudi(ws);
  }
  async webSocketError(ws) {
    this.chiudi(ws);
  }
}
