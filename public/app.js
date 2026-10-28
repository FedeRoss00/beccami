"use strict";
// Beccami: interfaccia del sito.
const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const S = {
  cfg: {}, io: {}, ws: null, retry: 0, mode: "t", sel: new Set(), stats: { online: 0, interessi: [] },
  chat: false, partner: null, stream: null, pc: null, seg: Promise.resolve(), pend: [], ice: [],
  dm: null, nuovi: 0, reg: false, tokFoto: null,
};

// ---------- utilità ----------
function toast(t) {
  const e = $("#toast");
  e.textContent = t; e.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("on"), 4000);
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.errore) || "Errore di rete. Riprova."); e.status = r.status; throw e; }
  return j;
}
const quando = (s) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" }) : "");
function vista(id) { document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === id)); }
const invia = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
const chiudiDlg = (id) => { const d = $(id); if (d.open) d.close(); };

// ---------- tema chiaro/scuro ----------
try { const t = localStorage.getItem("tema"); if (t) document.documentElement.dataset.theme = t; } catch {}
$("#tema").onclick = () => {
  const r = document.documentElement;
  const scuro = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  r.dataset.theme = scuro ? "light" : "dark";
  try { localStorage.setItem("tema", r.dataset.theme); } catch {}
};

// ---------- home ----------
function chips() {
  const box = $("#chips");
  box.replaceChildren();
  (S.cfg.tags || []).forEach((nome, i) => {
    const b = el("button", "chip"); b.type = "button";
    b.setAttribute("aria-pressed", String(S.sel.has(i)));
    b.append(el("span", null, nome), el("small", null, String(S.stats.interessi[i] || 0)));
    b.onclick = () => {
      const c = S.stats.interessi;
      if (S.sel.has(i)) { S.sel.delete(i); c[i] = Math.max(0, (c[i] || 0) - 1); } else { S.sel.add(i); c[i] = (c[i] || 0) + 1; }
      invia({ t: "interessi", int: [...S.sel] });
      chips();
    };
    box.append(b);
  });
}
function intestazione() {
  const io = S.io;
  $("#btnAccount").textContent = io.registrato ? io.nome + (io.premium ? " · " + (io.piano === "contributore" ? "Contributore" : "Premium") : "") : "Accedi";
  $("#btnContatti").hidden = !io.premium;
  $("#onl").textContent = S.stats.online ? S.stats.online.toLocaleString("it-IT") : "–";
  $("#reg").hidden = !!io.registrato;
  $("#regC").hidden = !!io.registrato;
  $("#btnStanze").hidden = !io.premium;
  const av = $("#avviso");
  av.hidden = !(io.registrato && !io.premium);
  if (!av.hidden) {
    av.replaceChildren(el("span", null, "Il tuo abbonamento Premium non è attivo."));
    const b = el("button", "p", "Attiva Premium"); b.onclick = () => pagamento("premium"); av.append(b);
  }
}
async function aggiornaIo() { S.io = await api("/api/io"); intestazione(); }
async function pagamento(piano) {
  try {
    const j = await api("/api/checkout", { piano });
    if (j.url) { location.href = j.url; return; }
    toast(j.prova ? "Modalità di prova: abbonamento attivato." : "Abbonamento aggiornato: le modifiche arrivano tra pochi secondi.");
    for (let i = 0; i < 5; i++) { await aggiornaIo(); if (S.io.piano === piano && S.io.premium) break; await new Promise((r) => setTimeout(r, 2000)); }
    riconnetti();
  } catch (e) { toast(e.message); }
}
function setModo(m) {
  if (m === "v" && !S.io.premium) return toast("La video chat è riservata agli utenti Premium.");
  S.mode = m;
  $("#modoT").classList.toggle("on", m === "t"); $("#modoV").classList.toggle("on", m === "v");
  $("#modoT").setAttribute("aria-pressed", String(m === "t")); $("#modoV").setAttribute("aria-pressed", String(m === "v"));
}
$("#modoT").onclick = () => setModo("t");
$("#modoV").onclick = () => setModo("v");
$("#reg").onclick = () => apriAuth(true, "premium");
$("#regC").onclick = () => apriAuth(true, "contributore");
$("#go").onclick = async () => {
  if (!$("#age").checked) return toast("Conferma di avere almeno 18 anni per continuare.");
  if (S.io.ban) return mostraBan(S.io.ban);
  if (S.mode === "v") {
    if (!S.io.premium) return toast("La video chat è riservata agli utenti Premium.");
    try { S.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
    catch { return toast("Non riesco ad accedere a camera e microfono. Controlla i permessi del browser."); }
  }
  S.chat = true;
  vista("chat");
  $("#msgs").replaceChildren();
  $("#video").hidden = S.mode !== "v";
  if (S.mode === "v") $("#locale").srcObject = S.stream;
  cerca();
};

// ---------- collegamento in tempo reale ----------
function connetti() {
  if (S.ws && S.ws.readyState <= 1) return;
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    if (S.sel.size) invia({ t: "interessi", int: [...S.sel] });
    if (S.chat && !S.partner) cerca();
  };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } gestisci(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    if (S.chat && S.partner) { sistema("Connessione persa. Riconnessione in corso…"); S.partner = null; chiudiVideo(); profilo(null); }
    setTimeout(connetti, Math.min(15000, 1000 * 2 ** S.retry++));
  };
}
function riconnetti() { if (S.ws) S.ws.close(); else connetti(); }

function gestisci(m) {
  switch (m.t) {
    case "hello": case "stats":
      S.stats = { online: m.online, interessi: m.interessi }; intestazione();
      if ($("#home").classList.contains("on")) chips();
      break;
    case "cerco": break;
    case "match":
      S.partner = m.partner; profilo(m.partner);
      sistema(m.comuni.length ? "Siete connessi. Interessi in comune: " + m.comuni.join(", ") + "." : "Siete connessi. Salutatevi!");
      if (m.mode === "v") avviaVideo(m.ruolo);
      break;
    case "msg": aggiungi("t", m.x); break;
    case "peer_left": if (!S.chat) break; sistema("L’altra persona ha lasciato la chat."); cerca(); break;
    case "bloccato": sistema("Messaggio non inviato: contiene " + m.motivo + "."); break;
    case "lento": toast("Stai scrivendo troppo in fretta."); break;
    case "errore": toast(m.x); break;
    case "segnalato": toast("Segnalazione inviata. Grazie."); break;
    case "salvato":
      sistema(m.mutuo ? "Chat salvata: da ora i vostri messaggi vengono conservati e potrete riprenderla dai Contatti."
        : "Contatto salvato. Quando salverà anche l’altra persona, la chat verrà conservata.");
      break;
    case "richiesta_salva": sistema(m.nome + " vuole salvare la chat. Premi “Salva” se vuoi."); break;
    case "foto": bollaFoto(m.tok); break;
    case "dm": ricevutoDm(m); break;
    case "sdp": case "ice": if (S.pc) segnale(m); else S.pend.push(m); break;
    case "banned": mostraBan({ fino: m.fino, permanente: m.permanente }); esciChat(); S.io.ban = { fino: m.fino, permanente: m.permanente }; break;
  }
}

// ---------- chat ----------
function aggiungi(cls, testo) {
  const box = $("#msgs"), d = el("div", "m " + cls, testo);
  box.append(d); box.scrollTop = box.scrollHeight;
  return d;
}
const sistema = (t) => aggiungi("s", t);
function profilo(p) {
  const av = $("#pav");
  av.replaceChildren();
  if (p && p.avatar) { const i = el("img"); i.src = p.avatar; i.alt = ""; av.append(i); } else av.textContent = p ? p.nome[0] : "?";
  $("#pname").textContent = p ? p.nome : "Ricerca…";
  $("#pmeta").textContent = p ? (p.premium ? p.sesso + " · " + p.eta + " anni · Premium" : "Ospite") : "";
  $("#btnSalva").hidden = !(p && p.premium && S.io.premium);
}
function cerca() {
  S.partner = null; chiudiVideo(); profilo(null);
  $("#pname").textContent = "Cerco qualcuno…";
  invia({ t: "join", mode: S.mode });
}
function esciChat() {
  S.chat = false; S.partner = null; chiudiVideo();
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  vista("home");
}
$("#btnEsci").onclick = () => { invia({ t: "esci" }); esciChat(); };
$("#btnSegnala").onclick = () => {
  if (!S.partner) return toast("Non c’è nessuno da segnalare.");
  if (confirm("Vuoi segnalare questa persona? Dopo diverse segnalazioni da utenti diversi l’accesso viene sospeso.")) invia({ t: "report" });
};
$("#btnSalva").onclick = () => invia({ t: "salva" });
$("#f").onsubmit = (e) => {
  e.preventDefault();
  const x = $("#txt").value.trim();
  if (!x) return;
  if (!S.partner) return toast("Aspetta di essere connesso a qualcuno.");
  aggiungi("me", x); invia({ t: "msg", x }); $("#txt").value = "";
};
let arma;
const disarma = () => { const b = $("#skip"); b.classList.remove("arm"); b.textContent = "Salta"; };
$("#skip").onclick = () => {
  const b = $("#skip");
  if (!b.classList.contains("arm")) { b.classList.add("arm"); b.textContent = "Premi ancora per saltare"; clearTimeout(arma); arma = setTimeout(disarma, 2000); return; }
  disarma();
  if (S.partner) sistema("Hai saltato la chat.");
  invia({ t: "skip" }); cerca();
};

// ---------- foto che si vedono una sola volta ----------
async function ridimensiona(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); // la ricodifica elimina anche i dati GPS
  return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.82));
}
$("#btnFoto").onclick = () => (S.partner ? $("#file").click() : toast("Aspetta di essere connesso a qualcuno."));
$("#file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const fd = new FormData(); fd.append("file", await ridimensiona(f), "foto.jpg");
    const r = await fetch("/api/foto", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.errore || "Invio della foto non riuscito.");
    invia({ t: "foto", tok: j.tok });
    sistema("Hai inviato una foto: l’altra persona potrà vederla una sola volta.");
  } catch (er) { toast(er.message); sistema(er.message); }
};
function bollaFoto(tok) {
  const d = aggiungi("t", "");
  const b = el("button", "peek", "Foto · si può aprire una sola volta. Tocca per vederla.");
  d.append(b);
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await fetch("/api/foto/vedi", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tok }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.errore || "Foto non disponibile."); e.status = r.status; throw e; }
      mostraFoto(await r.blob(), tok);
      b.textContent = "Foto vista.";
    } catch (er) { b.textContent = er.message; if (er.status === 503) b.disabled = false; }
  };
}
async function mostraFoto(blob, tok) {
  const bmp = await createImageBitmap(blob), c = $("#fc");
  c.width = bmp.width; c.height = bmp.height; c.getContext("2d").drawImage(bmp, 0, 0);
  S.tokFoto = tok; $("#dFoto").classList.remove("nascosta"); $("#dFoto").showModal();
}
$("#dFoto").addEventListener("contextmenu", (e) => e.preventDefault());
$("#dFoto").addEventListener("close", () => { const c = $("#fc"); c.getContext("2d").clearRect(0, 0, c.width, c.height); c.width = c.height = 1; S.tokFoto = null; });
$("#fChiudi").onclick = () => chiudiDlg("#dFoto");
$("#fSegnala").onclick = async () => {
  try { await api("/api/foto/segnala", { tok: S.tokFoto }); toast("Foto segnalata. Grazie."); chiudiDlg("#dFoto"); } catch (e) { toast(e.message); }
};
document.addEventListener("visibilitychange", () => $("#dFoto").classList.toggle("nascosta", document.hidden));

// ---------- video chat (Premium) ----------
async function avviaVideo(ruolo) {
  let ice;
  try { ice = await api("/api/ice"); } catch { ice = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }; }
  if (!S.partner || !S.stream) return;
  const pc = (S.pc = new RTCPeerConnection({ iceServers: ice.iceServers }));
  S.stream.getTracks().forEach((t) => pc.addTrack(t, S.stream));
  pc.ontrack = (e) => { $("#remoto").srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) invia({ t: "ice", d: e.candidate }); };
  const coda = S.pend; S.pend = []; coda.forEach(segnale);
  if (ruolo === "caller") { const o = await pc.createOffer(); await pc.setLocalDescription(o); invia({ t: "sdp", d: pc.localDescription }); }
}
function segnale(m) {
  S.seg = S.seg.then(async () => {
    const pc = S.pc;
    if (!pc) return;
    try {
      if (m.t === "sdp") {
        await pc.setRemoteDescription(m.d);
        if (m.d.type === "offer") { const a = await pc.createAnswer(); await pc.setLocalDescription(a); invia({ t: "sdp", d: pc.localDescription }); }
        for (const c of S.ice) await pc.addIceCandidate(c);
        S.ice = [];
      } else if (pc.remoteDescription) await pc.addIceCandidate(m.d);
      else S.ice.push(m.d);
    } catch (e) { console.warn(e); }
  });
}
function chiudiVideo() {
  if (S.pc) { S.pc.close(); S.pc = null; }
  S.pend = []; S.ice = [];
  $("#remoto").srcObject = null;
}
function interruttore(btn, tipo) {
  btn.onclick = () => {
    if (!S.stream) return;
    const tracce = tipo === "mic" ? S.stream.getAudioTracks() : S.stream.getVideoTracks();
    const on = !tracce[0]?.enabled;
    tracce.forEach((t) => (t.enabled = on));
    btn.classList.toggle("off", !on);
  };
}
interruttore($("#vMic"), "mic"); interruttore($("#vCam"), "cam");

// ---------- account ----------
function apriAuth(reg, piano) {
  S.reg = reg;
  if (piano) $("#aPiano").value = piano;
  $("#authTit").textContent = reg ? "Crea account Premium" : "Accedi";
  $("#campiReg").hidden = !reg;
  ["#aNome", "#aEta", "#aSesso", "#aAcc"].forEach((s) => ($(s).required = reg));
  $("#aOk").textContent = reg ? "Crea account" : "Accedi";
  $("#aAltro").textContent = reg ? "Ho già un account" : "Crea account";
  $("#aPass").autocomplete = reg ? "new-password" : "current-password";
  $("#aPrezzo").textContent = S.cfg.prova ? "Modalità di prova: l’abbonamento è gratuito."
    : S.cfg.pagamenti ? "Abbonamento mensile, pagamento sicuro con Stripe. Puoi disdire quando vuoi." : "I pagamenti non sono ancora attivi.";
  $("#aErr").textContent = "";
  if (!$("#dAuth").open) $("#dAuth").showModal();
}
$("#btnAccount").onclick = () => (S.io.registrato ? apriAccount() : apriAuth(false));
$("#aAltro").onclick = () => apriAuth(!S.reg);
$("#aChiudi").onclick = () => chiudiDlg("#dAuth");
async function avatar(f) {
  if (!f) return null;
  const b = await createImageBitmap(f), l = Math.min(b.width, b.height);
  const c = document.createElement("canvas"); c.width = c.height = 128;
  c.getContext("2d").drawImage(b, (b.width - l) / 2, (b.height - l) / 2, l, l, 0, 0, 128, 128);
  return c.toDataURL("image/jpeg", 0.8);
}
$("#fAuth").onsubmit = async (e) => {
  e.preventDefault();
  $("#aErr").textContent = ""; $("#aOk").disabled = true;
  try {
    const dati = { email: $("#aEmail").value, password: $("#aPass").value };
    const j = S.reg
      ? await api("/api/registrati", { ...dati, nome: $("#aNome").value, eta: $("#aEta").value, sesso: $("#aSesso").value, accetto: $("#aAcc").checked, piano: $("#aPiano").value, avatar: await avatar($("#aAvatar").files[0]) })
      : await api("/api/accedi", dati);
    if (j.checkout) { location.href = j.checkout; return; }
    chiudiDlg("#dAuth");
    await aggiornaIo(); riconnetti();
    toast(j.avviso || (S.io.premium ? "Benvenuto in Beccami Premium!" : "Accesso effettuato."));
  } catch (er) { $("#aErr").textContent = er.message; } finally { $("#aOk").disabled = false; }
};
function apriAccount() {
  const c = $("#accCont"), io = S.io;
  const nomePiano = io.piano === "contributore" ? "Contributore" : "Premium";
  c.replaceChildren(el("h2", null, io.nome), el("p", "mute", io.sesso + ", " + io.eta + " anni"),
    el("p", null, io.premium ? "Abbonamento " + nomePiano + " attivo fino al " + quando(io.premium_fino) + "." : "Abbonamento non attivo."));
  const az = el("div", "cta");
  if (!io.premium) { const b = el("button", "p", "Attiva Premium · 5 € al mese"); b.onclick = () => pagamento("premium"); az.append(b); }
  if (!(io.premium && io.piano === "contributore") && (S.cfg.prova || (S.cfg.contributore && S.cfg.contributore.attivo))) {
    const b = el("button", io.premium ? "p" : "", "Passa a Contributore · 8 € al mese");
    b.onclick = () => { chiudiDlg("#dAcc"); pagamento("contributore"); };
    az.append(b);
  }
  if (io.premium && (S.cfg.pagamenti || (S.cfg.contributore && S.cfg.contributore.attivo))) {
    const b = el("button", null, "Gestisci abbonamento");
    b.onclick = async () => { try { location.href = (await api("/api/portale", {})).url; } catch (e) { toast(e.message); } };
    az.append(b);
  }
  const es = el("button", null, "Esci dall’account");
  es.onclick = async () => { await api("/api/esci", {}); location.reload(); };
  az.append(es); c.append(az);
  $("#dAcc").showModal();
}
$("#accChiudi").onclick = () => chiudiDlg("#dAcc");

// ---------- ban ----------
function mostraBan(b) {
  $("#banCont").replaceChildren(el("h2", null, "Accesso sospeso"),
    el("p", null, b.permanente ? "Il tuo accesso è stato sospeso in modo permanente."
      : "Sei stato segnalato da più persone. Potrai tornare il " + quando(b.fino) + ", oppure sbloccare subito l’accesso."));
  $("#banSblocca").hidden = !!b.permanente || !S.cfg.pagamenti;
  if (!$("#dBan").open) $("#dBan").showModal();
}
$("#banChiudi").onclick = () => chiudiDlg("#dBan");
$("#banSblocca").onclick = async () => { try { location.href = (await api("/api/sblocco", {})).url; } catch (e) { toast(e.message); } };

// ---------- contatti e chat salvate (Premium) ----------
$("#btnContatti").onclick = () => { vista("contatti"); $("#listaC").hidden = false; $("#threadC").hidden = true; S.dm = null; S.nuovi = 0; $("#badge").hidden = true; caricaContatti(); };
$("#indietroC").onclick = () => vista("home");
$("#indietroD").onclick = () => $("#btnContatti").onclick();
function avatarEl(c) {
  const av = el("div", "av");
  if (c.av) { const i = el("img"); i.src = "/api/avatar/" + c.id; i.alt = ""; av.append(i); } else av.textContent = c.nome[0];
  return av;
}
async function caricaContatti() {
  const box = $("#elencoC");
  box.replaceChildren();
  try {
    const j = await api("/api/contatti");
    if (!j.contatti.length) { box.append(el("p", "mute", "Nessun contatto salvato. Durante una chat con un altro utente Premium premi “Salva”.")); return; }
    j.contatti.forEach((c) => {
      const r = el("div", "ct"), w = el("div", "who");
      w.append(el("b", null, c.nome), el("span", null, c.mutuo ? c.ultimo || c.sesso + " · " + c.eta + " anni" : "In attesa che ti salvi anche l’altra persona"));
      const b = el("button", c.mutuo ? "p" : "", "Apri chat"); b.disabled = !c.mutuo; b.onclick = () => apriDm(c);
      r.append(avatarEl(c), w, b); box.append(r);
    });
  } catch (e) { box.append(el("p", "mute", e.message)); }
}
async function apriDm(c) {
  S.dm = c;
  $("#listaC").hidden = true; $("#threadC").hidden = false;
  const av = $("#dav"); av.replaceChildren(); if (c.av) { const i = el("img"); i.src = "/api/avatar/" + c.id; i.alt = ""; av.append(i); } else av.textContent = c.nome[0];
  $("#dname").textContent = c.nome; $("#dmeta").textContent = c.sesso + " · " + c.eta + " anni";
  const box = $("#dmsgs"); box.replaceChildren();
  try { (await api("/api/dm?con=" + c.id)).messaggi.forEach((m) => addDm(m.mio ? "me" : "t", m.x)); } catch (e) { toast(e.message); }
}
function addDm(cls, x) { const b = $("#dmsgs"); b.append(el("div", "m " + cls, x)); b.scrollTop = b.scrollHeight; }
$("#fd").onsubmit = (e) => {
  e.preventDefault();
  const x = $("#dtxt").value.trim();
  if (!x || !S.dm) return;
  addDm("me", x); invia({ t: "dm", a: S.dm.id, x }); $("#dtxt").value = "";
};
function ricevutoDm(m) {
  if (S.dm && S.dm.id === m.da && $("#contatti").classList.contains("on")) { addDm("t", m.x); return; }
  toast(m.nome + " ti ha scritto.");
  S.nuovi++; $("#badge").textContent = String(S.nuovi); $("#badge").hidden = false;
}

// ---------- stanze tematiche ----------
const contributore = () => !!(S.io.premium && S.io.piano === "contributore");
const wsBase = () => (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
function riempiCat(sel, conTutte) {
  sel.replaceChildren();
  if (conTutte) sel.append(new Option("Tutte le categorie", ""));
  (S.cfg.tags || []).forEach((t, i) => sel.append(new Option(t, String(i))));
}
$("#btnStanze").onclick = () => { if (!$("#sCat").options.length) riempiCat($("#sCat"), true); vista("stanze"); caricaStanze(); };
$("#sCat").onchange = () => caricaStanze();
$("#sIndietro").onclick = () => vista("home");
async function caricaStanze() {
  const box = $("#elencoS");
  box.replaceChildren();
  $("#sNuova").textContent = contributore() ? "Crea una stanza" : "Diventa Contributore · 8 € al mese";
  try {
    const c = $("#sCat").value;
    const j = await api("/api/stanze" + (c !== "" ? "?cat=" + c : ""));
    if (!j.stanze.length) { box.append(el("p", "mute", "Nessuna stanza in questa categoria, per ora.")); return; }
    j.stanze.forEach((s) => {
      const r = el("div", "ct"), w = el("div", "who");
      w.append(el("b", null, s.nome + (s.mia ? " (tua)" : "")),
        el("span", null, S.cfg.tags[s.categoria] + " · " + s.online + "/" + s.max_membri + " persone · di " + s.prop_nome + (s.descrizione ? " · " + s.descrizione : "")));
      const b = el("button", "p", "Entra"); b.onclick = () => proponiStanza(s.id);
      r.append(w, b); box.append(r);
    });
  } catch (e) { box.append(el("p", "mute", e.message)); }
}
function mostraRegole(titolo, meta, regole, idPerEntrare) {
  $("#rgTit").textContent = titolo; $("#rgMeta").textContent = meta; $("#rgTesto").textContent = regole;
  $("#rgOk").hidden = !idPerEntrare;
  $("#rgOk").onclick = () => { chiudiDlg("#dRegole"); entraStanza(idPerEntrare); };
  $("#dRegole").showModal();
}
async function proponiStanza(id) {
  try {
    const s = await api("/api/stanze/" + id);
    mostraRegole(s.nome, S.cfg.tags[s.categoria] + " · admin " + s.proprietario + (s.descrizione ? " · " + s.descrizione : ""), s.regole, id);
  } catch (e) { toast(e.message); caricaStanze(); }
}
$("#rgChiudi").onclick = () => chiudiDlg("#dRegole");

function diventaContributore() {
  if (!S.io.registrato) return apriAuth(true, "contributore");
  pagamento("contributore");
}
$("#sNuova").onclick = () => {
  if (!contributore()) return diventaContributore();
  riempiCat($("#nCat")); $("#nErr").textContent = ""; $("#dNuova").showModal();
};
$("#nChiudi").onclick = () => chiudiDlg("#dNuova");
$("#fNuova").onsubmit = async (e) => {
  e.preventDefault();
  $("#nErr").textContent = "";
  try {
    const j = await api("/api/stanze", { nome: $("#nNome").value, categoria: $("#nCat").value, descrizione: $("#nDesc").value, regole: $("#nReg").value });
    chiudiDlg("#dNuova"); $("#fNuova").reset();
    entraStanza(j.id);
  } catch (er) { $("#nErr").textContent = er.message; }
};

function entraStanza(id) {
  const R = (S.st = { id, ws: null, io: null, ruolo: "m", membri: new Map(), info: {}, uscito: false });
  vista("stanza");
  $("#rmsgs").replaceChildren(); $("#rLista").hidden = true; $("#corpoS").classList.remove("lista");
  $("#rNome").textContent = "Entro nella stanza…"; $("#rMeta").textContent = ""; $("#rGestisci").hidden = true;
  const ws = (R.ws = new WebSocket(wsBase() + "/ws-stanza?s=" + id));
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } messaggioStanza(R, m); };
  ws.onclose = () => { if (S.st === R && !R.uscito) { toast("Connessione alla stanza interrotta."); esciStanza(); } };
}
function esciStanza() {
  if (S.st) { S.st.uscito = true; try { S.st.ws.close(); } catch {} S.st = null; }
  vista("stanze"); caricaStanze();
}
const rSistema = (t) => { const b = $("#rmsgs"); b.append(el("div", "m s", t)); b.scrollTop = b.scrollHeight; };
function rMsg(R, m) {
  const mio = m.da.id === R.io, b = $("#rmsgs"), d = el("div", "m " + (mio ? "me" : "t"));
  if (!mio) d.append(el("small", "mittente", m.da.nome + (m.da.r === "o" ? " · admin" : "")));
  d.append(el("span", null, m.x));
  b.append(d); b.scrollTop = b.scrollHeight;
}
function intestStanza(R) {
  $("#rNome").textContent = R.info.nome;
  $("#rMeta").textContent = S.cfg.tags[R.info.categoria] + " · admin " + R.info.proprietario;
  $("#rGestisci").hidden = R.ruolo !== "o";
}
function listaMembri(R) {
  $("#rMembri").textContent = "Persone (" + R.membri.size + ")";
  const box = $("#rLista");
  box.replaceChildren();
  R.membri.forEach((p) => {
    const r = el("div", "pers"), av = el("div", "av");
    if (p.av) { const i = el("img"); i.src = "/api/avatar/" + p.id; i.alt = ""; av.append(i); } else av.textContent = p.nome[0];
    const w = el("div", "who"); w.append(el("b", null, p.nome + (p.id === R.io ? " (tu)" : "")), el("span", null, p.r === "o" ? "Admin" : "Membro"));
    r.append(av, w);
    if (p.id !== R.io) {
      const sg = el("button", null, "Segnala");
      sg.onclick = () => { if (confirm("Segnalare " + p.nome + "?")) R.ws.send(JSON.stringify({ t: "segnala", id: p.id })); };
      r.append(sg);
      if (R.ruolo === "o") {
        const ex = el("button", null, "Espelli");
        ex.onclick = () => { if (confirm("Espellere " + p.nome + " dalla stanza? Non potrà più rientrare.")) R.ws.send(JSON.stringify({ t: "espelli", id: p.id })); };
        r.append(ex);
      }
    }
    box.append(r);
  });
}
function messaggioStanza(R, m) {
  switch (m.t) {
    case "benvenuto":
      R.io = m.io; R.ruolo = m.ruolo; R.info = m.info;
      m.membri.forEach((x) => R.membri.set(x.id, x));
      intestStanza(R); listaMembri(R);
      rSistema("Sei nella stanza “" + m.info.nome + "”. Le regole sono nel pulsante “Regole”.");
      break;
    case "entra": R.membri.set(m.m.id, m.m); listaMembri(R); rSistema(m.m.nome + " è entrato."); break;
    case "esce": { const x = R.membri.get(m.id); R.membri.delete(m.id); listaMembri(R); if (x) rSistema(x.nome + " è uscito."); break; }
    case "msg": rMsg(R, m); break;
    case "sistema": rSistema(m.x); break;
    case "info": R.info.descrizione = m.descrizione; R.info.regole = m.regole; break;
    case "bloccato": rSistema("Messaggio non inviato: contiene " + m.motivo + "."); break;
    case "lento": toast("Stai scrivendo troppo in fretta."); break;
    case "errore": toast(m.x); break;
    case "segnalato": toast("Segnalazione inviata. Grazie."); break;
    case "espulso": toast("Sei stato espulso dalla stanza."); esciStanza(); break;
    case "eliminata": toast("La stanza è stata eliminata dall’admin."); esciStanza(); break;
    case "rifiutato": toast(m.x); esciStanza(); break;
    case "banned": mostraBan({ fino: m.fino, permanente: m.permanente }); esciStanza(); break;
  }
}
$("#fr").onsubmit = (e) => {
  e.preventDefault();
  const x = $("#rtxt").value.trim();
  if (!x || !S.st || S.st.ws.readyState !== 1) return;
  S.st.ws.send(JSON.stringify({ t: "msg", x })); $("#rtxt").value = "";
};
$("#rEsci").onclick = esciStanza;
$("#rMembri").onclick = () => { const l = $("#rLista"); l.hidden = !l.hidden; $("#corpoS").classList.toggle("lista", !l.hidden); };
$("#rRegole").onclick = () => { if (S.st && S.st.info.regole) mostraRegole(S.st.info.nome, S.st.info.descrizione || "", S.st.info.regole, null); };
$("#rGestisci").onclick = () => { $("#gDesc").value = S.st.info.descrizione || ""; $("#gReg").value = S.st.info.regole || ""; $("#dGestisci").showModal(); };
$("#gChiudi").onclick = () => chiudiDlg("#dGestisci");
$("#gSalva").onclick = () => { S.st.ws.send(JSON.stringify({ t: "modifica", descrizione: $("#gDesc").value, regole: $("#gReg").value })); chiudiDlg("#dGestisci"); };
$("#gElimina").onclick = () => {
  if (confirm("Eliminare definitivamente la stanza? Tutti verranno disconnessi.")) { S.st.ws.send(JSON.stringify({ t: "elimina" })); chiudiDlg("#dGestisci"); }
};

// ---------- avvio ----------
async function init() {
  try { S.cfg = await api("/api/config"); S.io = await api("/api/io"); }
  catch { toast("Impossibile contattare il server. Riprova tra poco."); return; }
  chips(); intestazione(); connetti();
  const q = new URLSearchParams(location.search).get("pagamento");
  if (q) {
    history.replaceState(null, "", "/");
    if (q === "ok") {
      toast("Pagamento ricevuto. L’abbonamento si attiva tra pochi secondi.");
      const prima = S.io.piano + S.io.premium;
      for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 3000)); await aggiornaIo(); if (S.io.piano + S.io.premium !== prima) break; }
      if (S.io.premium) riconnetti();
    } else if (q === "sbloccato") { toast("Pagamento ricevuto. L’accesso verrà ripristinato a breve."); setTimeout(() => location.reload(), 4000); }
    else toast("Pagamento annullato.");
  }
}
init();
