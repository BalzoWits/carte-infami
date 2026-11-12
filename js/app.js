// Interfaccia: stato locale, rendering delle schermate e gestione dei tocchi.
import * as G from "./game.js";

const DECKS = [{ id: "base", name: "Base italiano", file: "decks/base.json" }];
const MIN_PLAYERS = 3;

const $app = document.getElementById("app");
const $toast = document.getElementById("toast");

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage non disponibile */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

const S = {
  screen: "loading",
  code: null,
  room: null,
  hand: null,
  handLoaded: false,
  selected: [],
  judgePick: null,
  showScores: false,
  addOpen: false,
  ctype: "white",
  decks: {},
  prev: {},
  dirty: false,
  prefillCode: "",
};
let disconnect = null;
let drawing = false;

// ---------- utilità ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove("show"), 2600);
}

function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* ok */ } }

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const BLANK = /_{3,}/g;

function normBlack(x) {
  const text = typeof x === "string" ? x : x && x.text;
  if (!text) return null;
  const blanks = (text.match(BLANK) || []).length;
  const pick = Math.min(3, Math.max(1, Number(x.pick) || blanks || 1));
  return { text: text.trim(), pick };
}
function normWhite(x) {
  const text = typeof x === "string" ? x : x && x.text;
  return text ? text.trim() : null;
}

// Riempie gli spazi della carta nera con le carte bianche scelte
function fillHTML(black, cards) {
  if (!black) return "";
  const parts = black.text.split(BLANK);
  if (parts.length === 1) {
    return esc(black.text) + (cards && cards.length
      ? ` <span class="ans">${cards.map(esc).join(" · ")}</span>` : "");
  }
  let out = "";
  parts.forEach((pt, i) => {
    out += esc(pt);
    if (i < parts.length - 1) {
      const c = cards && cards[i];
      out += c ? `<span class="ans">${esc(c)}</span>` : '<span class="blank"></span>';
    }
  });
  return out;
}

const isHost = () => S.room && S.room.hostUid === G.uid;
const playerName = (id) => (S.room && S.room.players && S.room.players[id] && S.room.players[id].name) || "?";

// ---------- wake lock: lo schermo resta acceso durante la partita ----------
let wakeLock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator) || S.screen !== "room" || document.visibilityState !== "visible") return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* non supportato */ }
}
document.addEventListener("visibilitychange", keepAwake);

// ---------- rendering ----------
function isTyping() {
  const a = document.activeElement;
  return a && $app.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox" && a.type !== "radio"));
}

// Mentre si scrive non si ridisegna (su iPhone si chiuderebbe la tastiera): si rimanda al blur
function render(force = false) {
  if (!force && isTyping()) { S.dirty = true; return; }
  S.dirty = false;
  const keep = {};
  $app.querySelectorAll("input[id], textarea[id]").forEach((el) => {
    if (!["checkbox", "radio", "file"].includes(el.type)) keep[el.id] = el.value;
  });
  const y = window.scrollY;
  let html;
  switch (S.screen) {
    case "setup": html = viewSetup(); break;
    case "error": html = viewError(); break;
    case "home": html = viewHome(); break;
    case "room": html = viewRoom(); break;
    default: html = viewLoading();
  }
  $app.innerHTML = html;
  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (el) el.value = v;
  }
  window.scrollTo(0, y);
}
$app.addEventListener("focusout", () => setTimeout(() => { if (S.dirty && !isTyping()) render(); }, 0));

function viewLoading() {
  return `<main class="screen center"><div class="spinner"></div></main>`;
}

function viewSetup() {
  return `<main class="screen center narrow">
    <h1 class="title">Carte Infami</h1>
    <div class="panel">
      <h2>Manca la configurazione Firebase</h2>
      <p>Apri <code>js/firebase-config.js</code> e incolla la configurazione del tuo progetto Firebase.
      I passaggi sono nel <code>README.md</code>.</p>
    </div>
  </main>`;
}

function viewError() {
  return `<main class="screen center narrow">
    <h1 class="title">Ops</h1>
    <div class="panel"><p>${esc(S.error)}</p>
    <button class="btn primary" onclick="location.reload()">Riprova</button></div>
  </main>`;
}

function viewHome() {
  return `<main class="screen home">
    <div class="hero">
      <div class="logo-cards" aria-hidden="true">
        <div class="lc lc-black">Il segreto della nonna? <span class="blank"></span></div>
        <div class="lc lc-white">Un piccione con ambizioni</div>
      </div>
      <h1 class="title">Carte Infami</h1>
      <p class="tagline">Completa la frase. Perdi gli amici.</p>
    </div>
    <div class="panel">
      <label class="field"><span>Il tuo nome</span>
        <input id="nameInput" maxlength="16" autocomplete="nickname" enterkeyhint="done"
          placeholder="Come ti chiamano" value="${esc(LS.get("name", ""))}">
      </label>
      <button class="btn primary big" data-action="create">Crea una stanza</button>
      <div class="or"><span>oppure entra con il codice</span></div>
      <div class="join-row">
        <input id="codeInput" maxlength="4" placeholder="ABCD" autocapitalize="characters"
          autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" value="${esc(S.prefillCode)}">
        <button class="btn" data-action="join">Entra</button>
      </div>
    </div>
    ${G.testMode ? '<p class="test-flag">Modalità test: ogni scheda è un giocatore diverso</p>' : ""}
  </main>`;
}

function viewRoom() {
  const r = S.room;
  if (!r) return viewLoading();
  const phase = (r.state && r.state.phase) || "lobby";
  let body;
  if (phase === "lobby") body = viewLobby();
  else if (phase === "end") body = viewEnd();
  else body = viewGame();
  return body + (S.showScores && phase !== "lobby" ? viewScores() : "");
}

function playerList(r) {
  return G.sortedPlayers(r).map((p) => `
    <li class="${p.online === false ? "off" : ""}">
      <span class="dot"></span>
      <span class="pname">${esc(p.name)}${p.uid === G.uid ? " <em>(tu)</em>" : ""}</span>
      ${p.uid === r.hostUid ? '<span class="badge">host</span>' : ""}
    </li>`).join("");
}

function viewLobby() {
  const r = S.room;
  const host = isHost();
  const online = G.sortedPlayers(r).filter((p) => p.online !== false);
  const set = r.settings || {};
  const decks = set.decks || ["base"];
  const cw = Object.keys((r.custom && r.custom.white) || {}).length;
  const cb = Object.keys((r.custom && r.custom.black) || {}).length;
  const saved = LS.get("mieCarte", { white: [], black: [] });
  const nSaved = saved.white.length + saved.black.length;
  const hostOffline = r.players[r.hostUid] && r.players[r.hostUid].online === false;

  return `<main class="screen lobby">
    <header class="room-head">
      <div>
        <div class="label">Codice stanza</div>
        <button class="room-code" data-action="copyCode" aria-label="Copia il codice">${esc(S.code)}</button>
      </div>
      <button class="btn" data-action="share">Invita</button>
    </header>

    <section class="block">
      <h2>Giocatori <span class="count">${online.length}</span></h2>
      <ul class="players">${playerList(r)}</ul>
      ${online.length < MIN_PLAYERS ? `<p class="hint">Servono almeno ${MIN_PLAYERS} giocatori: manda il codice agli amici.</p>` : ""}
      ${hostOffline && !host ? '<button class="btn ghost small" data-action="becomeHost">L\'host è offline: diventa host</button>' : ""}
    </section>

    <section class="block">
      <h2>Impostazioni</h2>
      <div class="setting">
        <span>Punti per vincere</span>
        <div class="chips">${[5, 7, 10].map((n) => `<button class="chip ${set.winScore === n ? "on" : ""}"
          data-action="setWin" data-v="${n}" ${host ? "" : "disabled"}>${n}</button>`).join("")}</div>
      </div>
      <div class="setting col">
        <span>Mazzi</span>
        ${DECKS.map((d) => {
          const dk = S.decks[d.id];
          const cnt = dk ? `${dk.black.length} nere · ${dk.white.length} bianche` : "";
          return `<label class="check"><input type="checkbox" data-action="toggleDeck" data-id="${d.id}"
            ${decks.includes(d.id) ? "checked" : ""} ${host ? "" : "disabled"}>
            <span>${esc(d.name)} <small>${cnt}</small></span></label>`;
        }).join("")}
        <div class="muted">Carte del gruppo: ${cb} nere · ${cw} bianche</div>
      </div>
    </section>

    <details class="block add-cards" id="addDetails" ${S.addOpen ? "open" : ""}>
      <summary>Aggiungi le vostre carte</summary>
      <p class="muted">Una carta per riga. Nelle carte nere scrivi <b>___</b> dove va la risposta (anche due volte).</p>
      <div class="seg">
        <label><input type="radio" name="ctype" value="white" ${S.ctype === "white" ? "checked" : ""}><span>Bianche</span></label>
        <label><input type="radio" name="ctype" value="black" ${S.ctype === "black" ? "checked" : ""}><span>Nere</span></label>
      </div>
      <textarea id="customText" rows="4" placeholder="${S.ctype === "black" ? "Il vero motivo per cui Luca è sempre in ritardo: ___" : "Le ciabatte di Luca"}"></textarea>
      <button class="btn" data-action="addCards">Aggiungi alla stanza</button>
      <div class="row">
        <button class="btn ghost small" data-action="importJson">Importa mazzo .json</button>
        ${nSaved ? `<button class="btn ghost small" data-action="addSaved">Le mie carte salvate (${nSaved})</button>` : ""}
      </div>
      <input type="file" id="fileInput" accept=".json,application/json" hidden>
    </details>

    <div class="bottom-bar">
      ${host
        ? `<button class="btn primary big" data-action="start" ${online.length < MIN_PLAYERS ? "disabled" : ""}>Inizia la partita</button>`
        : `<p class="waiting">In attesa che ${esc(playerName(r.hostUid))} avvii la partita…</p>`}
      <button class="btn ghost" data-action="leave">Esci</button>
    </div>
  </main>`;
}

function gameHeader(r) {
  const st = r.state;
  const me = r.players[G.uid] || {};
  const judge = st.judgeUid === G.uid ? "Sei il giudice" : `Giudice: ${esc(playerName(st.judgeUid))}`;
  return `<header class="game-head">
    <div class="round">Round ${st.round}</div>
    <div class="judge">${judge}</div>
    <button class="score-btn" data-action="scores" aria-label="Apri il menu">
      <svg class="menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      ${me.score || 0} pt</button>
  </header>`;
}

function progress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="progress"><div style="width:${pct}%"></div></div>
    <p class="muted center-text">${done} su ${total} hanno risposto</p>`;
}

function viewGame() {
  const r = S.room;
  const st = r.state;
  const isJudge = st.judgeUid === G.uid;
  const pick = (st.black && st.black.pick) || 1;
  const subs = G.currentSubs(r);
  const exp = G.expected(r);
  const done = exp.filter((u) => subs[u]).length;
  const head = gameHeader(r);

  if (st.phase === "playing") {
    const mine = subs[G.uid];
    const cards = (S.hand && S.hand.gameId === st.gameId && S.hand.cards) || [];
    const chosen = S.selected.map((i) => cards[i]).filter(Boolean);

    if (isJudge) {
      return `<main class="screen game">${head}
        <div class="black-wrap"><div class="bcard">${fillHTML(st.black)}</div></div>
        <section class="status">
          <p class="big-msg">Questo round giudichi tu.</p>
          <p class="muted center-text">Aspetta le risposte, poi scegli la più bella.</p>
          ${progress(done, exp.length)}
          <ul class="waitlist">${exp.map((u) => `<li class="${subs[u] ? "ok" : ""}">${esc(playerName(u))}</li>`).join("")}</ul>
        </section>
        <div class="bottom-bar">
          <button class="btn primary big" data-action="reveal" ${done ? "" : "disabled"}>
            ${done < exp.length ? `Rivela adesso (${done}/${exp.length})` : "Rivela le risposte"}</button>
        </div>
      </main>`;
    }

    if (mine) {
      return `<main class="screen game">${head}
        <div class="black-wrap"><div class="bcard">${fillHTML(st.black, mine.cards)}</div></div>
        <section class="status">
          <p class="big-msg">Carta giocata!</p>
          ${progress(done, exp.length)}
          <p class="muted center-text">Quando hanno risposto tutti, ${esc(playerName(st.judgeUid))} rivela le carte.</p>
        </section>
      </main>`;
    }

    const handHTML = cards.length
      ? cards.map((c, i) => {
          const n = S.selected.indexOf(i);
          return `<button class="wcard ${n >= 0 ? "sel" : ""}" data-action="select" data-i="${i}">
            ${n >= 0 && pick > 1 ? `<span class="num">${n + 1}</span>` : ""}${esc(c)}</button>`;
        }).join("")
      : '<div class="center-text muted pad">Distribuisco le carte…</div>';

    return `<main class="screen game">${head}
      <div class="black-wrap sticky"><div class="bcard">${fillHTML(st.black, chosen)}</div>
        ${pick > 1 ? `<div class="pick-tag">Scegli ${pick} carte, nell'ordine</div>` : ""}</div>
      <div class="hand">${handHTML}</div>
      <div class="bottom-bar">
        <button class="btn primary big" data-action="submit" ${S.selected.length === pick ? "" : "disabled"}>
          ${pick > 1 ? `Gioca queste ${pick} carte` : "Gioca questa carta"}</button>
      </div>
    </main>`;
  }

  if (st.phase === "judging") {
    const answers = Object.entries(subs).sort((a, b) => hash(a[0] + st.round) - hash(b[0] + st.round));
    const list = answers.map(([u, s]) => isJudge
      ? `<button class="acard ${S.judgePick === u ? "sel" : ""}" data-action="pickAns" data-u="${u}">${fillHTML(st.black, s.cards)}</button>`
      : `<div class="acard">${fillHTML(st.black, s.cards)}</div>`).join("");
    return `<main class="screen game">${head}
      <p class="phase-msg">${isJudge ? "Leggi le risposte ad alta voce e tocca la migliore" : `${esc(playerName(st.judgeUid))} sta scegliendo…`}</p>
      <div class="answers">${list}</div>
      ${isJudge ? `<div class="bottom-bar"><button class="btn primary big" data-action="confirmWinner" ${S.judgePick ? "" : "disabled"}>Questa vince!</button></div>` : ""}
    </main>`;
  }

  // result
  const win = (r.settings && r.settings.winScore) || 7;
  const maxScore = Math.max(0, ...G.sortedPlayers(r).map((p) => p.score || 0));
  const isOver = maxScore >= win;
  const winnerMe = st.winnerUid === G.uid;
  const canNext = isJudge || isHost();
  return `<main class="screen game">${head}
    <section class="result">
      <div class="trophy">🏆</div>
      <h2>${winnerMe ? "Hai vinto il round!" : `Vince ${esc(playerName(st.winnerUid))}`}</h2>
      <div class="bcard big pop">${fillHTML(st.black, st.winnerCards)}</div>
    </section>
    ${ranking(r, 4)}
    <div class="bottom-bar">
      ${canNext
        ? `<button class="btn primary big" data-action="next">${isOver ? "Classifica finale" : "Prossimo round"}</button>`
        : `<p class="waiting">In attesa di ${esc(playerName(st.judgeUid))}…</p>`}
    </div>
  </main>`;
}

function ranking(r, limit) {
  const list = G.sortedPlayers(r).sort((a, b) => (b.score || 0) - (a.score || 0));
  const shown = limit ? list.slice(0, limit) : list;
  return `<ol class="ranking">${shown.map((p) => `
    <li class="${p.uid === G.uid ? "me" : ""} ${p.online === false ? "off" : ""}">
      <span class="pname">${esc(p.name)}${p.uid === r.state.judgeUid && r.state.phase !== "end" ? ' <span class="badge">giudice</span>' : ""}</span>
      <span class="pts">${p.score || 0}</span>
    </li>`).join("")}</ol>`;
}

function viewEnd() {
  const r = S.room;
  const list = G.sortedPlayers(r).sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = list[0];
  return `<main class="screen end">
    <section class="result">
      <div class="trophy">👑</div>
      <h2>${top && top.uid === G.uid ? "Hai vinto la partita!" : `${esc(top ? top.name : "?")} vince la partita`}</h2>
      <p class="muted center-text">Ora potete smettere di parlarvi.</p>
    </section>
    ${ranking(r)}
    <div class="bottom-bar">
      ${isHost() ? '<button class="btn primary big" data-action="lobby">Nuova partita</button>'
        : '<p class="waiting">L\'host può avviare una nuova partita</p>'}
      <button class="btn ghost" data-action="leave">Esci</button>
    </div>
  </main>`;
}

function viewScores() {
  const r = S.room;
  const hostOffline = r.players[r.hostUid] && r.players[r.hostUid].online === false;
  return `<div class="sheet-backdrop" data-action="closeScores"></div>
  <div class="sheet" role="dialog" aria-label="Menu">
    <div class="sheet-grip"></div>
    <div class="sheet-head">
      <h2>Menu</h2>
      <button class="close-btn" data-action="closeScores" aria-label="Chiudi">✕</button>
    </div>
    <h3>Classifica <small class="muted">· vince chi arriva a ${(r.settings && r.settings.winScore) || 7}</small></h3>
    ${ranking(r)}
    <h3>Azioni</h3>
    <div class="sheet-actions">
      <button class="btn" data-action="share">Invita altri</button>
      ${isHost() ? `<button class="btn" data-action="skip">Salta questo round</button>
        <button class="btn" data-action="endGame">Termina partita</button>` : ""}
      ${hostOffline && !isHost() ? '<button class="btn" data-action="becomeHost">L\'host è offline: diventa host</button>' : ""}
      <button class="btn ghost" data-action="leave">Esci dalla stanza</button>
    </div>
  </div>`;
}

// ---------- stanza ----------
function enterRoom(code) {
  S.code = code;
  S.screen = "room";
  S.room = null;
  S.hand = null;
  S.handLoaded = false;
  S.prev = {};
  LS.set("lastRoom", code);
  const url = new URL(location.href);
  url.searchParams.set("r", code);
  history.replaceState(null, "", url);
  if (disconnect) disconnect();
  disconnect = G.connect(code, onRoom, onHand);
  keepAwake();
  render(true);
}

function exitRoom(msg) {
  if (disconnect) disconnect();
  disconnect = null;
  LS.del("lastRoom");
  S.code = null;
  S.room = null;
  S.showScores = false;
  S.screen = "home";
  S.prefillCode = "";
  const url = new URL(location.href);
  url.searchParams.delete("r");
  history.replaceState(null, "", url);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  render(true);
  if (msg) toast(msg);
}

function onRoom(room) {
  if (!room || !room.hostUid) return exitRoom("La stanza non esiste più");
  if (!room.players || !room.players[G.uid]) return exitRoom("Sei uscito dalla stanza");
  S.room = room;
  const st = room.state || {};
  const p = S.prev;

  if (st.round !== p.round) S.selected = [];
  if (st.round !== p.round || st.phase !== p.phase) S.judgePick = null;
  if (p.phase && st.phase !== p.phase) {
    if (st.phase === "playing" && st.judgeUid === G.uid) buzz([60, 40, 60]);
    if (st.phase === "judging" && st.judgeUid === G.uid) buzz(200);
    if (st.phase === "result" && st.winnerUid === G.uid) buzz([100, 50, 100, 50, 300]);
  }
  S.prev = { round: st.round, phase: st.phase };

  // Il giudice rivela da solo quando hanno risposto tutti
  if (st.phase === "playing" && st.judgeUid === G.uid) {
    const exp = G.expected(room);
    const subs = G.currentSubs(room);
    if (exp.length && exp.every((u) => subs[u])) G.reveal(S.code, st.round).catch(console.error);
  }
  ensureHand();
  render();
}

function onHand(hand) {
  S.hand = hand;
  S.handLoaded = true;
  ensureHand();
  render();
}

function ensureHand() {
  const r = S.room;
  if (!r || !r.state || !S.handLoaded || drawing) return;
  if (!["playing", "judging", "result"].includes(r.state.phase)) return;
  if (!r.deck || !r.deck.white) return;
  const size = (r.settings && r.settings.handSize) || 10;
  const cards = S.hand && S.hand.gameId === r.state.gameId ? (S.hand.cards || []) : [];
  if (cards.length >= size) return;
  drawing = true;
  G.drawInto(S.code, r, cards, size)
    .catch((e) => { console.error(e); toast("Errore nel pescare le carte"); })
    .finally(() => { drawing = false; });
}

async function shareRoom() {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("r", S.code);
  const text = `Vieni a giocare a Carte Infami! Codice stanza: ${S.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Carte Infami", text, url: url.toString() }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast("Link copiato"); }
  catch { toast(`Codice: ${S.code}`); }
}

function buildDeck() {
  const r = S.room;
  const chosen = (r.settings && r.settings.decks) || ["base"];
  let white = [];
  let black = [];
  for (const id of chosen) {
    const d = S.decks[id];
    if (d) { white = white.concat(d.white); black = black.concat(d.black); }
  }
  const c = r.custom || {};
  white = white.concat(Object.values(c.white || {}).map(normWhite).filter(Boolean));
  black = black.concat(Object.values(c.black || {}).map(normBlack).filter(Boolean));
  white = [...new Set(white)];
  return { white: shuffle(white), black: shuffle(black) };
}

function saveMine(type, items) {
  const saved = LS.get("mieCarte", { white: [], black: [] });
  const key = (x) => (typeof x === "string" ? x : x.text);
  const have = new Set(saved[type].map(key));
  for (const it of items) if (!have.has(key(it))) saved[type].push(it);
  LS.set("mieCarte", saved);
}

async function importDeck(file) {
  if (!file) return;
  if (file.size > 1024 * 1024) return toast("File troppo grande");
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("Il file non è un JSON valido"); }
  const black = (data.black || []).map(normBlack).filter(Boolean).slice(0, 1000);
  const white = (data.white || []).map(normWhite).filter(Boolean).slice(0, 3000);
  if (!black.length && !white.length) return toast("Nessuna carta trovata nel file");
  if (black.length) await G.addCustom(S.code, "black", black);
  if (white.length) await G.addCustom(S.code, "white", white);
  toast(`Aggiunte ${black.length} nere e ${white.length} bianche`);
}

// ---------- azioni ----------
function getName() {
  const name = (document.getElementById("nameInput")?.value || "").trim().slice(0, 16);
  if (!name) { toast("Scrivi prima il tuo nome"); document.getElementById("nameInput")?.focus(); return null; }
  LS.set("name", name);
  return name;
}

const ACTIONS = {
  async create() {
    const name = getName(); if (!name) return;
    const code = await G.createRoom(name);
    enterRoom(code);
  },
  async join() {
    const name = getName(); if (!name) return;
    const code = (document.getElementById("codeInput")?.value || "").trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return toast("Il codice è di 4 lettere");
    await G.joinRoom(code, name);
    enterRoom(code);
  },
  share: shareRoom,
  async copyCode() {
    try { await navigator.clipboard.writeText(S.code); toast("Codice copiato"); } catch { /* ok */ }
  },
  setWin(el) { return G.setSetting(S.code, "winScore", Number(el.dataset.v)); },
  toggleDeck(el) {
    const cur = new Set((S.room.settings && S.room.settings.decks) || ["base"]);
    if (el.checked) cur.add(el.dataset.id); else cur.delete(el.dataset.id);
    return G.setSetting(S.code, "decks", [...cur]);
  },
  async addCards() {
    const ta = document.getElementById("customText");
    const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 200);
    if (!lines.length) return toast("Scrivi almeno una carta");
    const items = S.ctype === "black"
      ? lines.map((l) => normBlack(l.replace(/(^|[^_])_{1,2}(?!_)/g, "$1___")))
      : lines.map(normWhite);
    await G.addCustom(S.code, S.ctype, items);
    saveMine(S.ctype, items);
    ta.value = "";
    toast(`${items.length} ${items.length === 1 ? "carta aggiunta" : "carte aggiunte"}`);
    render(true);
  },
  importJson() { document.getElementById("fileInput")?.click(); },
  async addSaved() {
    const saved = LS.get("mieCarte", { white: [], black: [] });
    const c = S.room.custom || {};
    const haveW = new Set(Object.values(c.white || {}));
    const haveB = new Set(Object.values(c.black || {}).map((b) => b.text));
    const w = saved.white.filter((x) => !haveW.has(x));
    const b = saved.black.filter((x) => !haveB.has(x.text));
    if (!w.length && !b.length) return toast("Sono già tutte nella stanza");
    if (w.length) await G.addCustom(S.code, "white", w);
    if (b.length) await G.addCustom(S.code, "black", b);
    toast(`Aggiunte ${w.length + b.length} carte`);
  },
  async start() {
    const { white, black } = buildDeck();
    if (black.length < 3 || white.length < 40) return toast("Servono più carte: attiva un mazzo o aggiungine");
    await G.startGame(S.code, S.room, white, black);
  },
  select(el) {
    const i = Number(el.dataset.i);
    const pick = (S.room.state.black && S.room.state.black.pick) || 1;
    const at = S.selected.indexOf(i);
    if (at >= 0) S.selected.splice(at, 1);
    else if (pick === 1) S.selected = [i];
    else if (S.selected.length < pick) S.selected.push(i);
    else { S.selected.shift(); S.selected.push(i); }
    buzz(10);
    render(true);
  },
  async submit() {
    const r = S.room;
    const cards = (S.hand && S.hand.gameId === r.state.gameId && S.hand.cards) || [];
    const pick = (r.state.black && r.state.black.pick) || 1;
    if (S.selected.length !== pick) return;
    drawing = true;
    try { await G.submit(S.code, r, cards, [...S.selected]); }
    finally { drawing = false; }
    S.selected = [];
    render(true);
  },
  reveal() { return G.reveal(S.code, S.room.state.round); },
  pickAns(el) { S.judgePick = el.dataset.u; buzz(10); render(true); },
  async confirmWinner() {
    const r = S.room;
    const sub = G.currentSubs(r)[S.judgePick];
    if (!sub) return;
    await G.pickWinner(S.code, r.state.round, S.judgePick, sub.cards);
  },
  next() { return G.nextRound(S.code, S.room); },
  async skip() {
    if (!confirm("Saltare questo round? Le carte già giocate vanno perse.")) return;
    S.showScores = false;
    await G.nextRound(S.code, S.room, true);
  },
  async endGame() {
    if (!confirm("Terminare la partita adesso? Si passa alla classifica finale.")) return;
    S.showScores = false;
    await G.endGame(S.code);
  },
  lobby() { return G.backToLobby(S.code); },
  async becomeHost() { await G.becomeHost(S.code); toast("Ora sei l'host"); },
  scores() { S.showScores = true; render(true); },
  closeScores() { S.showScores = false; render(true); },
  async leave() {
    if (!confirm("Vuoi uscire dalla stanza?")) return;
    const code = S.code;
    const room = S.room;
    if (disconnect) disconnect();
    disconnect = null;
    await G.leave(code, room);
    exitRoom();
  },
};

const locks = new Set();
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const fn = ACTIONS[a];
  if (!fn || locks.has(a)) return;
  locks.add(a);
  try { await fn(el, e); }
  catch (err) { console.error(err); toast(err.message || "Qualcosa è andato storto"); }
  finally { locks.delete(a); }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "ctype") { S.ctype = t.value; render(true); }
  if (t.id === "fileInput") {
    importDeck(t.files[0]).catch((err) => toast(err.message));
    t.value = "";
  }
});

document.addEventListener("toggle", (e) => {
  if (e.target.id === "addDetails") S.addOpen = e.target.open;
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "codeInput") ACTIONS.join().catch((err) => toast(err.message));
  if (e.target.id === "nameInput") e.target.blur();
});

// ---------- avvio ----------
async function loadDecks() {
  await Promise.all(DECKS.map(async (d) => {
    try {
      const data = await (await fetch(d.file)).json();
      S.decks[d.id] = {
        black: (data.black || []).map(normBlack).filter(Boolean),
        white: (data.white || []).map(normWhite).filter(Boolean),
      };
    } catch (e) { console.error("Mazzo non caricato", d.file, e); }
  }));
}

async function boot() {
  render(true);
  if (!G.isConfigured) { S.screen = "setup"; return render(true); }
  try {
    await G.init();
  } catch (e) {
    console.error(e);
    S.error = "Non riesco a collegarmi. Controlla la connessione e la configurazione Firebase.";
    S.screen = "error";
    return render(true);
  }
  await loadDecks();
  const urlCode = (new URLSearchParams(location.search).get("r") || "").toUpperCase();
  const candidates = [...new Set([urlCode, LS.get("lastRoom", "")].filter(Boolean))];
  for (const code of candidates) {
    try {
      const room = await G.getRoom(code);
      if (room && room.players && room.players[G.uid]) {
        await G.joinRoom(code, room.players[G.uid].name);
        return enterRoom(code);
      }
    } catch (e) { console.warn(e); }
  }
  S.prefillCode = /^[A-Z]{4}$/.test(urlCode) ? urlCode : "";
  S.screen = "home";
  render(true);
}

boot();
