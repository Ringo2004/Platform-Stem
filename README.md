# Platform STEM

Piattaforma didattica sulle macchine a fluido, con modelli 3D sezionabili (Three.js) utilizzabili da computer e da iPad.

| Modulo | Macchina | Dati |
| --- | --- | --- |
| Modulo 1 | Turbogas aeroderivativo **GE LM2500** | `src/machines/lm2500.json` |
| Modulo 2 | Motore a benzina, ciclo Otto, **FIAT FIRE 1.2 8V** (169A4000) | `src/machines/fire12.json` |

Il modulo si sceglie dal menu in alto a destra; la scheda aperta (Esplora, Esercitati, Teoria) resta la stessa.

Il sito ha tre sezioni, raggiungibili dalle schede in alto:

| Scheda | Indirizzo | Contenuto |
| --- | --- | --- |
| **Esplora** | `#/esplora` | modello 3D a tutto schermo: taglio, vista esplosa, mappa temperature, schede dei componenti |
| **Esercitati** | `#/esercitati` | pagina segnaposto (esercizi in preparazione) |
| **Teoria** | `#/teoria` | pagina provvisoria con i testi delle schede, raggruppati per sezione |

Un componente si può aprire direttamente con un link, ad esempio `#/esplora/lm2500?c=hpc_rotor` o
`#/esplora/fire12?c=albero_motore`.

Nel modulo del motore a benzina il pannello **Ciclo Otto a quattro tempi** ha il cursore dell'angolo di manovella
(0–720°) e mostra la fase di ogni cilindro; nel modello la colonna di gas nei cilindri cambia colore con la fase.
Pistoni, bielle, valvole, molle e pulegge si muovono in modo coerente con l'albero motore.

## Pubblicazione

A ogni modifica del ramo `main` il workflow `.github/workflows/deploy.yml` compila il progetto e lo pubblica su
GitHub Pages: <https://ringo2004.github.io/Platform-Stem/>.

Impostazione da fare una sola volta su GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Il workflow si può anche avviare a mano da **Actions → Pubblica su GitHub Pages → Run workflow**.

## Struttura

```
index.html                 pagina unica (Vite)
src/main.ts                schede e navigazione
src/style.css              tema e layout (desktop, iPad orizzontale/verticale, telefono)
src/explore/explore.ts     sezione Esplora: renderer, comandi, selezione
src/explore/model.ts       costruisce le geometrie 3D a partire dai dati
src/pages/theory.ts        sezione Teoria
src/pages/practice.ts      sezione Esercitati
src/machines/lm2500.json   modulo 1: geometria, componenti, testi, valori
src/machines/fire12.json   modulo 2: motore a benzina FIAT FIRE 1.2 8V
src/machines/types.ts      formato dei file macchina (commentato)
src/machines/index.ts      elenco delle macchine disponibili
public/                    icone e manifest (installazione su schermata Home dell'iPad)
prototipo/                 il prototipo originale in un solo file HTML, per riferimento
```

## Aggiungere una macchina

1. Copia `src/machines/lm2500.json` in `src/machines/<id>.json` e modificalo. Il formato è descritto in
   `src/machines/types.ts`: testi delle schede (`overview`, `components[].text`, `facts`, `course`),
   colori e per ogni componente le sue parti geometriche:
   - turbomacchine: condotto del flusso (`flowPath`), `revolve`, `row` (schiere di pale), `torus`, `instances`, `splitFlanges`;
   - forme generiche: `extrude` (forme piane con fori: rettangoli, cerchi, inviluppi, settori, camme), `cylinder`,
     `box`, `bar` (cilindro tra due punti), `tube` (condotti e molle a elica);
   - parti mobili: alberi rotanti (`spools`, anche con asse fuori centro o trascinati con un rapporto),
     `motion` per pistoni, bielle e valvole (`kinematics`), colonna di gas `charge` e pannello `cycle`
     per i motori alternativi.
2. Aggiungi la voce in `src/machines/index.ts` (comparirà nel menu dei moduli).
3. La macchina sarà raggiungibile con `#/esplora/<id>`, `#/teoria/<id>`, `#/esercitati/<id>`.

## Sviluppo in locale (facoltativo)

Serve Node.js 22 o successivo.

```bash
npm install
npm run dev      # server di sviluppo
npm run build    # controllo dei tipi e compilazione in dist/
```
