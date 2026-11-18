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

interface Placed {
  mat: MaterialRef;
  /** fa parte delle casse esterne (nascosta con "Casse esterne" spento) */
  casing?: boolean;
  /** solo per componenti divisi: metà superiore o inferiore */
  side?: 'up' | 'lo';
}

export interface RevolvePart extends Placed {
  type: 'revolve';
  profile: Profile;
  seg?: number;
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
  /** asse del cilindro: "y" (predefinito) o "x" */
  axis?: 'x' | 'y';
  at: Vec3;
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

export type Part = RevolvePart | RowPart | TorusPart | CylinderPart | BoxPart | InstancesPart | SplitFlangesPart;

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
  materials: Record<string, MaterialSpec>;
  parts: Part[];
}

export interface Station { n: number; label: string; x: number; y: number; flip?: boolean }

export interface MachineData {
  id: string;
  title: string;
  eyebrow: string;
  subtitle: string;
  canvasLabel: string;
  note: string;
  overview: Card;
  /** alberi rotanti: velocità di animazione in rad/s (al rallentatore) */
  spools: Record<string, { speed: number }>;
  spinLabel: string;
  spinNote: string;
  /** taglio: estensione assiale e valori iniziali (gradi, %) */
  section: { xMin: number; xMax: number; alpha: number; center: number; extent: number };
  view: {
    fov: number;
    near: number;
    far: number;
    minDistance: number;
    maxDistance: number;
    fit: { assembled: [Vec3, Vec3]; exploded: [Vec3, Vec3] };
    grid: { size: number; divisions: number; position: Vec3 };
  };
  temperature: { label: string; stops: [number, string][] };
  stations: Station[];
  flowPath: [number, number, number][];
  palette: Record<string, string>;
  /** l'ordine dell'elenco è quello dei pulsanti "Componenti" */
  components: ComponentDef[];
}
