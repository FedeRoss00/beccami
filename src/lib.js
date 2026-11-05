// Funzioni condivise tra Worker e server delle chat.

export const TAGS = ["Musica", "Calcio", "Gaming", "Film e serie", "Viaggi", "Anime", "Cucina", "Tecnologia", "Fitness", "Libri"];

export const enc = new TextEncoder();
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const rnd = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export const ora = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 19).replace("T", " ");

export const json = (data, status = 200, cookies = []) => {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  cookies.forEach((c) => h.append("set-cookie", c));
  return new Response(JSON.stringify(data), { status, headers: h });
};

export function leggiCookie(req, nome) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + nome + "=([^;]*)"));
  return m ? m[1] : null;
}
export const cookie = (nome, valore, secondi) => `${nome}=${valore}; Path=/; Max-Age=${secondi}; HttpOnly; Secure; SameSite=Lax`;

function uguali(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Password (PBKDF2) ----------
export async function hashPassword(pw, salt) {
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return hex(salt) + ":" + hex(bits);
}
export async function verificaPassword(pw, salvata) {
  const salt = new Uint8Array(salvata.split(":")[0].match(/../g).map((h) => parseInt(h, 16)));
  return uguali(await hashPassword(pw, salt), salvata);
}

// ---------- Filtro messaggi ----------
export function normalizza(t) {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[01345@$]/g, (c) => ({ 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", "@": "a", $: "s" })[c])
    .replace(/(.)\1+/g, "$1");
}
export function messaggioBloccato(testo, parole) {
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|it|net|org|me|io|ly|gl|xyz)\b)/i.test(testo)) return "link";
  if (/(\+?\d[\s.\-]?){8,}/.test(testo)) return "numero di telefono";
  if (/@\w{3,}/.test(testo)) return "contatto";
  return normalizza(testo).split(/[^a-z]+/).some((w) => w && parole.has(w)) ? "parola vietata" : null;
}

// ---------- Ban (per account/ospite E per indirizzo IP) ----------
// L'IP non viene mai salvato in chiaro: si conserva solo un codice (hash con sale) per riconoscerlo.
function espandiIpv6(ip) {
  const [a, b = ""] = ip.split("::");
  const x = a ? a.split(":") : [], y = b ? b.split(":") : [];
  return [...x, ...Array(Math.max(0, 8 - x.length - y.length)).fill("0"), ...y].map((g) => g.padStart(4, "0"));
}
export async function hashIp(env, ip) {
  if (!ip) return "";
  // IPv6: si usa il prefisso /64 (chi cambia indirizzo dentro la stessa rete resta riconosciuto)
  const base = ip.includes(":") ? espandiIpv6(ip.toLowerCase()).slice(0, 4).join(":") : ip;
  return (await sha256((env.IP_SALT || env.WORKER_SECRET || "beccami") + "|" + base)).slice(0, 32);
}
export async function banAttivo(env, uid, ip = "") {
  return env.DB.prepare(
    `SELECT motivo, scade_il, permanente FROM ban
     WHERE (utente = ?1 OR (?2 != '' AND ip = ?2)) AND (permanente = 1 OR scade_il > datetime('now'))
     ORDER BY permanente DESC, scade_il DESC LIMIT 1`
  ).bind(uid, ip).first();
}
// 7 persone diverse negli ultimi 30 giorni => ban di 7 giorni (su account/ospite e su IP). Poi il contatore riparte da zero.
export async function valutaBan(env, uid, ip = "") {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ban WHERE (utente = ?1 OR (?2 != '' AND ip = ?2)) AND permanente = 0 AND scade_il <= datetime('now')").bind(uid, ip),
    env.DB.prepare(
      `INSERT OR IGNORE INTO ban (utente, motivo, scade_il, ip)
       SELECT ?1, '7 segnalazioni', datetime('now','+7 days'), ?2
       WHERE (SELECT COUNT(DISTINCT segnalante) FROM segnalazioni
              WHERE segnalato=?1 AND archiviata=0 AND creata_il > datetime('now','-30 days')) >= 7`
    ).bind(uid, ip),
    env.DB.prepare(
      `UPDATE segnalazioni SET archiviata=1 WHERE segnalato=?1 AND archiviata=0
       AND EXISTS (SELECT 1 FROM ban WHERE utente=?1 AND (permanente=1 OR scade_il > datetime('now')))`
    ).bind(uid),
  ]);
  return banAttivo(env, uid, ip);
}

// ---------- Stripe (senza librerie esterne) ----------
export async function stripe(env, path, params) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Errore Stripe");
  return j;
}
export async function firmaStripeValida(env, payload, header) {
  if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
  const p = Object.fromEntries(header.split(",").map((x) => x.split("=")));
  if (!p.t || !p.v1 || Math.abs(Date.now() / 1000 - Number(p.t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const calc = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${p.t}.${payload}`)));
  return uguali(calc, p.v1);
}

// ---------- Parole vietate (con cache) e lettura da Stripe ----------
let _parole = null, _paroleTs = 0;
export async function paroleVietate(env) {
  if (!_parole || Date.now() - _paroleTs > 300000) {
    const { results } = await env.DB.prepare("SELECT parola FROM parole_vietate").all();
    _parole = new Set(results.map((r) => normalizza(r.parola)));
    _paroleTs = Date.now();
  }
  return _parole;
}
export async function stripeGet(env, path) {
  const r = await fetch("https://api.stripe.com/v1" + path, { headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Errore Stripe");
  return j;
}
