# Platform STEM

Piattaforma didattica sulle macchine a fluido. Prima macchina: il turbogas aeroderivativo **GE LM2500**
in 3D sezionabile (Three.js), utilizzabile da computer e da iPad.

Il sito ha tre sezioni, raggiungibili dalle schede in alto:

| Scheda | Indirizzo | Contenuto |
| --- | --- | --- |
| **Esplora** | `#/esplora` | modello 3D a tutto schermo: taglio, vista esplosa, mappa temperature, schede dei componenti |
| **Esercitati** | `#/esercitati` | pagina segnaposto (esercizi in preparazione) |
| **Teoria** | `#/teoria` | pagina provvisoria con i testi delle schede, raggruppati per sezione |

Un componente si può aprire direttamente con un link, ad esempio `#/esplora/lm2500?c=hpc_rotor`.

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
src/machines/lm2500.json   dati della macchina: geometria, componenti, testi, valori
src/machines/types.ts      formato dei file macchina (commentato)
src/machines/index.ts      elenco delle macchine disponibili
public/                    icone e manifest (installazione su schermata Home dell'iPad)
prototipo/                 il prototipo originale in un solo file HTML, per riferimento
```

## Aggiungere una macchina

1. Copia `src/machines/lm2500.json` in `src/machines/<id>.json` e modificalo. Il formato è descritto in
   `src/machines/types.ts`: testi delle schede (`overview`, `components[].text`, `facts`, `course`),
   condotto del flusso (`flowPath`), stazioni del ciclo, colori, e per ogni componente le sue parti
   geometriche (`revolve`, `row`, `torus`, `cylinder`, `box`, `instances`, `splitFlanges`).
2. Aggiungi la voce in `src/machines/index.ts`.
3. La macchina sarà raggiungibile con `#/esplora/<id>`, `#/teoria/<id>`, `#/esercitati/<id>`.

## Sviluppo in locale (facoltativo)

Serve Node.js 22 o successivo.

```bash
npm install
npm run dev      # server di sviluppo
npm run build    # controllo dei tipi e compilazione in dist/
```
