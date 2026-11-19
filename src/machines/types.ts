/*
 * Formato dei file macchina (es. lm2500.json).
 *
 * Convenzioni geometriche
 * - L'asse della macchina è l'asse x (metri). Il flusso va da x minore a x maggiore.
 * - I profili da rivoluzionare si scrivono come coppie [r, x]: raggio, posizione assiale.
 * - "flowPath" descrive il condotto del flusso: [x, raggio mozzo, raggio esterno].
 *   I raggi { "ref": "hub" } e { "ref": "tip" } seguono questo condotto.
 * - Le temperature T (°C) servono alla "Mappa temperature".
 * - I colori sono un nome della "palette" oppure un codice "#rrggbb".
 * - Le parti mobili si descrivono nella posizione all'angolo 0 degli alberi ("spools"):
 *   il programma le muove con "spool" (rotazione) e "motion" (pistoni, bielle, valvole).
 * - Nelle forme 2D da estrudere le coordinate (u, v) dipendono dall'asse di estrusione:
 *   asse x → (u, v) = (y, z); asse y → (z, x); asse z → (x, y). Gli angoli sono in gradi,
 *   misurati da +u verso +v (per l'asse x: da +y verso +z, come la rotazione degli alberi).
 */

export type Vec3 = [number, number, number];
/** [etichetta, valore] */
export type Fact = [string, string];

export interface Card {
  /** Titolo della scheda */
  name: string;
  /** Sezione della macchina (Compressore, Combustione, ...) */
  section: string;
  text: string;
  facts: Fact[];
  /** Riquadro "Nel corso": collegamento al programma */
  course?: string;
}

export interface MaterialSpec {
  color: string;
  /** Temperatura indicativa del gas a contatto (°C) */
  T: number;
  metal?: number;
  rough?: number;
}
/** Nome di un materiale del componente oppure materiale definito sul posto */
export type MaterialRef = string | MaterialSpec;

/** Raggio in funzione di x */
export type RadiusSpec =
  | { ref: 'hub' | 'tip'; add?: number }
  /** spezzata [[x, r], ...], costante oltre gli estremi */
  | { points: [number, number][] }
  /** r = r0 + a · (x / xRef)^exp — per bocche a campana */
  | { bell: { r0: number; a: number; xRef: number; exp: number } };

export type Profile =
  /** guscio di spessore t (negativo = verso l'interno) che segue un raggio r(x) tra x0 e x1 */
  | { shell: { x0: number; x1: number; r: RadiusSpec; t: number; n?: number } }
  /** anello rettangolare [r0, r1, x0, x1] */
  | { ring: [number, number, number, number] }
  /** disco di rotore [x centro, r foro, r corona, spessore mozzo, spessore anima] */
  | { disc: [number, number, number, number, number] }
  /** poligono chiuso [[r, x], ...] */
  | { polygon: [number, number][] }
  /** semiellisse (cupola) di spessore t: punti r + dr·cos θ, x + dx·sin θ con θ da π a 0 */
  | { arc: { r: number; x: number; dr: number; dx: number; n: number; t: number } };

/** Movimento di una parte, calcolato a ogni fotogramma dagli angoli degli alberi */
export type Motion =
  /** pistone: traslazione lungo y secondo il manovellismo ("kinematics.crank"); phase = angolo della manovella */
  | { piston: { phase: number } }
  /** biella: segue spinotto e perno di manovella; x = piano del cilindro */
  | { rod: { phase: number; x: number } }
  /**
   * valvola (o punteria) azionata da una camma con punteria piana, verso -y.
   * cam = stessa camma disegnata sull'albero a camme; spring = [y fisso, y mobile]: invece di
   * traslare la parte si comprime (molla).
   */
  | { valve: { spool: string; cam: CamSpec; spring?: [number, number] } };

/** Profilo di camma: cerchio di base + alzata con legge cosinusoidale; angle = direzione del naso, duration in gradi camma */
export interface CamSpec { base: number; lift: number; duration: number; angle: number }

interface Placed {
  mat: MaterialRef;
  /** albero rotante che trascina la parte (prevale su quello del componente) */
  spool?: string;
  motion?: Motion;
  /** fa parte delle casse esterne (nascosta con "Casse esterne" spento) */
  casing?: boolean;
  /** solo per componenti divisi: metà superiore o inferiore */
  side?: 'up' | 'lo';
}

export interface RevolvePart extends Placed {
  type: 'revolve';
  profile: Profile;
  seg?: number;
  /** asse di rivoluzione: "x" (predefinito) o "y"; at = punto dell'asse da cui si misurano r e la quota */
  axis?: 'x' | 'y';
  at?: Vec3;
  /** componenti divisi: crea le due metà (superiore e inferiore) */
  halves?: boolean;
}

export interface RowPart extends Placed {
  type: 'row';
  x: number;
  n: number;
  chord: number;
  /** true = rotore, false = statore (sfalsato di mezzo passo) */
  rotor?: boolean;
  stagger: number;
  twist?: number;
  camber?: number;
  thick?: number;
  taper?: number;
  /** raggio di radice; se manca segue il mozzo del condotto */
  root?: number;
  /** raggio di testa; se manca segue il raggio esterno del condotto */
  tip?: number;
  /** componenti divisi: distribuisce le pale sulle due metà */
  split?: boolean;
}

export interface TorusPart extends Placed {
  type: 'torus';
  x: number;
  r: number;
  tube: number;
  radialSeg?: number;
  tubularSeg?: number;
  halves?: boolean;
}

export interface CylinderPart extends Placed {
  type: 'cylinder';
  r: number;
  h: number;
  seg?: number;
  /** asse del cilindro: "y" (predefinito), "x" o "z" */
  axis?: 'x' | 'y' | 'z';
  at: Vec3;
}

/** cilindro tra due punti qualsiasi (aste, candele, iniettori) */
export interface BarPart extends Placed {
  type: 'bar';
  from: Vec3;
  to: Vec3;
  r: number;
  seg?: number;
}

/** tubo che segue una curva morbida per i punti dati (condotti, collettori); helix per le molle */
export interface TubePart extends Placed {
  type: 'tube';
  points?: Vec3[];
  /** elica lungo y: centro della base, raggio, altezza, spire */
  helix?: { at: Vec3; radius: number; height: number; turns: number };
  r: number;
  seg?: number;
  radialSeg?: number;
  closed?: boolean;
}

/** forma piana per le estrusioni, coordinate (u, v) */
export type Shape2D =
  | { rect: [number, number, number, number] }
  /** rettangolo con angoli raccordati [u0, v0, u1, v1, raggio] */
  | { rrect: [number, number, number, number, number] }
  | { circle: [number, number, number] }
  | { polygon: [number, number][] }
  /** inviluppo convesso di cerchi [[u, v, r], ...]: maschette, cinghie */
  | { hull: [number, number, number][] }
  /** settore di corona [u, v, r interno, r esterno, angolo iniziale, angolo finale]: contrappesi */
  | { sector: [number, number, number, number, number, number] }
  /** camma centrata in (u, v) */
  | { cam: CamSpec & { u: number; v: number } };

/** prisma: forma piana (con eventuali fori) estrusa lungo un asse tra due quote */
export interface ExtrudePart extends Placed {
  type: 'extrude';
  axis: 'x' | 'y' | 'z';
  from: number;
  to: number;
  shape: Shape2D;
  holes?: Shape2D[];
}

/** colonna di gas in un cilindro, colorata secondo la fase del ciclo ("cycle") */
export interface ChargePart extends Placed {
  type: 'charge';
  x: number;
  r: number;
  /** quota del cielo della camera di combustione */
  top: number;
  /** distanza tra asse dello spinotto e cielo del pistone */
  crown: number;
  /** fase della manovella del cilindro */
  phase: number;
  /** indice del cilindro in "cycle.cylinders" */
  cylinder: number;
}

export interface BoxPart extends Placed {
  type: 'box';
  size: Vec3;
  at: Vec3;
}

export type Shape =
  | { cylinder: { r: number; h: number; seg?: number; axis?: 'x' | 'y'; offset?: Vec3 } }
  | { box: { size: Vec3; offset?: Vec3 } };

/** n copie disposte a corona: angolo ψ = (i + offset)/n · 360°, posizione (x, r cos ψ, r sin ψ) */
export interface RingPattern { n: number; x: number; r: number; offset?: number }

export interface InstancesPart extends Placed {
  type: 'instances';
  shape: Shape;
  rings: RingPattern[];
  split?: boolean;
}

/** flange del piano di divisione orizzontale di una cassa divisa */
export interface SplitFlangesPart extends Placed {
  type: 'splitFlanges';
  xStart: number;
  step: number;
  count: number;
  len: number;
  height: number;
  width: number;
  /** distanza radiale oltre il raggio esterno del condotto */
  tipOffset: number;
}

/**
 * Girante di macchina radiale: n pale sottili tra la curva del mozzo e quella della cassa (profili
 * meridiani [x, r] con lo stesso numero di punti, dal bordo d'attacco a quello d'uscita).
 * L'avvolgimento θ(x) dipende solo da x: pale a "elementi radiali", come nella girante Eckardt O.
 */
export interface ImpellerPart extends Placed {
  type: 'impeller';
  n: number;
  hub: [number, number][];
  shroud: [number, number][];
  /** avvolgimento della pala [x, θ in gradi] */
  wrap?: [number, number][];
  thick: number;
  /** gioco tra pala e cassa */
  clearance?: number;
  /**
   * in alternativa a "wrap": avvolgimento in funzione della frazione meridiana m ∈ [0, 1]
   * (0 = bordo d'attacco, 1 = uscita) [m, θ in gradi]; serve per le pale curvate all'indietro delle pompe
   */
  wrapM?: [number, number][];
}

/** chiocciola (voluta) a sezione circolare crescente, nel piano x = costante, con condotto di mandata */
export interface VoluteSpec {
  x: number;
  /** raggio d'ingresso (uscita del diffusore) */
  r3: number;
  /** raggio della sezione all'inizio (lingua) e alla fine della spirale */
  rc0: number;
  rcMax: number;
  /** quanto la sezione si sovrappone al diffusore, in frazione del suo raggio */
  overlap: number;
  /** angolo della lingua (gradi, da +y verso +z) */
  tongue: number;
  /** condotto di mandata rettilineo e tangente alla fine della spirale */
  discharge: { length: number; rExit: number };
}
export interface VolutePart extends Placed, VoluteSpec { type: 'volute'; wall?: number }

export type Part = RevolvePart | RowPart | TorusPart | CylinderPart | BoxPart | InstancesPart | SplitFlangesPart | BarPart | TubePart | ExtrudePart | ChargePart | ImpellerPart | VolutePart;

export interface ComponentDef extends Card {
  id: string;
  /** Nome breve per i pulsanti */
  short: string;
  color: string;
  /** spostamento nella vista esplosa */
  explode: Vec3;
  /** albero rotante a cui appartiene (chiave di "spools") */
  spool?: string;
  /** se presente il componente è diviso in due metà che si aprono di questa quantità nella vista esplosa */
  split?: number;
  /** false = il taglio non lo seziona (come negli spaccati: alberi, bielle, valvole restano interi) */
  clip?: boolean;
  materials: Record<string, MaterialSpec>;
  parts: Part[];
}

export interface Station { n: number; label: string; x: number; y: number; z?: number; flip?: boolean }

export interface SpoolDef {
  /** velocità di animazione in rad/s (al rallentatore) */
  speed?: number;
  /** in alternativa: segue un altro albero con un rapporto (es. albero a camme = 0,5 × albero motore) */
  of?: string;
  ratio?: number;
  /** asse di rotazione parallelo a x passante per (y, z); predefinito (0, 0) */
  center?: [number, number];
}

export interface CycleDef {
  /** albero motore e durata del ciclo in gradi (720 per il 4 tempi) */
  spool: string;
  length: number;
  title: string;
  /** fasi in ordine, ciascuna lunga length / numero di fasi */
  strokes: { name: string; color: string }[];
  /** per ogni cilindro: angolo dell'albero a cui inizia la prima fase */
  cylinders: { label: string; offset: number }[];
  note?: string;
}

/** scala di colori: [valore, colore] */
export type ColorStops = [number, string][];

/**
 * Simulazione semplificata del flusso in un compressore centrifugo: modello monodimensionale lungo
 * linee di corrente (continuità, equazione di Eulero con fattore di scorrimento, rendimento con
 * perdite per incidenza). Le frecce si muovono con la velocità assoluta calcolata.
 */
export interface FlowDef {
  title: string;
  note: string;
  /** albero della girante: la sua velocità segue i giri impostati */
  spool: string;
  /** rallentamento: secondi di animazione per secondo reale */
  timeScale: number;
  gas: { R: number; cp: number; k: number };
  /** condizioni totali all'aspirazione (Pa, K) */
  inlet: { p0: number; T0: number };
  design: { rpm: number; mdot: number; etaImpeller: number; etaStage: number };
  /** campo dei cursori */
  limits: { rpm: [number, number]; mdot: [number, number] };
  /** perdita di rendimento per incidenza: Δη = k·i² (i in radianti) */
  incidenceLoss: number;
  /** incidenza oltre la quale si segnala il rischio di pompaggio (gradi) */
  surgeIncidence: number;
  duct: { x0: number; r: number; bell: { x: number; r: number } };
  spinner: [number, number][];
  impeller: { blades: number; thick: number; hub: [number, number][]; shroud: [number, number][]; wrap: [number, number][] };
  diffuser: { r3: number; xHub: number };
  volute: VoluteSpec;
  arrows: { spans: number[]; angles: number; perPath: number; size: number };
  colors: { T: ColorStops; p: ColorStops; c: ColorStops };
}

export interface MachineData {
  id: string;
  title: string;
  eyebrow: string;
  subtitle: string;
  canvasLabel: string;
  note: string;
  overview: Card;
  /** alberi rotanti */
  spools: Record<string, SpoolDef>;
  spinLabel: string;
  spinNote: string;
  /** etichetta dell'interruttore di animazione (predefinita "Rotori in moto") */
  spinToggle?: string;
  /** etichetta dell'interruttore delle stazioni (predefinita "Stazioni del ciclo") */
  stationsToggle?: string;
  /** taglio: estensione assiale e valori iniziali (gradi, %); unit/scale per mostrare la quota (es. "mm", 1000) */
  section?: { xMin: number; xMax: number; alpha: number; center: number; extent: number; unit?: string; scale?: number };
  /** manovellismo: albero, raggio di manovella e lunghezza di biella (m) */
  kinematics?: { crank: { spool: string; radius: number; rod: number } };
  /** pannello delle fasi del ciclo (motori alternativi) */
  cycle?: CycleDef;
  /** simulazione del flusso (compressori centrifughi) */
  flow?: FlowDef;
  /** impianto di sollevamento (vedi PlantDef): la geometria dell'impianto è generata dal programma */
  plant?: PlantDef;
  /** dati della pompa (solo per le macchine usate in un impianto) */
  pump?: PumpDef;
  /** macchine dell'impianto, caricate insieme al modulo (vedi machines/index.ts) */
  pumpMachines?: MachineData[];
  /** attività previste nella sezione Esercitati: [titolo, descrizione] */
  practice?: [string, string][];
  view: {
    fov: number;
    near: number;
    far: number;
    minDistance: number;
    maxDistance: number;
    /** distanza minima della camera quando si inquadra un componente (predefinita 2,2) */
    focusMin?: number;
    /** direzione da cui guarda la camera (orizzontale e verticale); predefinite quelle del modulo 1 */
    dir?: Vec3;
    dirPortrait?: Vec3;
    fit: { assembled: [Vec3, Vec3]; exploded: [Vec3, Vec3] };
    grid: { size: number; divisions: number; position: Vec3 };
  };
  /** mappa temperature dei componenti (se manca l'interruttore non compare) */
  temperature?: { label: string; stops: [number, string][] };
  stations: Station[];
  /** solo per turbomacchine */
  flowPath?: [number, number, number][];
  palette: Record<string, string>;
  /** l'ordine dell'elenco è quello dei pulsanti "Componenti" */
  components: ComponentDef[];
}


/* ------------------------------------------------------------------ */
/* Impianto di sollevamento e pompe                                    */
/* ------------------------------------------------------------------ */

/**
 * Prestazioni di una pompa al numero di giri di riferimento n0, in forma adimensionale rispetto al
 * punto di massimo rendimento (BEP): q = Q/Q_bep, h = H/H_bep, p = P/P_bep, npsh = NPSH3/NPSH3_bep.
 * Agli altri giri valgono le leggi di affinità: Q ∝ n, H ∝ n², P ∝ n³, NPSH ∝ n².
 * Il rendimento si ricava come η = η_bep · q·h/p.
 */
export interface PumpDef {
  kind: 'centrifuga' | 'assiale';
  /** nome breve (pulsanti, grafici) */
  label: string;
  n0: number;
  bep: { Q: number; H: number; eta: number; npsh3: number };
  curve: { q: number[]; h: number[]; p: number[]; npsh: number[] };
  /** NPSH di inizio cavitazione (prime bolle) = fattore × NPSH3 */
  npshiFactor: number;
  /** campo di funzionamento consigliato, in frazioni della portata di massimo rendimento */
  por: [number, number];
  limits: { rpm: [number, number] };
  /**
   * geometria per i triangoli di velocità: raggi in m, angoli di pala in gradi.
   * Centrifuga: occhio (r1h, r1s), uscita r2 e larghezza b2, β2 dalla direzione tangenziale, Z pale.
   * Assiale: raggi di mozzo e apice, β2 dalla direzione assiale (flusso relativo in uscita), Z pale.
   */
  geometry: { r1h: number; r1s: number; r2: number; b2: number; beta2: number; Z: number; blockage: number };
  /** posizione delle flange nel modello 3D della pompa (asse x, asse della girante in y = z = 0) */
  mount: { base: number; inlet: Vec3; outlet: Vec3; inletR: number; outletR: number };
  /** simulazione del flusso nella macchina singola */
  flow: PumpFlowDef;
}

export interface PumpFlowDef {
  title: string;
  note: string;
  spool: string;
  timeScale: number;
  /** condotto d'ingresso: [x, raggio esterno, raggio del mozzo] */
  inlet: [number, number, number][];
  /** profili meridiani (come la girante del modello) e avvolgimento θ(m) */
  impeller: { hub: [number, number][]; shroud: [number, number][]; wrapM: [number, number][]; blades: number };
  /** centrifuga: chiocciola */
  volute?: VoluteSpec;
  /** assiale: raddrizzatore, diffusore e curva */
  stator?: { x0: number; x1: number };
  diffuser?: [number, number, number][];
  bend?: { x: number; R: number; r: number; up: number };
  arrows: { spans: number[]; angles: number; perPath: number; size: number };
  colors: { p: ColorStops; c: ColorStops };
}

/** tubazione: diametro interno, lunghezza, coefficienti di perdita concentrata [nome, K] */
export interface PipeDef { D: number; L: number; K: [string, number][] }

export interface PlantDef {
  title: string;
  note: string;
  /** acqua: densità, viscosità cinematica, tensione di vapore; pressione atmosferica */
  water: { rho: number; nu: number; pv: number; T: number };
  patm: number;
  g: number;
  /** scabrezza assoluta delle tubazioni (m) */
  roughness: number;
  /**
   * tubazioni. suction: aspirazione di una pompa (lunghezza orizzontale; il tratto verticale dipende dalla quota);
   * branch: mandata di una pompa fino al collettore; link: collegamento tra due pompe in serie;
   * main: collettore, condotta di mandata e sbocco nel bacino di monte.
   */
  pipes: { suction: PipeDef; branch: PipeDef; link: PipeDef; main: PipeDef };
  /** pezzi speciali dell'aspirazione, che cambiano con l'installazione */
  suctionFittings: { lift: [string, number][]; flooded: [string, number][]; bend: number };
  /** disposizione: quota della bocca d'aspirazione, interasse delle pompe, ascissa delle flange */
  layout: { intakeY: number; intakeX: number; spacing: number; pumpX: number; headerX: number; upperX: number };
  limits: { pumps: number; Hg: [number, number]; z: [number, number] };
  /** punto di progetto proposto per ciascuna macchina */
  design: Record<string, { pumps: number; series: boolean; Hg: number; z: number }>;
  colors: { p: ColorStops; c: ColorStops };
  arrows: { size: number; spacing: number; timeScale: number };
  /** id delle macchine (file JSON) */
  machines: string[];
}
