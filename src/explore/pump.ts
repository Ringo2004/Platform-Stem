import type { PlantDef, PumpDef } from '../machines/types';

/*
 * Modello idraulico dell'impianto di sollevamento (acqua, moto stazionario).
 *
 * Pompe
 * - curve caratteristiche adimensionali (prevalenza, potenza, NPSH richiesto) riferite al punto di massimo
 *   rendimento, interpolate con spline cubiche monotone; leggi di affinità per gli altri giri:
 *   Q ∝ n, H ∝ n², P ∝ n³, NPSH ∝ n²;
 * - pompe uguali in parallelo: a pari prevalenza le portate si sommano (Q = N·Q₁);
 *   in serie: a pari portata le prevalenze si sommano (H = N·H₁);
 * - cavitazione: NPSH disponibile NPSHa = (p_atm − p_v)/(ρg) − z − h_asp; per definizione con NPSHa = NPSH3
 *   la prevalenza cala del 3 %, e il calo cresce rapidamente quando NPSHa scende ancora (curva "troncata").
 *
 * Impianto
 * - curva dell'impianto H_imp = H_g + Σ perdite, con perdite distribuite (Darcy-Weisbach, fattore d'attrito
 *   di Swamee-Jain) e concentrate K·v²/(2g); in parallelo ogni pompa ha la sua aspirazione e la sua mandata
 *   fino al collettore, poi la condotta di mandata è comune;
 * - punto di funzionamento: intersezione tra curva del gruppo di pompe e curva dell'impianto;
 * - regolazione per strozzamento: la valvola sulla mandata dissipa la differenza tra le due curve.
 */

/* ------------------------------------------------------------------ */
/* Interpolazione: spline cubica monotona (Fritsch-Carlson)            */
/* ------------------------------------------------------------------ */
export function monotoneSpline(xs: number[], ys: number[]) {
  const n = xs.length;
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    // oltre gli estremi: prolungamento lineare
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/* ------------------------------------------------------------------ */
/* Pompa                                                               */
/* ------------------------------------------------------------------ */
export class PumpModel {
  readonly def: PumpDef;
  readonly Pbep: number;
  readonly qEnd: number;
  private h: (q: number) => number;
  private p: (q: number) => number;
  private npsh: (q: number) => number;

  constructor(def: PumpDef, rho: number, g: number) {
    this.def = def;
    const c = def.curve;
    this.h = monotoneSpline(c.q, c.h);
    this.p = monotoneSpline(c.q, c.p);
    this.npsh = monotoneSpline(c.q, c.npsh);
    this.qEnd = c.q[c.q.length - 1];
    this.Pbep = (rho * g * def.bep.Q * def.bep.H) / def.bep.eta;
  }
  /** rapporto dei giri e portata ridotta q = Q/Q_bep(n) */
  private q(Q: number, n: number) { return Q / (this.def.bep.Q * (n / this.def.n0)); }
  /** portata massima rappresentata (fine della curva) ai giri n */
  Qmax(n: number) { return this.qEnd * this.def.bep.Q * (n / this.def.n0); }
  Qbep(n: number) { return this.def.bep.Q * (n / this.def.n0); }
  /** prevalenza senza cavitazione (m) */
  H(Q: number, n: number) { const r = n / this.def.n0; return this.h(Math.max(0, this.q(Q, n))) * this.def.bep.H * r * r; }
  /** potenza assorbita all'albero (W) */
  P(Q: number, n: number) { const r = n / this.def.n0; return Math.max(0.02, this.p(Math.max(0, this.q(Q, n)))) * this.Pbep * r * r * r; }
  eta(Q: number, n: number) {
    const q = Math.max(0, this.q(Q, n));
    if (q <= 0) return 0;
    return Math.max(0, Math.min(0.95, this.def.bep.eta * q * Math.max(0, this.h(q)) / Math.max(0.02, this.p(q))));
  }
  /** NPSH richiesto (criterio del 3 % di calo di prevalenza) */
  npsh3(Q: number, n: number) { const r = n / this.def.n0; return Math.max(0.3, this.npsh(Math.max(0, this.q(Q, n)))) * this.def.bep.npsh3 * r * r; }
  /** NPSH di inizio cavitazione (prime bolle visibili) */
  npshi(Q: number, n: number) { return this.def.npshiFactor * this.npsh3(Q, n); }
  /** calo di prevalenza per cavitazione (frazione): 3 % con NPSHa = NPSH3, poi cresce rapidamente */
  drop(Q: number, n: number, npsha: number) {
    const n3 = this.npsh3(Q, n);
    // a portata quasi nulla non c'è calo di prevalenza (il fluido non attraversa la girante)
    const q = Math.max(0, this.q(Q, n));
    return Math.min(1, 0.03 * Math.exp((n3 - npsha) / (0.12 * n3))) * Math.min(1, q / 0.2);
  }
}

/* ------------------------------------------------------------------ */
/* Tubazioni                                                           */
/* ------------------------------------------------------------------ */
export function frictionFactor(D: number, v: number, nu: number, eps: number) {
  const Re = Math.max(1, (Math.abs(v) * D) / nu);
  if (Re < 2300) return 64 / Re;
  const l = Math.log10(eps / (3.7 * D) + 5.74 / Math.pow(Re, 0.9));
  return 0.25 / (l * l);
}

export interface PipeLoss { v: number; f: number; dist: number; conc: number; total: number; K: number; L: number }

export function pipeLoss(plant: PlantDef, D: number, L: number, K: number, Q: number): PipeLoss {
  const A = (Math.PI * D * D) / 4, v = Q / A, kin = (v * v) / (2 * plant.g);
  const f = frictionFactor(D, v, plant.water.nu, plant.roughness);
  const dist = (f * L) / D * kin, conc = K * kin;
  return { v, f, dist, conc, total: dist + conc, K, L };
}
const sumK = (list: [string, number][]) => list.reduce((s, [, k]) => s + k, 0);

/**
 * Aspirazione di una pompa installata a quota z sul pelo libero di valle:
 * - z ≥ 0 (pompa in aspirazione): tubo che scende nel bacino con valvola di fondo e succhieruola;
 * - z < 0 (sotto battente): imbocco a campana e saracinesca; se la pompa è abbastanza in basso
 *   il tubo entra orizzontale dalla parete del bacino.
 */
export function suctionLayout(plant: PlantDef, z: number) {
  const lay = plant.layout, sf = plant.suctionFittings;
  const horizontal = z <= lay.intakeY + 0.7;
  const intakeY = horizontal ? z : lay.intakeY;
  const vertical = horizontal ? 0 : z - intakeY;
  const fittings: [string, number][] = [...(z >= 0 ? sf.lift : sf.flooded), ...plant.pipes.suction.K];
  if (!horizontal) fittings.push(['Curva a 90°', sf.bend]);
  return { horizontal, intakeY, vertical, lift: z >= 0, L: plant.pipes.suction.L + vertical, fittings, K: sumK(fittings) };
}

export interface PlantSettings {
  /** numero di pompe */
  N: number;
  series: boolean;
  rpm: number;
  /** salto geodetico (m) */
  Hg: number;
  /** quota dell'asse della pompa sul pelo libero di valle (m): negativa = sotto battente */
  z: number;
  /** portata imposta con la valvola di regolazione (m³/s), null = valvola tutta aperta */
  Qreq: number | null;
}

/** perdite e curve dell'impianto per una configurazione */
export class PlantModel {
  readonly Hb: number;
  readonly plant: PlantDef;
  readonly pump: PumpModel;
  readonly s: PlantSettings;
  constructor(plant: PlantDef, pump: PumpModel, s: PlantSettings) {
    this.plant = plant; this.pump = pump; this.s = s;
    const w = plant.water;
    this.Hb = (plant.patm - w.pv) / (w.rho * plant.g);
  }
  get par() { return this.s.series ? 1 : this.s.N; }
  /** perdite d'aspirazione di una pompa con portata Qp */
  suction(Qp: number) { const sl = suctionLayout(this.plant, this.s.z); return pipeLoss(this.plant, this.plant.pipes.suction.D, sl.L, sl.K, Qp); }
  branch(Qp: number) { const b = this.plant.pipes.branch; return pipeLoss(this.plant, b.D, b.L, sumK(b.K), Qp); }
  link(Q: number) { const b = this.plant.pipes.link; return pipeLoss(this.plant, b.D, b.L, sumK(b.K), Q); }
  main(Q: number) { const b = this.plant.pipes.main; return pipeLoss(this.plant, b.D, b.L, sumK(b.K), Q); }
  /** perdite totali per portata complessiva Q (valvola di regolazione tutta aperta) */
  losses(Q: number) {
    const Qp = Q / this.par;
    const s = this.suction(Qp).total, b = this.branch(Qp).total, m = this.main(Q).total;
    const l = this.s.series ? (this.s.N - 1) * this.link(Q).total : 0;
    return { suction: s, branch: b, link: l, main: m, total: s + b + l + m };
  }
  Hplant(Q: number) { return this.s.Hg + this.losses(Q).total; }
  /** NPSH disponibile all'ingresso della (prima) pompa */
  npsha(Q: number) { return this.Hb - this.s.z - this.suction(Q / this.par).total; }
  /** prevalenza del gruppo senza cavitazione */
  Hgroup(Q: number, n = this.s.rpm) { return this.s.series ? this.s.N * this.pump.H(Q, n) : this.pump.H(Q / this.s.N, n); }
  /** prevalenza del gruppo con l'effetto della cavitazione (solo la prima pompa in serie è esposta) */
  HgroupEff(Q: number, n = this.s.rpm) {
    const Qp = Q / this.par, drop = this.pump.drop(Qp, n, this.npsha(Q));
    const H1 = this.pump.H(Qp, n);
    return this.s.series ? H1 * (1 - drop) + (this.s.N - 1) * H1 : H1 * (1 - drop);
  }
  QmaxGroup(n = this.s.rpm) { return this.pump.Qmax(n) * this.par; }
}

/* ------------------------------------------------------------------ */
/* Punto di funzionamento                                              */
/* ------------------------------------------------------------------ */
export interface Triangle { u: number; cu: number; cm: number; bladeAngle?: number }

export interface OpResult {
  /** portata complessiva e per pompa (m³/s), prevalenza del gruppo e di una pompa (m) */
  Q: number; Qp: number; H: number; Hp: number;
  /** portata del punto di funzionamento a valvola aperta */
  Qfree: number;
  Hplant: number; Hvalve: number;
  losses: { suction: number; branch: number; link: number; main: number; total: number };
  v: { suction: number; branch: number; main: number };
  eta: number; Pp: number; P: number; Pw: number;
  npsha: number; npsh3: number; npshi: number; drop: number;
  /** 0 nessuna cavitazione, 1 incipiente, 2 sviluppata, 3 la pompa non funziona più */
  cav: 0 | 1 | 2 | 3;
  /** quota massima consigliata (NPSHa = NPSH3 + 0,5 m) e quota senza bolle (NPSHa = NPSHi) */
  zMax: number; zFree: number;
  /** q = Q/Q_bep della pompa ai giri attuali */
  q: number;
  noFlow: boolean; multiple: boolean; unstable: boolean; runout: boolean;
  /** portata imposta non raggiungibile: giri necessari (null se oltre il campo) */
  unreachable: boolean; rpmNeeded: number | null;
  tri: { in: Triangle; out: Triangle; Hth: number };
  nq: number;
}

function bisect(f: (x: number) => number, a: number, b: number, it = 60) {
  let fa = f(a);
  for (let i = 0; i < it; i++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}

/** radici di f = H_gruppo − H_impianto tra 0 e Qmax, dalla più grande */
function roots(pm: PlantModel, n: number, cavitation = true) {
  const Qmax = pm.QmaxGroup(n), N = 400;
  const f = (Q: number) => (cavitation ? pm.HgroupEff(Q, n) : pm.Hgroup(Q, n)) - pm.Hplant(Q);
  const out: number[] = [];
  let prevQ = Qmax, prev = f(Qmax);
  for (let i = N - 1; i >= 0; i--) {
    const Q = (Qmax * i) / N, v = f(Q);
    if ((v > 0) !== (prev > 0)) out.push(bisect(f, Q, prevQ));
    prevQ = Q; prev = v;
  }
  return { out, f0: f(0), fMax: f(Qmax) };
}

export function velocityTriangles(def: PumpDef, Qp: number, n: number, g: number) {
  const G = def.geometry, w = (n * 2 * Math.PI) / 60, w0 = (def.n0 * 2 * Math.PI) / 60;
  const A1 = Math.PI * (G.r1s * G.r1s - G.r1h * G.r1h);
  const r1m = Math.sqrt((G.r1h * G.r1h + G.r1s * G.r1s) / 2);
  const cm1 = Qp / A1;
  // angolo della pala all'ingresso (dalla direzione meridiana): ingresso senza urto nel punto di progetto
  const blade = (Math.atan2(w0 * r1m, def.bep.Q / A1) * 180) / Math.PI;
  const tin: Triangle = { u: w * r1m, cu: 0, cm: cm1, bladeAngle: blade };
  const b = (G.beta2 * Math.PI) / 180;
  let out: Triangle;
  if (def.kind === 'centrifuga') {
    const u2 = w * G.r2, cm2 = Qp / (2 * Math.PI * G.r2 * G.b2 * G.blockage);
    const sigma = 1 - Math.sqrt(Math.sin(b)) / Math.pow(G.Z, 0.7); // Wiesner
    out = { u: u2, cu: Math.max(0.03 * u2, sigma * u2 - cm2 / Math.tan(b)), cm: cm2 };
  } else {
    // assiale: stesso raggio medio in ingresso e in uscita, β2 dalla direzione assiale
    out = { u: tin.u, cu: Math.max(0.03 * tin.u, tin.u - cm1 * Math.tan(b)), cm: cm1 };
  }
  return { in: tin, out, Hth: (out.u * out.cu - tin.u * tin.cu) / g };
}

export function solvePlant(plant: PlantDef, pump: PumpModel, s: PlantSettings): OpResult {
  const pm = new PlantModel(plant, pump, s);
  const g = plant.g, rho = plant.water.rho, n = s.rpm;
  const r = roots(pm, n);
  const noFlow = r.out.length === 0 && r.f0 <= 0;
  const runout = r.out.length === 0 && r.f0 > 0;
  const Qfree = noFlow ? 0 : runout ? pm.QmaxGroup(n) : r.out[0];

  let Q = Qfree, unreachable = false, rpmNeeded: number | null = null;
  if (s.Qreq !== null) {
    if (s.Qreq <= Qfree) Q = s.Qreq;
    else {
      unreachable = true;
      // giri necessari per ottenere la portata richiesta a valvola tutta aperta
      const need = (nn: number) => pm.HgroupEff(s.Qreq!, nn) - pm.Hplant(s.Qreq!);
      const hi = pump.def.limits.rpm[1] * 1.6;
      rpmNeeded = need(hi) > 0 ? bisect(need, Math.max(1, s.Qreq / pm.QmaxGroup(1) * 1.0001), hi) : null;
    }
  }
  const Qp = Q / pm.par;
  const H = Q > 0 ? pm.HgroupEff(Q, n) : pm.Hgroup(0, n);
  const Hplant = pm.Hplant(Q);
  const losses = pm.losses(Q);
  const npsha = pm.npsha(Q), npsh3 = pump.npsh3(Qp, n), npshi = pump.npshi(Qp, n);
  const drop = Q > 0 ? pump.drop(Qp, n, npsha) : 0;
  const Hp = pump.H(Qp, n) * (1 - drop);
  // potenza: con la pompa in cavitazione cala insieme alla prevalenza
  const Pp = pump.P(Qp, n) * (1 - 0.6 * drop);
  const P = Pp * s.N;
  const Pw = rho * g * Q * H;
  const eta = P > 0 ? Pw / P : 0;
  const qn0 = (x: number) => x / pump.Qbep(n);
  let cav: 0 | 1 | 2 | 3 = 0;
  if (npsha < npshi) cav = 1;
  if (npsha < npsh3) cav = 2;
  if (drop > 0.3 || npsha <= 0.2 || (qn0(Qp) < 0.15 && npsha < npsh3)) cav = 3;
  // senza portata non c'è cavitazione, a meno che la pompa sia oltre l'altezza di aspirazione teorica
  if (noFlow) cav = npsha <= 0.2 ? 3 : 0;

  // quota massima consigliata alla portata attuale (con l'aspirazione corrispondente)
  const zFor = (target: number) => {
    const at = (z: number) => new PlantModel(plant, pump, { ...s, z }).npsha(Q) - target;
    return bisect(at, plant.limits.z[0] - 10, pm.Hb + 1);
  };
  const zMax = zFor(npsh3 + 0.5), zFree = zFor(npshi);

  const sl = pm.suction(Qp), br = pm.branch(Qp), mn = pm.main(Q);
  const qn = Qp / pump.Qbep(n);
  // tratto a pendenza positiva della curva (sella della pompa assiale): funzionamento instabile
  const dQ = pm.QmaxGroup(n) * 0.01;
  const unstable = Q > dQ && pm.Hgroup(Q + dQ, n) > pm.Hgroup(Q - dQ, n) + 1e-6;
  const d = pump.def;
  const nq = (d.n0 * Math.sqrt(d.bep.Q)) / Math.pow(d.bep.H, 0.75);
  return {
    Q, Qp, H, Hp, Qfree, Hplant, Hvalve: Math.max(0, H - Hplant), losses,
    v: { suction: sl.v, branch: br.v, main: mn.v },
    eta, Pp, P, Pw, npsha, npsh3, npshi, drop, cav, zMax, zFree, q: qn,
    noFlow, multiple: roots(pm, n, false).out.length > 1 && s.Qreq === null, unstable, runout,
    unreachable, rpmNeeded,
    tri: velocityTriangles(d, Qp, n, g), nq
  };
}

/** curve per i diagrammi, in funzione della portata complessiva */
export function plantCurves(plant: PlantDef, pump: PumpModel, s: PlantSettings, op: OpResult, Qmax: number, N = 120) {
  const pm = new PlantModel(plant, pump, s), n = s.rpm;
  const QmaxG = pm.QmaxGroup(n);
  const rows = [];
  // coefficiente della valvola strozzata: ΔH_v ∝ Q² passante per il punto imposto
  const kv = op.Q > 0 && op.Hvalve > 0 ? op.Hvalve / (op.Q * op.Q) : 0;
  for (let i = 0; i <= N; i++) {
    const Q = (Qmax * i) / N, Qp = Q / pm.par;
    const inPump = Q <= QmaxG + 1e-9;
    const Hp = pump.H(Q, n);
    rows.push({
      Q,
      // dove la cavitazione ha annullato la prevalenza la curva si interrompe (curva troncata)
      group: inPump && pm.HgroupEff(Q, n) > 0.01 * pm.Hgroup(0, n) ? pm.HgroupEff(Q, n) : NaN,
      groupNom: inPump ? pm.Hgroup(Q, n) : NaN,
      // curva di una sola pompa (stessa scala delle portate)
      single: Q <= pump.Qmax(n) + 1e-9 ? Hp : NaN,
      plant: pm.Hplant(Q),
      throttled: kv > 0 ? pm.Hplant(Q) + kv * Q * Q : NaN,
      eta: inPump && Q > 0 ? pump.eta(Qp, n) : NaN,
      P: inPump ? (pump.P(Qp, n) * s.N) : NaN,
      npsha: pm.npsha(Q),
      npsh3: inPump ? pump.npsh3(Qp, n) : NaN,
      npshi: inPump ? pump.npshi(Qp, n) : NaN
    });
  }
  return rows;
}
export type CurveRow = ReturnType<typeof plantCurves>[number];
