import * as THREE from 'three';
import type { ColorStops, FlowDef } from '../machines/types';
import { esc } from '../util';
import { clamp, lerpTable, slopeTable, smoothstep, voluteAt } from './geom';

/*
 * Simulazione semplificata del flusso in un compressore centrifugo.
 *
 * Non è una soluzione delle equazioni di Navier-Stokes: è un modello monodimensionale applicato a più
 * linee di corrente (a diverse altezze di pala e posizioni angolari). In ogni punto si calcolano:
 * - la velocità meridiana dalla continuità ṁ = ρ·c_m·A, iterando sulla densità;
 * - nella girante la componente tangenziale dalla direzione della pala, con il fattore di scorrimento
 *   σ = 1 − 0,63π/Z (Stanitz) verso l'uscita, e il lavoro con l'equazione di Eulero Δh₀ = u·c_u;
 * - nel diffusore senza palette la conservazione del momento della quantità di moto (c_u·r ≈ costante);
 * - nella chiocciola e nel condotto di mandata la continuità sulla sezione;
 * - temperature e pressioni statiche dalle grandezze totali: T = T₀ − c²/(2c_p), p = p₀(T/T₀)^(k/(k−1)),
 *   con le perdite espresse dai rendimenti (girante e stadio) e da un termine di incidenza fuori progetto.
 * Le particelle si muovono lungo le linee di corrente nel riferimento assoluto, con la velocità calcolata.
 */

export type ColorMode = 'T' | 'p' | 'c';

interface Sample { x: number; y: number; z: number; t: number; c: number; T: number; p: number }
interface FlowPath { s: Sample[]; total: number }

export interface Triangle { u: number; cu: number; cm: number; bladeAngle?: number }
export interface FlowResult {
  rpm: number; mdot: number;
  paths: FlowPath[];
  pr: number; T02: number; T04: number; p04: number; work: number; power: number;
  etaStage: number; etaImpeller: number; sigma: number; u2: number;
  incidence: number; machRelTip: number; c1: number;
  inlet: Triangle; outlet: Triangle;
  surge: boolean; choke: boolean;
}

/** risolve il flusso per giri e portata dati */
export function solveFlow(f: FlowDef, rpm: number, mdot: number): FlowResult {
  const { R, cp, k } = f.gas, ex = k / (k - 1);
  const { p0: p01, T0: T01 } = f.inlet;
  const omega = (rpm * 2 * Math.PI) / 60;
  const imp = f.impeller, Z = imp.blades;
  const hub = imp.hub, shr = imp.shroud, M = hub.length;
  const r1h = hub[0][1], r1s = shr[0][1], r2 = hub[M - 1][1], b2 = Math.abs(hub[M - 1][0] - shr[M - 1][0]);
  let choke = false;

  // statiche dalle totali con iterazione sulla continuità: restituisce c_m, T, p
  function continuity(A: number, T0: number, p0: number, cu: number | ((cm: number) => number)) {
    let cm = mdot / ((p0 / (R * T0)) * A), T = T0, p = p0, cuv = 0;
    for (let it = 0; it < 30; it++) {
      cuv = typeof cu === 'function' ? cu(cm) : cu;
      T = T0 - (cm * cm + cuv * cuv) / (2 * cp);
      if (T < 0.55 * T0) { T = 0.55 * T0; choke = true; }
      p = p0 * Math.pow(T / T0, ex);
      const next = mdot / ((p / (R * T)) * A);
      // oltre il limite sonico la continuità non ha soluzione subsonica
      if (cm * cm + cuv * cuv > k * R * T * 1.02) choke = true;
      cm = 0.5 * cm + 0.5 * Math.min(next, Math.sqrt(k * R * T) * 1.2);
    }
    return { cm, cu: cuv, T, p };
  }

  // ingresso girante: velocità assiale, incidenza al raggio medio
  const A1 = Math.PI * (r1s * r1s - r1h * r1h);
  const in1 = continuity(A1, T01, p01, 0);
  const c1 = in1.cm;
  const dTh0 = slopeTable(imp.wrap, 0) * Math.PI / 180; // rad/m, negativo: pala inclinata contro la rotazione
  const r1m = Math.sqrt((r1h * r1h + r1s * r1s) / 2);
  const u1m = omega * r1m;
  const betaFlow = Math.atan2(u1m, c1), betaBlade = Math.atan(r1m * Math.abs(dTh0));
  const inc = betaFlow - betaBlade;
  const speedDev = rpm / f.design.rpm - 1;
  const etaImp = clamp(f.design.etaImpeller - f.incidenceLoss * inc * inc - 0.15 * speedDev * speedDev, 0.4, 0.99);
  const etaSt = clamp(f.design.etaStage - f.incidenceLoss * inc * inc - 0.15 * speedDev * speedDev, 0.35, 0.99);
  const w1s = Math.hypot(c1, omega * r1s), machRelTip = w1s / Math.sqrt(k * R * in1.T);
  if (machRelTip > 1.15) choke = true;

  // uscita girante (Eulero con scorrimento)
  const sigma = 1 - (0.63 * Math.PI) / Z;
  const u2 = omega * r2, cu2 = sigma * u2, work = u2 * cu2;
  const T02 = T01 + work / cp;
  const p02 = p01 * Math.pow(1 + etaImp * (T02 / T01 - 1), ex);
  const pr = Math.pow(1 + etaSt * (T02 / T01 - 1), ex);
  const p04 = p01 * pr;
  const p0dif = p02 - 0.55 * (p02 - p04);

  const blockage = (r: number) => 1 - (Z * imp.thick) / (2 * Math.PI * r) - 0.04;
  let outletTri: Triangle = { u: u2, cu: cu2, cm: 0 };
  let T04 = T02;

  const paths: FlowPath[] = [];
  const nA = f.arrows.angles;
  f.arrows.spans.forEach((span, si) => {
    for (let a = 0; a < nA; a++) {
      const s: Sample[] = [];
      let t = 0, phi = (2 * Math.PI * (a + si / f.arrows.spans.length)) / nA;
      let last: THREE.Vector3 | null = null;
      const push = (pos: THREE.Vector3, c: number, T: number, p: number) => {
        if (last) t += pos.distanceTo(last) / Math.max(c, 1);
        last = pos.clone();
        s.push({ x: pos.x, y: pos.y, z: pos.z, t, c, T, p });
      };
      const polar = (x: number, r: number) => new THREE.Vector3(x, r * Math.cos(phi), r * Math.sin(phi));

      // 1 · condotto d'aspirazione con bocca a campana e ogiva
      const d = f.duct, N1 = 26;
      for (let i = 0; i <= N1; i++) {
        const x = d.x0 + (0 - d.x0) * (i / N1);
        const rc = x < d.bell.x ? d.r + (d.bell.r - d.r) * (0.5 + 0.5 * Math.cos(Math.PI * (x - d.x0) / (d.bell.x - d.x0))) : d.r;
        const rh = x >= f.spinner[0][0] ? lerpTable(f.spinner, x) : 0;
        const st = continuity(Math.PI * (rc * rc - rh * rh), T01, p01, 0);
        push(polar(x, rh + (rc - rh) * span), st.cm, st.T, st.p);
      }

      // 2 · girante: la particella segue la pala nel riferimento relativo, qui integrata in quello assoluto
      let cuExit = cu2;
      for (let i = 0; i < M; i++) {
        const m = i / (M - 1);
        const [xh, rh] = hub[i], [xs, rs] = shr[i];
        const x = xh + (xs - xh) * span, r = rh + (rs - rh) * span;
        const dm = Math.hypot(xs - xh, rs - rh), rbar = (rh + rs) / 2;
        const A = 2 * Math.PI * rbar * dm * blockage(rbar);
        const j0 = Math.max(0, i - 1), j1 = Math.min(M - 1, i + 1);
        const ax = (hub[j1][0] + (shr[j1][0] - hub[j1][0]) * span) - (hub[j0][0] + (shr[j0][0] - hub[j0][0]) * span);
        const ar = (hub[j1][1] + (shr[j1][1] - hub[j1][1]) * span) - (hub[j0][1] + (shr[j0][1] - hub[j0][1]) * span);
        const dxdl = ax / (Math.hypot(ax, ar) || 1);
        const u = omega * r;
        const thp = slopeTable(imp.wrap, x) * Math.PI / 180;
        const guide = smoothstep(0, 0.12, m), slip = (1 - sigma) * u * smoothstep(0.45, 1, m);
        const cuOf = (cm: number) => guide * (u + cm * r * thp * dxdl) - slip;
        const T0 = T01 + Math.max(0, u * cuOf(c1)) / cp;
        const st0 = continuity(A, T0, p01 * Math.pow(1 + etaImp * (T0 / T01 - 1), ex), cuOf);
        // lavoro con la c_u effettiva
        const T0b = T01 + Math.max(0, u * st0.cu) / cp;
        const st = continuity(A, T0b, p01 * Math.pow(1 + etaImp * (T0b / T01 - 1), ex), cuOf);
        const lp = last as THREE.Vector3 | null;
        if (lp) {
          const dl = Math.hypot(x - lp.x, r - Math.hypot(lp.y, lp.z));
          phi += (st.cu / r) * (dl / Math.max(st.cm, 1));
        }
        push(polar(x, r), Math.hypot(st.cm, st.cu), st.T, st.p);
        if (i === M - 1) {
          cuExit = st.cu;
          if (si === Math.floor(f.arrows.spans.length / 2) && a === 0) outletTri = { u, cu: st.cu, cm: st.cm };
        }
      }

      // 3 · diffusore senza palette (sezione di passaggio costante: b = b₂·r₂/r)
      const r3 = f.diffuser.r3, N3 = 24;
      let cu3 = cuExit;
      for (let i = 1; i <= N3; i++) {
        const r = r2 + (r3 - r2) * (i / N3), b = (b2 * r2) / r;
        const cu = cuExit * (r2 / r) * (1 - 0.04 * (r - r2) / (r3 - r2));
        const p0 = p02 + (p0dif - p02) * (i / N3);
        const st = continuity(2 * Math.PI * r2 * b2 * 0.97, T02, p0, cu);
        const x = f.diffuser.xHub - b * (1 - span);
        phi += (cu / r) * (((r3 - r2) / N3) / Math.max(st.cm, 1));
        push(polar(x, r), Math.hypot(st.cm, cu), st.T, st.p);
        cu3 = cu;
      }

      // 4 · chiocciola e condotto di mandata
      const v = f.volute;
      const tongue = (v.tongue * Math.PI) / 180;
      const ue = (((phi - tongue) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
      const ca = (span - 0.5) * 0.9, cb = -0.25 + 0.4 * Math.sin(phi * 3 + si);
      const steps = Math.max(3, Math.ceil((1 - ue) * 48));
      const p0Exit = p04;
      for (let i = 1; i <= steps + 16; i++) {
        const u = i <= steps ? ue + (1 - ue) * (i / steps) : 1 + (i - steps) / 16;
        const fr = voluteAt(v, u);
        const pos = fr.center.clone().addScaledVector(fr.e1, fr.radius * ca).addScaledVector(fr.e2, fr.radius * cb);
        const frac = u <= 1 ? 0.6 * u : 0.6 + 0.4 * (u - 1);
        const p0 = p0dif + (p0Exit - p0dif) * frac;
        let st;
        if (u <= 1) {
          // velocità nella spirale: momento della quantità di moto conservato
          const Rc = Math.hypot(fr.center.y, fr.center.z);
          const c = cu3 * r3 / Rc;
          const T = T02 - (c * c) / (2 * cp);
          st = { c, T, p: p0 * Math.pow(T / T02, ex) };
        } else {
          const q = continuity(Math.PI * fr.radius * fr.radius, T02, p0, 0);
          st = { c: q.cm, T: q.T, p: q.p };
        }
        push(pos, st.c, st.T, st.p);
        T04 = st.T;
      }
      paths.push({ s, total: t });
    }
  });

  const surge = inc * 180 / Math.PI > f.surgeIncidence;
  return {
    rpm, mdot, paths, pr, T02, T04, p04, work, power: mdot * work,
    etaStage: etaSt, etaImpeller: etaImp, sigma, u2, incidence: inc * 180 / Math.PI, machRelTip, c1,
    inlet: { u: u1m, cu: 0, cm: c1, bladeAngle: betaBlade * 180 / Math.PI },
    outlet: outletTri, surge, choke
  };
}

/* ------------------------------------------------------------------ */
/* Scale di colore                                                     */
/* ------------------------------------------------------------------ */
function colorScale(stops: ColorStops) {
  const s = stops.map(([v, c]) => [v, new THREE.Color(c)] as const);
  return (v: number, out: THREE.Color) => {
    if (v <= s[0][0]) return out.copy(s[0][1]);
    for (let i = 1; i < s.length; i++) if (v <= s[i][0]) { const [a, ca] = s[i - 1], [b, cb] = s[i]; return out.copy(ca).lerp(cb, (v - a) / (b - a)); }
    return out.copy(s[s.length - 1][1]);
  };
}
export const COLOR_INFO: Record<ColorMode, { label: string; unit: string; value: (q: Sample) => number }> = {
  T: { label: 'Temperatura statica del fluido', unit: '°C', value: q => q.T - 273.15 },
  p: { label: 'Pressione statica del fluido', unit: 'kPa', value: q => q.p / 1000 },
  c: { label: 'Velocità assoluta del fluido', unit: 'm/s', value: q => q.c }
};

/* ------------------------------------------------------------------ */
/* Frecce animate                                                      */
/* ------------------------------------------------------------------ */
export class FlowArrows {
  readonly mesh: THREE.InstancedMesh;
  private phases: number[] = [];
  private res: FlowResult | null = null;
  private scales: Record<ColorMode, (v: number, out: THREE.Color) => THREE.Color>;
  mode: ColorMode = 'T';
  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private col = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0); private dir = new THREE.Vector3(); private pos = new THREE.Vector3(); private sc = new THREE.Vector3();
  private cRef = 300;

  constructor(private def: FlowDef) {
    const L = def.arrows.size;
    const shaft = new THREE.CylinderGeometry(L * 0.09, L * 0.09, L * 0.62, 8); shaft.translate(0, L * 0.31, 0);
    const head = new THREE.ConeGeometry(L * 0.24, L * 0.38, 10); head.translate(0, L * 0.81, 0);
    const geo = mergeTwo(shaft, head); geo.translate(0, -L / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ metalness: 0.05, roughness: 0.45, emissive: '#ffffff', emissiveIntensity: 0.12 });
    const count = def.arrows.spans.length * def.arrows.angles * def.arrows.perPath;
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color('#ffffff'));
    for (let i = 0; i < count; i++) this.phases.push((i % def.arrows.perPath) / def.arrows.perPath + Math.random() * 0.04);
    this.scales = { T: colorScale(def.colors.T), p: colorScale(def.colors.p), c: colorScale(def.colors.c) };
  }

  setResult(res: FlowResult) {
    this.res = res;
    this.cRef = Math.max(...res.paths.flatMap(p => p.s.map(q => q.c)));
    this.update(0);
  }

  /** dtVis: secondi di animazione trascorsi */
  update(dtVis: number) {
    const res = this.res; if (!res) return;
    const per = this.def.arrows.perPath, info = COLOR_INFO[this.mode], scale = this.scales[this.mode];
    let n = 0;
    for (const path of res.paths) {
      const S = path.s;
      for (let j = 0; j < per; j++, n++) {
        let ph = this.phases[n] + dtVis / this.def.timeScale / path.total;
        ph -= Math.floor(ph);
        this.phases[n] = ph;
        const t = ph * path.total;
        let lo = 0, hi = S.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].t <= t) lo = mid; else hi = mid; }
        const a = S[lo], b = S[hi], f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
        this.pos.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
        this.dir.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
        this.q.setFromUnitVectors(this.up, this.dir);
        const c = a.c + (b.c - a.c) * f;
        const k = 0.55 + 0.75 * clamp(c / this.cRef, 0, 1);
        this.sc.set(k, k, k);
        this.m4.compose(this.pos, this.q, this.sc);
        this.mesh.setMatrixAt(n, this.m4);
        const val = info.value({ ...a, T: a.T + (b.T - a.T) * f, p: a.p + (b.p - a.p) * f, c });
        this.mesh.setColorAt(n, scale(val, this.col));
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const ai = a.toNonIndexed(), bi = b.toNonIndexed();
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal'] as const) {
    const x = ai.getAttribute(name).array as Float32Array, y = bi.getAttribute(name).array as Float32Array;
    const arr = new Float32Array(x.length + y.length); arr.set(x); arr.set(y, x.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* Triangoli di velocità (SVG)                                         */
/* ------------------------------------------------------------------ */
const fmt = (v: number, d = 0) => v.toFixed(d).replace('.', ',');

export function triangleSvg(tri: Triangle, which: 'in' | 'out', scale = 0.8) {
  // asse orizzontale: direzione tangenziale (verso di u); verticale: direzione meridiana del flusso
  const wu = tri.cu - tri.u;
  const pts = [[0, 0], [tri.cu, tri.cm], [wu, tri.cm]];
  const xs = pts.map(p => p[0]), minX = Math.min(...xs), maxX = Math.max(...xs);
  const padL = 64, padR = 64, padT = 26, padB = 30;
  const W = (maxX - minX) * scale + padL + padR, H = tri.cm * scale + padT + padB;
  const X = (vx: number) => padL + (vx - minX) * scale, Y = (vy: number) => H - padB - vy * scale;
  const n = which === 'in' ? '₁' : '₂';
  const line = (x0: number, y0: number, x1: number, y1: number, cls: string, label: string, lx: number, ly: number, anchor = 'middle') =>
    `<line x1="${X(x0).toFixed(1)}" y1="${Y(y0).toFixed(1)}" x2="${X(x1).toFixed(1)}" y2="${Y(y1).toFixed(1)}" class="${cls}" marker-end="url(#ah-${cls}-${which})"/>` +
    `<text x="${X(lx).toFixed(1)}" y="${Y(ly).toFixed(1)}" class="${cls}" text-anchor="${anchor}">${label}</text>`;
  const c = Math.hypot(tri.cu, tri.cm), w = Math.hypot(wu, tri.cm);
  const markers = ['tc', 'tw', 'tu'].map(cls => `<marker id="ah-${cls}-${which}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="${cls}"/></marker>`).join('');
  let extra = '';
  if (which === 'in' && tri.bladeAngle !== undefined) {
    // direzione della pala all'ingresso (tratteggiata): l'angolo tra w₁ e la pala è l'incidenza
    const bl = Math.tan(tri.bladeAngle * Math.PI / 180) * tri.cm;
    extra = `<line x1="${X(0).toFixed(1)}" y1="${Y(0).toFixed(1)}" x2="${X(-bl).toFixed(1)}" y2="${Y(tri.cm).toFixed(1)}" class="tb"/>`;
  }
  const beta = Math.atan2(Math.abs(wu), tri.cm) * 180 / Math.PI, alpha = Math.atan2(tri.cu, tri.cm) * 180 / Math.PI;
  const angleTxt = which === 'in' ? `β${n} = ${fmt(beta)}° dall'asse` : `α${n} = ${fmt(alpha)}° dalla direzione radiale`;
  return `<svg class="tri" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${W.toFixed(0)}" role="img" aria-label="Triangolo di velocità ${which === 'in' ? 'in ingresso' : 'in uscita'}">
    <defs>${markers}</defs>${extra}
    ${line(0, 0, tri.cu, tri.cm, 'tc', `c${n} ${fmt(c)} m/s`, tri.cu, tri.cm + 12 / scale, tri.cu >= wu ? 'start' : 'end')}
    ${line(0, 0, wu, tri.cm, 'tw', `w${n} ${fmt(w)} m/s`, wu, tri.cm + 12 / scale, tri.cu >= wu ? 'end' : 'start')}
    ${line(wu, tri.cm, tri.cu, tri.cm, 'tu', `u${n} ${fmt(tri.u)} m/s`, (wu + tri.cu) / 2, tri.cm + 22 / scale)}
    <text x="${X(0).toFixed(1)}" y="${(H - 10).toFixed(1)}" class="tl" text-anchor="middle">${esc(angleTxt)}</text>
  </svg>`;
}
