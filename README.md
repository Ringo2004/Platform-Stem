# Platform STEM

Piattaforma didattica sulle macchine a fluido, con modelli 3D sezionabili (Three.js) utilizzabili da computer e da iPad.

| Modulo | Macchina | Dati |
| --- | --- | --- |
| Modulo 1 | Turbogas aeroderivativo **GE LM2500** | `src/machines/lm2500.json` |
| Modulo 2 | Motore a benzina, ciclo Otto, **FIAT FIRE 1.2 8V** (169A4000) | `src/machines/fire12.json` |
| Modulo 3 | Compressore centrifugo con girante **Eckardt O** e simulazione del flusso | `src/machines/eckardt.json` |
| Modulo 4 | **Impianto di sollevamento** con pompa centrifuga o assiale, in serie o in parallelo | `src/machines/sollevamento.json`, `pompa-centrifuga.json`, `pompa-assiale.json` |

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

Nel modulo del compressore centrifugo il pannello **Simulazione del flusso** mostra frecce che si muovono lungo
48 linee di corrente con la velocità calcolata e un colore che segue temperatura, pressione o velocità del fluido.
Giri e portata si possono cambiare: si aggiornano rapporto di compressione, lavoro, potenza, rendimento, i
triangoli di velocità in ingresso e in uscita dalla girante e gli avvisi di pompaggio e blocco sonico.
Il modello (`src/explore/flow.ts`) è monodimensionale lungo le linee di corrente: continuità, equazione di Eulero
con fattore di scorrimento, conservazione del momento della quantità di moto nel diffusore e perdite tramite i
rendimenti. Non è una CFD vera e propria, ma nel punto di progetto riproduce i dati misurati da Eckardt
(β = 2,094, η ≈ 88 %).

Il modulo dell'impianto di sollevamento porta l'acqua da un bacino di valle a uno di monte. Nel pannello
**Impianto di sollevamento** si sceglie:

- la vista: **Impianto** (bacini, tubazioni, valvole, pompe) oppure **Pompa singola** (la macchina in sezione con
  l'acqua che la attraversa, i triangoli di velocità e le bolle di vapore quando cavita);
- la macchina: pompa **centrifuga** (200 L/s, 28 m, 1.450 giri/min) o **assiale** a elica (300 L/s, 5 m, 980 giri/min);
- il numero di pompe (1–4) e il collegamento **in serie** o **in parallelo**;
- i giri, il **salto geodetico** (0–40 m) e la **quota della pompa** sul pelo libero di valle (da −5 m, sotto
  battente, a +9 m);
- la **portata imposta** strozzando la valvola di regolazione.

I diagrammi mostrano sullo stesso grafico la curva delle pompe e quella dell'impianto con il punto di
funzionamento, poi rendimento, potenza assorbita e NPSH (disponibile, richiesto e di inizio cavitazione); il
cursore che segue il puntatore li attraversa tutti e una tabella riporta i valori. Il modello (`src/explore/pump.ts`)
usa curve caratteristiche adimensionali tipiche, leggi di affinità, perdite di Darcy-Weisbach (fattore d'attrito di
Swamee-Jain) e coefficienti K di uso comune; la geometria dell'impianto è generata da `src/explore/plant.ts` e
cambia con i parametri. Alzando la pompa l'NPSH disponibile cala: compaiono prima le bolle (cavitazione incipiente),
poi la prevalenza crolla e la curva della pompa viene troncata.

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
src/explore/flow.ts        simulazione semplificata del flusso, frecce animate, triangoli di velocità
src/explore/pump.ts        modello idraulico di pompe e impianto: curve, perdite, punto di funzionamento, NPSH
src/explore/plant.ts       modello 3D dell'impianto di sollevamento, generato dai parametri
src/explore/pumpflow.ts    flusso d'acqua nella pompa singola e bolle di cavitazione
src/explore/chart.ts       diagrammi H–Q, rendimento, potenza e NPSH
src/explore/geom.ts        funzioni geometriche condivise (chiocciola, superfici a griglia)
src/pages/theory.ts        sezione Teoria
src/pages/practice.ts      sezione Esercitati
src/machines/lm2500.json   modulo 1: geometria, componenti, testi, valori
src/machines/fire12.json   modulo 2: motore a benzina FIAT FIRE 1.2 8V
src/machines/eckardt.json  modulo 3: compressore centrifugo Eckardt O
src/machines/sollevamento.json      modulo 4: impianto di sollevamento (tubazioni, perdite, disposizione)
src/machines/pompa-centrifuga.json  modulo 4: pompa centrifuga (geometria, curve, flusso)
src/machines/pompa-assiale.json     modulo 4: pompa assiale (geometria, curve, flusso)
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
     per i motori alternativi;
   - macchine radiali: girante `impeller` (pale tra profilo del mozzo e della cassa; `wrapM` per pale curve
     all'indietro), chiocciola `volute` e blocco `flow` per la simulazione del flusso;
   - pompe di un impianto: blocco `pump` (curve, geometria dei triangoli, flange, flusso) e, nel file
     dell'impianto, blocco `plant` con tubazioni, coefficienti di perdita e macchine collegate.
2. Aggiungi la voce in `src/machines/index.ts` (comparirà nel menu dei moduli).
3. La macchina sarà raggiungibile con `#/esplora/<id>`, `#/teoria/<id>`, `#/esercitati/<id>`.

## Sviluppo in locale (facoltativo)

Serve Node.js 22 o successivo.

```bash
npm install
npm run dev      # server di sviluppo
npm run build    # controllo dei tipi e compilazione in dist/
```
