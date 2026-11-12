// Logica di rete: tutte le letture/scritture su Firebase Realtime Database.
// Il gioco non ha un server: ogni azione la fa il telefono del giocatore a cui tocca
// (chi gioca le carte, il giudice che rivela e sceglie, l'host che avvia).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, inMemoryPersistence, browserLocalPersistence,
  indexedDBLocalPersistence, signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, set, get, update, onValue, onDisconnect,
  runTransaction, serverTimestamp, push, query, orderByChild, endAt, limitToFirst,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

export const isConfigured =
  !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("INSERISCI");

// ?test nell'URL: ogni scheda del browser diventa un giocatore diverso (per provare da soli)
export const testMode = new URLSearchParams(location.search).has("test");

const ROOM_TTL_MS = 18 * 3600 * 1000; // le stanze più vecchie vengono ripulite
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

let db;
export let uid = null;

export async function init() {
  const app = initializeApp(firebaseConfig);
  const auth = testMode
    ? initializeAuth(app, { persistence: inMemoryPersistence })
    : initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = getDatabase(app);
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  uid = auth.currentUser.uid;
}

const roomRef = (code, path = "") => ref(db, `rooms/${code}${path ? "/" + path : ""}`);

function randomCode() {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

export async function getRoom(code) {
  const s = await get(roomRef(code));
  return s.val();
}

export async function createRoom(name) {
  let code;
  for (let i = 0; i < 10; i++) {
    code = randomCode();
    if (!(await get(roomRef(code, "hostUid"))).exists()) break;
  }
  await set(roomRef(code), {
    hostUid: uid,
    createdAt: serverTimestamp(),
    settings: { winScore: 7, handSize: 10, decks: ["base"] },
    state: { phase: "lobby", round: 0 },
    players: { [uid]: { name, score: 0, joinedAt: Date.now(), online: true } },
  });
  cleanupOldRooms();
  return code;
}

export async function joinRoom(code, name) {
  const room = await getRoom(code);
  if (!room || !room.hostUid) throw new Error("Stanza non trovata");
  const me = room.players && room.players[uid];
  if (me) {
    await update(roomRef(code, `players/${uid}`), { name, online: true });
  } else {
    await set(roomRef(code, `players/${uid}`), { name, score: 0, joinedAt: Date.now(), online: true });
  }
}

// Ascolta la stanza e la propria mano; gestisce la presenza (online/offline).
export function connect(code, onRoom, onHand) {
  const meOnline = roomRef(code, `players/${uid}/online`);
  const unsubs = [
    onValue(ref(db, ".info/connected"), (s) => {
      if (s.val() === true) {
        onDisconnect(meOnline).set(false).then(() => set(meOnline, true));
      }
    }),
    onValue(roomRef(code), (s) => onRoom(s.val())),
    onValue(ref(db, `hands/${code}/${uid}`), (s) => onHand(s.val())),
  ];
  return () => {
    unsubs.forEach((u) => u());
    onDisconnect(meOnline).cancel();
  };
}

export async function leave(code, room) {
  const updates = { [`rooms/${code}/players/${uid}`]: null, [`hands/${code}/${uid}`]: null };
  if (room && room.hostUid === uid) {
    const other = sortedPlayers(room).find((p) => p.uid !== uid && p.online !== false)
      || sortedPlayers(room).find((p) => p.uid !== uid);
    if (other) updates[`rooms/${code}/hostUid`] = other.uid;
  }
  await update(ref(db), updates);
}

export function becomeHost(code) {
  return set(roomRef(code, "hostUid"), uid);
}

export function setSetting(code, key, value) {
  return set(roomRef(code, `settings/${key}`), value);
}

export function addCustom(code, type, items) {
  const updates = {};
  for (const it of items) {
    const k = push(roomRef(code, `custom/${type}`)).key;
    updates[`rooms/${code}/custom/${type}/${k}`] = it;
  }
  return update(ref(db), updates);
}

// ---------- utilità condivise con la UI ----------
export function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .filter(([, p]) => p && p.name)
    .map(([id, p]) => ({ uid: id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

export function currentSubs(room) {
  const round = room.state && room.state.round;
  const out = {};
  for (const [id, s] of Object.entries(room.submissions || {})) {
    if (s && s.round === round) out[id] = s;
  }
  return out;
}

// Giocatori che devono rispondere in questo round (online, non giudice)
export function expected(room) {
  return sortedPlayers(room)
    .filter((p) => p.online !== false && p.uid !== room.state.judgeUid)
    .map((p) => p.uid);
}

function nextJudge(room) {
  const all = sortedPlayers(room);
  const online = all.filter((p) => p.online !== false);
  if (!online.length) return room.state.judgeUid;
  const idx = all.findIndex((p) => p.uid === room.state.judgeUid);
  for (let i = 1; i <= all.length; i++) {
    const p = all[(idx + i) % all.length];
    if (p.online !== false) return p.uid;
  }
  return online[0].uid;
}

// ---------- partita ----------
export async function startGame(code, room, white, black) {
  const players = sortedPlayers(room).filter((p) => p.online !== false);
  const updates = {
    [`rooms/${code}/deck`]: { white, black, wi: 0, bi: 1 },
    [`rooms/${code}/state`]: {
      phase: "playing", round: 1, judgeUid: players[0].uid, black: black[0],
      gameId: Date.now().toString(36),
    },
    [`rooms/${code}/submissions`]: null,
  };
  for (const p of sortedPlayers(room)) updates[`rooms/${code}/players/${p.uid}/score`] = 0;
  await update(ref(db), updates);
}

// Pesca carte dal mazzo condiviso (la transazione evita che due giocatori prendano le stesse)
export async function drawInto(code, room, cards, size) {
  const n = size - cards.length;
  if (n <= 0) return;
  const res = await runTransaction(roomRef(code, "deck/wi"), (cur) => (cur || 0) + n);
  const start = res.snapshot.val() - n;
  const w = room.deck.white;
  const drawn = Array.from({ length: n }, (_, i) => w[(start + i) % w.length]);
  await set(ref(db, `hands/${code}/${uid}`), { gameId: room.state.gameId, cards: [...cards, ...drawn] });
}

export async function submit(code, room, handCards, indices) {
  const chosen = indices.map((i) => handCards[i]);
  await set(roomRef(code, `submissions/${uid}`), { cards: chosen, round: room.state.round });
  const rest = handCards.filter((_, i) => !indices.includes(i));
  await drawInto(code, room, rest, room.settings.handSize || 10);
}

export function reveal(code, round) {
  return runTransaction(roomRef(code, "state"), (s) => {
    if (!s) return s;
    if (s.phase !== "playing" || s.round !== round) return; // annulla
    return { ...s, phase: "judging" };
  });
}

export async function pickWinner(code, round, winnerUid, cards) {
  const res = await runTransaction(roomRef(code, "state"), (s) => {
    if (!s) return s;
    if (s.phase !== "judging" || s.round !== round) return;
    return { ...s, phase: "result", winnerUid, winnerCards: cards };
  });
  if (res.committed) {
    await runTransaction(roomRef(code, `players/${winnerUid}/score`), (v) => (v || 0) + 1);
  }
}

// Passa al round successivo (o alla classifica finale). force = salta il round in corso.
export async function nextRound(code, room, force = false) {
  const round = room.state.round;
  const win = (room.settings && room.settings.winScore) || 7;
  const maxScore = Math.max(0, ...sortedPlayers(room).map((p) => p.score || 0));
  const bi = room.deck.bi || 0;
  const black = room.deck.black[bi % room.deck.black.length];
  const judgeUid = nextJudge(room);
  const res = await runTransaction(roomRef(code, "state"), (s) => {
    if (!s) return s;
    if (s.round !== round) return;
    if (!force && s.phase !== "result") return;
    if (!force && maxScore >= win) return { ...s, phase: "end" };
    return {
      phase: "playing", round: round + 1, judgeUid, black, gameId: s.gameId,
    };
  });
  if (res.committed && res.snapshot.val().phase === "playing") {
    await update(ref(db), {
      [`rooms/${code}/deck/bi`]: bi + 1,
      [`rooms/${code}/submissions`]: null,
    });
  }
}

export function endGame(code) {
  return set(roomRef(code, "state/phase"), "end");
}

export function backToLobby(code) {
  return update(roomRef(code), {
    state: { phase: "lobby", round: 0 },
    deck: null,
    submissions: null,
  });
}

async function cleanupOldRooms() {
  try {
    const q = query(ref(db, "rooms"), orderByChild("createdAt"),
      endAt(Date.now() - ROOM_TTL_MS), limitToFirst(20));
    const s = await get(q);
    const updates = {};
    s.forEach((c) => {
      updates[`rooms/${c.key}`] = null;
      updates[`hands/${c.key}`] = null;
    });
    if (Object.keys(updates).length) await update(ref(db), updates);
  } catch (e) {
    console.warn("Pulizia stanze non riuscita", e);
  }
}

