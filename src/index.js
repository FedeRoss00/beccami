// Beccami: Worker principale (API, autenticazione, foto, abbonamenti).
import { Lobby } from "./lobby.js";
import { Stanza } from "./stanza.js";
import * as L from "./lib.js";
export { Lobby, Stanza };

const MAX_FOTO = 2 * 1024 * 1024;
const MSG_FOTO = "Le foto non sono disponibili al momento: il servizio foto non è ancora attivo o non risponde. Riprova più tardi.";
const MSG_PAGAMENTI = "I pagamenti non sono ancora attivi.";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/") && p !== "/ws" && p !== "/ws-stanza") return env.ASSETS.fetch(req);
    try {
      return await instrada(req, env, url, p);
    } catch (e) {
      console.error(e);
      return L.json({ errore: "Errore interno. Riprova tra poco." }, 500);
    }
  },
};

const corpo = async (req) => {
  try {
    if (Number(req.headers.get("content-length") || 0) > 100000) return {};
    return await req.json();
  } catch {
    return {};
  }
};
const prezzoDi = (env, piano) => (piano === "contributore" ? env.STRIPE_PRICE_CONTRIBUTORE : env.STRIPE_PRICE_PREMIUM);
const pagamentiAttivi = (env, piano = "premium") => !!(env.STRIPE_SECRET_KEY && prezzoDi(env, piano));
const contributoreAttivo = (id) => !!(id.premium && id.utente && id.utente.piano === "contributore");
const MAX_STANZE = 3;

// Chi sta facendo la richiesta: ospite (cookie "sid") o utente registrato (cookie "sess").
async function chi(req, env) {
  const set = [];
  let sid = L.leggiCookie(req, "sid");
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) {
    sid = L.rnd(16);
    set.push(L.cookie("sid", sid, 31536000));
  }
  let utente = null;
  const tok = L.leggiCookie(req, "sess");
  if (tok && /^[a-f0-9]{64}$/.test(tok)) {
    utente = await env.DB.prepare(
      "SELECT u.* FROM sessioni s JOIN utenti u ON u.id = s.utente WHERE s.token_hash = ? AND s.scade_il > datetime('now')"
    ).bind(await L.sha256(tok)).first();
  }
  const premium = !!(utente && utente.premium_fino && utente.premium_fino > L.ora());
  return { uid: utente ? "u_" + utente.id : "g_" + sid, utente, premium, set };
}

async function nuovaSessione(env, utenteId) {
  const tok = L.rnd(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessioni WHERE scade_il < datetime('now')"),
    env.DB.prepare("INSERT INTO sessioni (token_hash, utente, scade_il) VALUES (?, ?, ?)").bind(await L.sha256(tok), utenteId, L.ora(30 * 86400)),
  ]);
  return L.cookie("sess", tok, 30 * 86400);
}

async function checkoutPiano(env, utente, piano, origin) {
  const par = {
    mode: "subscription",
    "line_items[0][price]": prezzoDi(env, piano),
    "line_items[0][quantity]": "1",
    success_url: origin + "/?pagamento=ok",
    cancel_url: origin + "/?pagamento=annullato",
    client_reference_id: utente.id,
    "metadata[piano]": piano,
    "subscription_data[metadata][piano]": piano,
    locale: "it",
  };
  if (utente.stripe_cliente) par.customer = utente.stripe_cliente;
  else par.customer_email = utente.email;
  return (await L.stripe(env, "/checkout/sessions", par)).url;
}

async function instrada(req, env, url, p) {
  const m = req.method;
  const origin = url.origin;

  if (p === "/api/stripe/webhook" && m === "POST") return webhookStripe(req, env);
  if (p.startsWith("/api/admin/")) return admin(req, env, p, m);
  if (p === "/api/config") {
    return L.json({
      tags: L.TAGS,
      prova: env.MODALITA_PROVA === "1",
      pagamenti: pagamentiAttivi(env),
      foto: !!(env.N8N_URL && env.WORKER_SECRET),
      prezzo: 5,
      contributore: { attivo: pagamentiAttivi(env, "contributore"), prezzo: 8 },
      sblocco: 15,
    });
  }

  const id = await chi(req, env);
  const ok = (d, s = 200) => L.json(d, s, id.set);
  const richiediLogin = () => (id.utente ? null : ok({ errore: "Devi accedere." }, 401));
  const richiediPremium = () => (id.premium ? null : ok({ errore: "Serve un abbonamento Premium attivo." }, 403));
  const rotta = m + " " + p;

  // ---------- Account ----------
  if (rotta === "GET /api/io") {
    const u = id.utente;
    const ban = await L.banAttivo(env, id.uid);
    return ok({
      registrato: !!u, id: u?.id || null, nome: u?.nome || null, eta: u?.eta || null, sesso: u?.sesso || null,
      avatar: u?.avatar ? "/api/avatar/" + u.id : null,
      premium: id.premium, premium_fino: u?.premium_fino || null, piano: u?.piano || null, contributore: contributoreAttivo(id),
      ban: ban ? { fino: ban.permanente ? null : ban.scade_il, motivo: ban.motivo, permanente: !!ban.permanente } : null,
    });
  }

  if (rotta === "POST /api/registrati") {
    const b = await corpo(req);
    const nome = String(b.nome || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    const eta = parseInt(b.eta, 10);
    const piano = b.piano === "contributore" ? "contributore" : "premium";
    if (b.accetto !== true) return ok({ errore: "Devi confermare di avere almeno 18 anni e di accettare i Termini." }, 400);
    if (!/^[\p{L}][\p{L} '’-]{1,23}$/u.test(nome)) return ok({ errore: "Il nome deve avere da 2 a 24 lettere." }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return ok({ errore: "Email non valida." }, 400);
    if (password.length < 8 || password.length > 100) return ok({ errore: "La password deve avere almeno 8 caratteri." }, 400);
    if (!(eta >= 18 && eta <= 99)) return ok({ errore: "Devi essere maggiorenne (18-99 anni)." }, 400);
    if (!["Donna", "Uomo", "Altro"].includes(b.sesso)) return ok({ errore: "Seleziona il sesso." }, 400);
    let avatar = null;
    if (b.avatar) {
      const mm = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.avatar));
      if (!mm || mm[1].length > 45000) return ok({ errore: "Immagine profilo non valida." }, 400);
      avatar = mm[1];
    }
    if (await env.DB.prepare("SELECT 1 AS x FROM utenti WHERE email = ?").bind(email).first()) {
      return ok({ errore: "Esiste già un account con questa email." }, 409);
    }
    const uid = L.rnd(8);
    await env.DB.prepare("INSERT INTO utenti (id, email, password, nome, eta, sesso, avatar, piano) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uid, email, await L.hashPassword(password), nome, eta, b.sesso, avatar, piano).run();
    const set = [...id.set, await nuovaSessione(env, uid)];
    const utente = { id: uid, email, stripe_cliente: null };
    if (env.MODALITA_PROVA === "1") {
      await env.DB.prepare("UPDATE utenti SET premium_fino = ? WHERE id = ?").bind(L.ora(30 * 86400), uid).run();
      return L.json({ ok: true, prova: true }, 200, set);
    }
    if (pagamentiAttivi(env, piano)) {
      try {
        return L.json({ ok: true, checkout: await checkoutPiano(env, utente, piano, origin) }, 200, set);
      } catch (e) {
        console.error(e);
      }
    }
    return L.json({ ok: true, avviso: "Account creato. " + MSG_PAGAMENTI + " L’abbonamento si potrà attivare più avanti." }, 200, set);
  }

  if (rotta === "POST /api/accedi") {
    const b = await corpo(req);
    const u = await env.DB.prepare("SELECT id, password FROM utenti WHERE email = ?").bind(String(b.email || "").trim().toLowerCase()).first();
    const valida = u && (await L.verificaPassword(String(b.password || ""), u.password));
    if (!valida) return ok({ errore: "Email o password non corretti." }, 401);
    return L.json({ ok: true }, 200, [...id.set, await nuovaSessione(env, u.id)]);
  }

  if (rotta === "POST /api/esci") {
    const tok = L.leggiCookie(req, "sess");
    if (tok) await env.DB.prepare("DELETE FROM sessioni WHERE token_hash = ?").bind(await L.sha256(tok)).run();
    return L.json({ ok: true }, 200, [...id.set, L.cookie("sess", "", 0)]);
  }

  // ---------- Pagamenti ----------
  if (rotta === "POST /api/checkout") {
    const e = richiediLogin(); if (e) return e;
    const piano = (await corpo(req)).piano === "contributore" ? "contributore" : "premium";
    if (env.MODALITA_PROVA === "1") {
      await env.DB.prepare("UPDATE utenti SET piano = ?, premium_fino = ? WHERE id = ?").bind(piano, L.ora(30 * 86400), id.utente.id).run();
      return ok({ ok: true, prova: true });
    }
    if (!pagamentiAttivi(env, piano)) return ok({ errore: MSG_PAGAMENTI }, 503);
    if (id.premium && id.utente.piano === piano) return ok({ errore: "Hai già questo abbonamento." }, 400);
    try {
      // da Premium a Contributore: si modifica l'abbonamento esistente (con calcolo proporzionale)
      if (id.premium && id.utente.stripe_sub && piano === "contributore") {
        const sub = await L.stripeGet(env, "/subscriptions/" + id.utente.stripe_sub);
        await L.stripe(env, "/subscriptions/" + id.utente.stripe_sub, {
          "items[0][id]": sub.items.data[0].id, "items[0][price]": env.STRIPE_PRICE_CONTRIBUTORE,
          proration_behavior: "create_prorations", "metadata[piano]": "contributore",
        });
        return ok({ ok: true, aggiornato: true });
      }
      return ok({ url: await checkoutPiano(env, id.utente, piano, origin) });
    } catch (er) { console.error(er); return ok({ errore: "Impossibile avviare il pagamento." }, 502); }
  }
  if (rotta === "POST /api/portale") {
    const e = richiediLogin(); if (e) return e;
    if (!env.STRIPE_SECRET_KEY || !id.utente.stripe_cliente) return ok({ errore: "Nessun abbonamento da gestire." }, 400);
    try {
      const s = await L.stripe(env, "/billing_portal/sessions", { customer: id.utente.stripe_cliente, return_url: origin + "/" });
      return ok({ url: s.url });
    } catch (er) { console.error(er); return ok({ errore: "Impossibile aprire la gestione abbonamento." }, 502); }
  }
  if (rotta === "POST /api/sblocco") {
    const ban = await L.banAttivo(env, id.uid);
    if (!ban) return ok({ errore: "Non risulti bannato." }, 400);
    if (ban.permanente) return ok({ errore: "Questo ban non può essere rimosso a pagamento." }, 403);
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_SBLOCCO) return ok({ errore: MSG_PAGAMENTI }, 503);
    try {
      const s = await L.stripe(env, "/checkout/sessions", {
        mode: "payment", "line_items[0][price]": env.STRIPE_PRICE_SBLOCCO, "line_items[0][quantity]": "1",
        "metadata[sblocco]": id.uid, success_url: origin + "/?pagamento=sbloccato", cancel_url: origin + "/", locale: "it",
      });
      return ok({ url: s.url });
    } catch (er) { console.error(er); return ok({ errore: "Impossibile avviare il pagamento." }, 502); }
  }

  // ---------- Video: server ICE/TURN ----------
  if (rotta === "GET /api/ice") {
    const e = richiediPremium(); if (e) return e;
    const stunSolo = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], turn: false };
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return ok(stunSolo);
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { authorization: "Bearer " + env.TURN_API_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 7200 }),
      });
      if (!r.ok) return ok(stunSolo);
      const j = await r.json();
      const iceServers = (j.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !u.includes(":53")) }));
      return ok({ iceServers, turn: true });
    } catch { return ok(stunSolo); }
  }

  // ---------- Chat in tempo reale ----------
  if (p === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") return new Response("Atteso WebSocket", { status: 426 });
    const o = req.headers.get("origin");
    if (o && new URL(o).host !== url.host) return new Response("Origine non consentita", { status: 403 });
    if (!L.leggiCookie(req, "sid")) return new Response("Ricarica la pagina", { status: 400 });
    const u = id.utente;
    const info = { u: id.uid, n: id.premium ? u.nome : "", p: id.premium ? 1 : 0, e: id.premium ? u.eta : 0, s: id.premium ? u.sesso : "", a: id.premium && u.avatar ? 1 : 0 };
    const h = new Headers(req.headers);
    h.set("x-info", encodeURIComponent(JSON.stringify(info)));
    const stub = env.LOBBY.get(env.LOBBY.idFromName("principale"));
    return stub.fetch(new Request(req.url, { method: "GET", headers: h }));
  }

  // ---------- Avatar ----------
  if (m === "GET" && p.startsWith("/api/avatar/")) {
    const uid = p.slice(12);
    if (!/^[a-f0-9]{16}$/.test(uid)) return new Response("Non trovato", { status: 404 });
    const r = await env.DB.prepare("SELECT avatar FROM utenti WHERE id = ? AND premium_fino > datetime('now')").bind(uid).first();
    if (!r || !r.avatar) return new Response("Non trovato", { status: 404 });
    const bin = Uint8Array.from(atob(r.avatar), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" } });
  }

  // ---------- Contatti e messaggi salvati (Premium) ----------
  if (rotta === "GET /api/contatti") {
    const e = richiediPremium(); if (e) return e;
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.nome, u.eta, u.sesso, (u.avatar IS NOT NULL) AS av,
        EXISTS (SELECT 1 FROM contatti x WHERE x.utente = u.id AND x.contatto = ?1) AS mutuo,
        (SELECT testo FROM dm WHERE (da = ?1 AND a = u.id) OR (da = u.id AND a = ?1) ORDER BY id DESC LIMIT 1) AS ultimo
       FROM contatti c JOIN utenti u ON u.id = c.contatto WHERE c.utente = ?1 ORDER BY c.creato_il DESC`
    ).bind(id.utente.id).all();
    return ok({ contatti: results.map((r) => ({ ...r, av: !!r.av, mutuo: !!r.mutuo })) });
  }
  if (rotta === "GET /api/dm") {
    const e = richiediPremium(); if (e) return e;
    const con = url.searchParams.get("con") || "";
    if (!/^[a-f0-9]{16}$/.test(con)) return ok({ errore: "Contatto non valido." }, 400);
    const mio = id.utente.id;
    const mutuo = await env.DB.prepare(
      "SELECT (SELECT 1 FROM contatti WHERE utente=?1 AND contatto=?2) AND (SELECT 1 FROM contatti WHERE utente=?2 AND contatto=?1) AS ok"
    ).bind(mio, con).first();
    if (!mutuo || !mutuo.ok) return ok({ errore: "Serve il salvataggio reciproco." }, 403);
    const { results } = await env.DB.prepare(
      "SELECT da, testo, creato_il FROM dm WHERE (da=?1 AND a=?2) OR (da=?2 AND a=?1) ORDER BY id DESC LIMIT 100"
    ).bind(mio, con).all();
    return ok({ messaggi: results.reverse().map((r) => ({ mio: r.da === mio, x: r.testo, quando: r.creato_il })) });
  }

  // ---------- Foto a visualizzazione singola (archiviate su n8n) ----------
  if (rotta === "POST /api/foto") {
    if (await L.banAttivo(env, id.uid)) return ok({ errore: "Al momento non puoi inviare foto." }, 403);
    if (!env.N8N_URL || !env.WORKER_SECRET) return ok({ errore: MSG_FOTO, servizio: false }, 503);
    const fd = await req.formData();
    const f = fd.get("file");
    if (!f || typeof f === "string" || f.size < 100 || f.size > MAX_FOTO) return ok({ errore: "Foto non valida o troppo grande (massimo 2 MB)." }, 400);
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return ok({ errore: "Sono accettate solo foto JPEG." }, 400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM foto WHERE mittente = ? AND creata_il > datetime('now','-1 hour')").bind(id.uid).first();
    if (n.c >= 10) return ok({ errore: "Hai inviato molte foto: riprova tra un po’." }, 429);
    const fid = L.rnd(16), tok = L.rnd(24);
    const out = new FormData();
    out.append("id", fid);
    out.append("file", new Blob([bytes], { type: "image/jpeg" }), fid + ".jpg");
    let r = null;
    try {
      r = await fetch(env.N8N_URL + "/webhook/foto-carica", { method: "POST", headers: { "x-worker-secret": env.WORKER_SECRET }, body: out, signal: AbortSignal.timeout(10000) });
    } catch {}
    if (!r || !r.ok) return ok({ errore: MSG_FOTO, servizio: false }, 503);
    await env.DB.prepare("INSERT INTO foto (id, token_hash, mittente) VALUES (?, ?, ?)").bind(fid, await L.sha256(tok), id.uid).run();
    return ok({ tok });
  }
  if (rotta === "POST /api/foto/vedi") {
    const tok = String((await corpo(req)).tok || "");
    if (!/^[a-f0-9]{48}$/.test(tok)) return ok({ errore: "Link non valido." }, 400);
    // Operazione unica: solo la prima richiesta del destinatario ottiene la foto.
    const row = await env.DB.prepare(
      "UPDATE foto SET stato='vista', vista_il=datetime('now') WHERE token_hash=? AND destinatario=? AND stato='pronta' RETURNING id"
    ).bind(await L.sha256(tok), id.uid).first();
    if (!row) return ok({ errore: "Questa foto è già stata vista o non è più disponibile." }, 410);
    let r = null;
    try {
      r = await fetch(env.N8N_URL + "/webhook/foto-consegna", {
        method: "POST", headers: { "x-worker-secret": env.WORKER_SECRET, "content-type": "application/json" },
        body: JSON.stringify({ id: row.id }), signal: AbortSignal.timeout(10000),
      });
    } catch {}
    if (!r || !r.ok) {
      await env.DB.prepare("UPDATE foto SET stato='pronta', vista_il=NULL WHERE id=?").bind(row.id).run();
      return ok({ errore: MSG_FOTO, servizio: false }, 503);
    }
    return new Response(r.body, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }
  if (rotta === "POST /api/foto/segnala") {
    const tok = String((await corpo(req)).tok || "");
    if (!/^[a-f0-9]{48}$/.test(tok)) return ok({ errore: "Link non valido." }, 400);
    const row = await env.DB.prepare("SELECT id, mittente FROM foto WHERE token_hash=? AND destinatario=?").bind(await L.sha256(tok), id.uid).first();
    if (!row) return ok({ errore: "Foto non trovata." }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE foto SET segnalata=1 WHERE id=?").bind(row.id),
      env.DB.prepare("INSERT INTO segnalazioni (segnalato, segnalante, tipo, foto_id) VALUES (?, ?, 'foto', ?)").bind(row.mittente, id.uid, row.id),
    ]);
    await L.valutaBan(env, row.mittente);
    return ok({ ok: true });
  }

  // ---------- Stanze tematiche (creazione: Contributori; accesso: almeno Premium) ----------
  if (rotta === "GET /api/stanze") {
    const e = richiediPremium(); if (e) return e;
    const cat = url.searchParams.get("cat");
    const filtro = cat !== null && cat !== "" && Number.isInteger(+cat) ? " AND s.categoria = " + (+cat | 0) : "";
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.nome, s.descrizione, s.categoria, s.online, s.max_membri, s.proprietario, u.nome AS prop_nome
       FROM stanze s JOIN utenti u ON u.id = s.proprietario
       WHERE s.stato = 'attiva' AND u.piano = 'contributore' AND u.premium_fino > datetime('now')${filtro}
       ORDER BY s.online DESC, s.creata_il DESC LIMIT 100`
    ).all();
    return ok({ stanze: results.map((r) => ({ ...r, mia: r.proprietario === id.utente.id, proprietario: undefined })) });
  }
  if (rotta === "POST /api/stanze") {
    if (!contributoreAttivo(id)) return ok({ errore: "Per creare una stanza serve l’abbonamento Contributore." }, 403);
    const b = await corpo(req);
    const nome = String(b.nome || "").trim(), descrizione = String(b.descrizione || "").trim(), regole = String(b.regole || "").trim();
    const cat = parseInt(b.categoria, 10);
    if (nome.length < 3 || nome.length > 40) return ok({ errore: "Il nome deve avere da 3 a 40 caratteri." }, 400);
    if (!(cat >= 0 && cat < L.TAGS.length)) return ok({ errore: "Scegli una categoria." }, 400);
    if (descrizione.length > 200) return ok({ errore: "La descrizione può avere al massimo 200 caratteri." }, 400);
    if (regole.length < 10 || regole.length > 1000) return ok({ errore: "Scrivi le regole della stanza (da 10 a 1000 caratteri)." }, 400);
    const parole = await L.paroleVietate(env);
    if ([nome, descrizione, regole].some((t) => L.messaggioBloccato(t, parole))) return ok({ errore: "Il testo contiene link, contatti o parole non consentite." }, 400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM stanze WHERE proprietario = ? AND stato = 'attiva'").bind(id.utente.id).first();
    if (n.c >= MAX_STANZE) return ok({ errore: "Puoi avere al massimo " + MAX_STANZE + " stanze attive." }, 409);
    const sid = L.rnd(8);
    try {
      await env.DB.prepare("INSERT INTO stanze (id, proprietario, nome, descrizione, regole, categoria) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(sid, id.utente.id, nome, descrizione, regole, cat).run();
    } catch (er) {
      if (/UNIQUE/i.test(String(er.message))) return ok({ errore: "Esiste già una stanza con questo nome." }, 409);
      throw er;
    }
    return ok({ id: sid });
  }
  if (m === "GET" && p.startsWith("/api/stanze/")) {
    const e = richiediPremium(); if (e) return e;
    const sid = p.slice(12);
    if (!/^[a-f0-9]{16}$/.test(sid)) return ok({ errore: "Stanza non valida." }, 400);
    const r = await statoStanza(env, id, sid);
    if (r.errore) return ok({ errore: r.errore }, r.status);
    const s = r.stanza;
    return ok({ id: s.id, nome: s.nome, descrizione: s.descrizione, regole: s.regole, categoria: s.categoria, online: s.online, max: s.max_membri, proprietario: s.prop_nome, mia: s.proprietario === id.utente.id });
  }
  if (p === "/ws-stanza") {
    if (req.headers.get("upgrade") !== "websocket") return new Response("Atteso WebSocket", { status: 426 });
    const o = req.headers.get("origin");
    if (o && new URL(o).host !== url.host) return new Response("Origine non consentita", { status: 403 });
    if (!id.premium) return new Response("Serve un abbonamento Premium", { status: 403 });
    const sid = url.searchParams.get("s") || "";
    if (!/^[a-f0-9]{16}$/.test(sid)) return new Response("Stanza non valida", { status: 400 });
    const r = await statoStanza(env, id, sid);
    if (r.errore) return new Response(r.errore, { status: r.status });
    const s = r.stanza, u = id.utente;
    const info = {
      u: u.id, n: u.nome, a: u.avatar ? 1 : 0, r: s.proprietario === u.id ? "o" : "m", sid, max: s.max_membri,
      stanza: { nome: s.nome, descrizione: s.descrizione, regole: s.regole, categoria: s.categoria, proprietario: s.prop_nome },
    };
    const h = new Headers(req.headers);
    h.set("x-info", encodeURIComponent(JSON.stringify(info)));
    return env.STANZA.get(env.STANZA.idFromName(sid)).fetch(new Request(req.url, { method: "GET", headers: h }));
  }

  return ok({ errore: "Percorso non trovato." }, 404);
}

async function statoStanza(env, id, sid) {
  if (await L.banAttivo(env, id.uid)) return { errore: "Al momento non puoi entrare nelle stanze.", status: 403 };
  const s = await env.DB.prepare(
    `SELECT s.*, u.nome AS prop_nome FROM stanze s JOIN utenti u ON u.id = s.proprietario
     WHERE s.id = ? AND s.stato = 'attiva' AND u.piano = 'contributore' AND u.premium_fino > datetime('now')`
  ).bind(sid).first();
  if (!s) return { errore: "Stanza non trovata o non più attiva.", status: 404 };
  if (await env.DB.prepare("SELECT 1 AS x FROM stanze_ban WHERE stanza = ? AND utente = ?").bind(sid, id.utente.id).first()) {
    return { errore: "Sei stato espulso da questa stanza.", status: 403 };
  }
  return { stanza: s };
}

// ---------- Webhook Stripe ----------
async function webhookStripe(req, env) {
  const payload = await req.text();
  if (!(await L.firmaStripeValida(env, payload, req.headers.get("stripe-signature")))) return L.json({ errore: "Firma non valida" }, 400);
  const ev = JSON.parse(payload);
  const o = ev.data.object;
  if (ev.type === "checkout.session.completed") {
    if (o.metadata?.sblocco) {
      await env.DB.prepare("DELETE FROM ban WHERE utente = ? AND permanente = 0").bind(o.metadata.sblocco).run();
    } else if (o.mode === "subscription" && o.client_reference_id) {
      await env.DB.prepare("UPDATE utenti SET stripe_cliente=?, stripe_sub=?, piano=?, premium_fino=? WHERE id=?")
        .bind(o.customer, o.subscription, o.metadata?.piano === "contributore" ? "contributore" : "premium", L.ora(35 * 86400), o.client_reference_id).run();
    }
  } else if (ev.type === "invoice.paid") {
    const fine = o.lines?.data?.[0]?.period?.end;
    if (o.customer && fine) {
      const f = new Date((fine + 2 * 86400) * 1000).toISOString().slice(0, 19).replace("T", " ");
      await env.DB.prepare("UPDATE utenti SET premium_fino = ? WHERE stripe_cliente = ?").bind(f, o.customer).run();
    }
  } else if (ev.type === "customer.subscription.updated") {
    const prezzo = o.items?.data?.[0]?.price?.id;
    const piano = prezzo && prezzo === env.STRIPE_PRICE_CONTRIBUTORE ? "contributore" : prezzo && prezzo === env.STRIPE_PRICE_PREMIUM ? "premium" : null;
    if (piano && o.customer) await env.DB.prepare("UPDATE utenti SET piano = ? WHERE stripe_cliente = ?").bind(piano, o.customer).run();
  } else if (ev.type === "customer.subscription.deleted") {
    await env.DB.prepare("UPDATE utenti SET premium_fino = datetime('now') WHERE stripe_cliente = ?").bind(o.customer).run();
  }
  return L.json({ ricevuto: true });
}

// ---------- Percorsi riservati a n8n (riepilogo email) ----------
async function admin(req, env, p, m) {
  if (!env.WORKER_SECRET || req.headers.get("x-worker-secret") !== env.WORKER_SECRET) return L.json({ errore: "Non autorizzato" }, 401);
  if (m === "GET" && p === "/api/admin/riepilogo") {
    const { results } = await env.DB.prepare("SELECT utente, motivo, creato_il, scade_il FROM ban WHERE notificato = 0").all();
    const f = await env.DB.prepare("SELECT COUNT(*) AS c FROM segnalazioni WHERE tipo='foto' AND creata_il > datetime('now','-1 day')").first();
    const s = await env.DB.prepare("SELECT COUNT(*) AS c FROM segnalazioni WHERE creata_il > datetime('now','-1 day')").first();
    return L.json({ ban_nuovi: results, foto_segnalate_24h: f.c, segnalazioni_24h: s.c });
  }
  if (m === "POST" && p === "/api/admin/riepilogo-letto") {
    await env.DB.prepare("UPDATE ban SET notificato = 1 WHERE notificato = 0").run();
    return L.json({ ok: true });
  }
  return L.json({ errore: "Percorso non trovato." }, 404);
}
