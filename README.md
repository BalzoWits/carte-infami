# Carte Infami

Party game da giocare col telefono: a ogni round un giocatore fa da giudice e scopre una carta nera
con uno spazio vuoto, gli altri lo riempiono con la carta bianca più assurda che hanno in mano,
il giudice sceglie la migliore. Vince chi arriva per primo ai punti stabiliti.

App statica (HTML/CSS/JS senza build) pubblicata su GitHub Pages; lo stato della partita
è condiviso in tempo reale con Firebase Realtime Database (piano gratuito Spark).

## 1. Crea il progetto Firebase (una volta sola, ~5 minuti)

1. Vai su <https://console.firebase.google.com> → **Aggiungi progetto** (Google Analytics non serve).
2. **Build → Authentication → Inizia** → scheda *Metodo di accesso* → abilita **Anonimo**.
3. **Build → Realtime Database → Crea database** → posizione **europe-west1 (Belgio)** →
   avvia in **modalità bloccata**.
4. Nella scheda **Regole** del database incolla il contenuto di `database.rules.json` → **Pubblica**.
5. **⚙ Impostazioni progetto → Le tue app → icona Web `</>`** → registra l'app
   (Firebase Hosting non serve) → copia i valori di `firebaseConfig` in `js/firebase-config.js`.
   Controlla che ci sia anche `databaseURL`.

Il piano Spark non chiede carta di credito: se un mese si superassero i limiti
(100 connessioni contemporanee, 10 GB scaricati) il servizio si ferma, non si paga nulla.
Le stanze più vecchie di 18 ore vengono cancellate in automatico quando se ne crea una nuova.

## 2. Prova in locale

```bash
python -m http.server 8080
```

Apri <http://localhost:8080/?test> in **tre schede**: con `?test` ogni scheda è un giocatore
diverso (senza, le schede dello stesso browser sono lo stesso giocatore).

## 3. Pubblica su GitHub Pages

```bash
git init
git add .
git commit -m "Prima versione"
git branch -M main
git remote add origin https://github.com/<tuo-utente>/carte-infami.git
git push -u origin main
```

Poi su GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
Dopo un minuto il gioco è su `https://<tuo-utente>.github.io/carte-infami/`.

Consigliato: in Firebase **Authentication → Impostazioni → Domini autorizzati** aggiungi
`<tuo-utente>.github.io`.

## Come si gioca

- Uno crea la stanza e tocca **Invita** per mandare link o codice di 4 lettere.
- Servono almeno 3 giocatori. L'host sceglie i punti per vincere e i mazzi, poi **Inizia**.
- Chi non è giudice tocca 1 carta (o 2, nell'ordine, se la carta nera lo chiede) e preme **Gioca**.
- Quando hanno risposto tutti le risposte compaiono anonime: il giudice le legge ad alta voce e sceglie.
- Il punteggio (in alto a destra) apre la classifica; da lì l'host può saltare un round
  (es. giudice sparito) o terminare la partita.
- Se il telefono va in standby o si chiude il browser, riaprendo il link si rientra con la stessa mano.
- Da Safari/Chrome: **Aggiungi a schermata Home** per averla a schermo intero come un'app.

## Mazzi

I mazzi inclusi sono `decks/base.json` (Base italiano) e `decks/italia.json`
(Italia pop: politica, TV, sport e costume). Altri mazzi si aggiungono:

- **dalla lobby**, scrivendo carte una per riga (nelle nere `___` indica lo spazio) — restano
  salvate anche sul tuo telefono per le partite successive;
- **importando un file `.json`** con questo formato:

```json
{
  "name": "Il mio mazzo",
  "black": [
    { "text": "Il vero motivo per cui Luca è sempre in ritardo: ___.", "pick": 1 },
    { "text": "___ e ___: la coppia dell'anno.", "pick": 2 }
  ],
  "white": ["Le ciabatte di Luca", "Un altro caffè"]
}
```

Per aggiungere un mazzo fisso all'app: metti il file in `decks/` e aggiungilo all'array `DECKS`
in cima a `js/app.js`.

## Struttura

| File | Cosa contiene |
|---|---|
| `index.html` | pagina unica |
| `css/style.css` | stile (solo tema scuro, pensato per il telefono) |
| `js/app.js` | interfaccia: schermate, tocchi, stato locale |
| `js/game.js` | logica di rete su Firebase (stanze, mazzo, round, punteggi) |
| `js/firebase-config.js` | configurazione del tuo progetto Firebase |
| `database.rules.json` | regole di sicurezza: le carte in mano le legge solo il proprietario |
| `sw.js`, `manifest.webmanifest`, `icons/` | installazione come app (PWA) |
