import * as THREE from 'three';
import type { PumpDef } from '../machines/types';
import { makePath, type ColorInfo, type FlowPath, type Sample } from './flow';
import { clamp, lerpTable, smoothstep, voluteAt } from './geom';

/*
 * Flusso dell'acqua dentro la pompa singola (modello monodimensionale lungo linee di corrente, come nel
 * compressore ma per un fluido incomprimibile):
 * - velocità meridiana dalla continuità Q = c_m·A;
 * - nella girante la componente tangenziale cresce fino a c_u2 del triangolo di velocità in uscita
 *   (Eulero con scorrimento), nell'elica assiale con distribuzione a vortice libero (c_u·r = costante);
 * - pressione totale: sale con il lavoro u·c_u, le perdite (H_th − H) sono divise tra girante e parte fissa;
 *   pressione statica p = p₀ − ρc²/2;
 * - sul dorso delle pale, appena dopo il bordo d'attacco, la pressione cala ancora (carico della pala): il
 *   minimo è tarato in modo che con NPSHa = NPSHi tocchi la tensione di vapore. Dove p < p_v nascono le bolle,
 *   che implodono quando la pressione torna a salire.
 */

export interface PumpFlowInput {
  Qp: number; rpm: number;
  /** pressione totale assoluta all'ingresso della pompa (Pa) */
  pt1: number;
  /** prevalenza reale e di Eulero (m) */
  H: number; Hth: number;
  /** componente tangenziale e raggio all'uscita della girante (triangolo di velocità) */
  cu2: number;
  npsha: number; npshi: number;
  rho: number; g: number; pv: number;
}

export interface PumpFlowResult { paths: FlowPath[]; bubbles: boolean; pMin: number }

export const WATER_INFO: Record<string, ColorInfo> = {
  p: { label: 'Pressione assoluta dell’acqua', unit: 'kPa', value: q => q.p / 1000 },
  c: { label: 'Velocità assoluta dell’acqua', unit: 'm/s', value: q => q.c }
};

type Pt = Omit<Sample, 't'>;

export function solvePumpFlow(def: PumpDef, inp: PumpFlowInput): PumpFlowResult {
  const f = def.flow, { rho, pv } = inp;
  const Q = Math.max(inp.Qp, 1e-5), omega = (inp.rpm * 2 * Math.PI) / 60;
  const H = Math.max(0, inp.H), Hth = Math.max(inp.Hth, H);
  const pt1 = inp.pt1, ptExit = pt1 + rho * inp.g * H;
  // pressione totale all'uscita della parte rotante: 40 % delle perdite nella girante
  const pt2 = pt1 + rho * inp.g * (Hth - 0.4 * (Hth - H));
  const hub = f.impeller.hub, shr = f.impeller.shroud, M = hub.length;
  const paths: FlowPath[] = [];
  let pMin = Infinity, bubbles = false;

  // carico della pala: abbassamento di pressione sul dorso vicino al bordo d'attacco, massimo verso la cassa
  const dipShape = (m: number) => Math.exp(-(((m - 0.1) / 0.075) ** 2));
  const spanLoad = (span: number) => 0.55 + 0.45 * span;
  // pressione statica di riferimento all'ingresso della girante (lato cassa) e minimo voluto
  const r1s = shr[0][1], r1h = hub[0][1];
  const c1 = Q / (Math.PI * (r1s * r1s - r1h * r1h));
  const pRef = pt1 - 0.5 * rho * c1 * c1;
  const pTarget = pv + rho * inp.g * (inp.npsha - inp.npshi);
  const dip = Math.max(0, pRef - pTarget);

  const nS = f.arrows.spans.length, nA = f.arrows.angles;
  f.arrows.spans.forEach((span, si) => {
    for (let a = 0; a < nA; a++) {
      const pts: Pt[] = [];
      let phi = (2 * Math.PI * (a + si / nS)) / nA;
      const polar = (x: number, r: number) => new THREE.Vector3(x, r * Math.cos(phi), r * Math.sin(phi));
      const push = (v: THREE.Vector3, c: number, p: number, raw = p) => {
        pMin = Math.min(pMin, raw);
        // intensità delle bolle: dal deficit di pressione rispetto alla tensione di vapore (1 m di colonna = massimo)
        const b = raw < pv ? 0.45 + 0.55 * clamp((pv - raw) / (rho * inp.g), 0, 1) : 0;
        pts.push({ x: v.x, y: v.y, z: v.z, c, p: Math.max(p, pv * 0.6), b });
      };
      let lastPos: THREE.Vector3 | null = null;
      const advance = (pos: THREE.Vector3, cu: number, r: number, cm: number) => {
        if (lastPos) phi += (cu / Math.max(r, 1e-3)) * (pos.distanceTo(lastPos) / Math.max(cm, 0.05));
        lastPos = pos;
      };

      // 1 · condotto d'ingresso (con l'ogiva del mozzo)
      const inl = f.inlet, x0 = inl[0][0], x1 = inl[inl.length - 1][0], N1 = 22;
      for (let i = 0; i <= N1; i++) {
        const x = x0 + (x1 - x0) * (i / N1);
        const rc = lerpTable(inl.map(q => [q[0], q[1]]), x), rh = lerpTable(inl.map(q => [q[0], q[2]]), x);
        const c = Q / (Math.PI * (rc * rc - rh * rh));
        const pos = polar(x, rh + (rc - rh) * (0.08 + 0.84 * span));
        lastPos = pos;
        push(pos, c, pt1 - 0.5 * rho * c * c);
      }

      // 2 · girante (centrifuga) o elica (assiale)
      const axial = def.kind === 'assiale';
      const rm2 = axial ? Math.sqrt((hub[M - 1][1] ** 2 + shr[M - 1][1] ** 2) / 2) : hub[M - 1][1];
      let cuOut = 0, rOut = 0;
      for (let i = 0; i < M; i++) {
        const m = i / (M - 1);
        const [xh, rh] = hub[i], [xs, rs] = shr[i];
        const x = xh + (xs - xh) * span, r = rh + (rs - rh) * span;
        const width = Math.hypot(xs - xh, rs - rh), rbar = (rh + rs) / 2;
        const A = axial ? Math.PI * (rs * rs - rh * rh) : 2 * Math.PI * rbar * width * (1 - 0.06);
        const cm = Q / A;
        const u = omega * r;
        // c_u: dall'ingresso senza prerotazione al valore d'uscita; nell'elica vortice libero (c_u·r costante)
        const cuEnd = axial ? inp.cu2 * rm2 / r : inp.cu2 * (r / rm2);
        const cu = cuEnd * smoothstep(0.04, 1, m);
        const work = u * cu, workEnd = omega * rm2 * inp.cu2;
        const pt = pt1 + (pt2 - pt1) * clamp(work / Math.max(workEnd, 1e-6), 0, 1.2);
        const pos = polar(x, r);
        advance(pos, cu, r, cm);
        const pStat = pt - 0.5 * rho * (cm * cm + cu * cu);
        const raw = pStat - dip * dipShape(m) * spanLoad(span);
        push(pos, Math.hypot(cm, cu), raw, raw);
        if (i === M - 1) { cuOut = cu; rOut = r; }
      }

      if (!axial && f.volute) {
        // 3 · spazio senza palette fino alla chiocciola (c_u·r costante)
        const v = f.volute, r2 = hub[M - 1][1], b2 = Math.abs(hub[M - 1][0] - shr[M - 1][0]), N3 = 5;
        const xMid = (hub[M - 1][0] + shr[M - 1][0]) / 2;
        let cu3 = cuOut;
        for (let i = 1; i <= N3; i++) {
          const r = r2 + (v.r3 - r2) * (i / N3), cu = cuOut * rOut / r, cm = Q / (2 * Math.PI * r * b2);
          const pos = polar(xMid + (span - 0.5) * b2 * (1 - 0.5 * i / N3), r);
          advance(pos, cu, r, cm);
          const pt = pt2 - 0.1 * (pt2 - ptExit) * (i / N3);
          push(pos, Math.hypot(cm, cu), pt - 0.5 * rho * (cm * cm + cu * cu));
          cu3 = cu;
        }
        // 4 · chiocciola e bocca di mandata
        const tongue = (v.tongue * Math.PI) / 180;
        const ue = ((((phi - tongue) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI);
        const ca = (span - 0.5) * 0.9, cb = -0.25 + 0.4 * Math.sin(phi * 3 + si);
        const steps = Math.max(3, Math.ceil((1 - ue) * 40));
        for (let i = 1; i <= steps + 14; i++) {
          const uu = i <= steps ? ue + (1 - ue) * (i / steps) : 1 + (i - steps) / 14;
          const fr = voluteAt(v, uu);
          const pos = fr.center.clone().addScaledVector(fr.e1, fr.radius * ca).addScaledVector(fr.e2, fr.radius * cb);
          const frac = uu <= 1 ? 0.1 + 0.6 * uu : 0.7 + 0.3 * (uu - 1);
          const pt = pt2 + (ptExit - pt2) * frac;
          let c: number;
          if (uu <= 1) c = cu3 * v.r3 / Math.max(Math.hypot(fr.center.y, fr.center.z), v.r3);
          else c = Q / (Math.PI * fr.radius * fr.radius);
          push(pos, c, pt - 0.5 * rho * c * c);
        }
      } else if (axial && f.stator && f.diffuser && f.bend) {
        // 3 · raddrizzatore: la rotazione del flusso viene annullata e trasformata in pressione
        const st = f.stator, rhS = hub[M - 1][1], rsS = shr[M - 1][1], N3 = 12;
        const xEnd = hub[M - 1][0];
        for (let i = 1; i <= N3; i++) {
          const x = xEnd + (st.x1 - xEnd) * (i / N3);
          const r = rhS + (rsS - rhS) * span;
          const cm = Q / (Math.PI * (rsS * rsS - rhS * rhS));
          const cu = cuOut * rOut / r * (1 - smoothstep(st.x0, st.x1, x));
          const pos = polar(x, r);
          advance(pos, cu, r, cm);
          const pt = pt2 + (ptExit - pt2) * 0.4 * (i / N3);
          push(pos, Math.hypot(cm, cu), pt - 0.5 * rho * (cm * cm + cu * cu));
        }
        // 4 · diffusore conico
        const d = f.diffuser, N4 = 12;
        for (let i = 1; i <= N4; i++) {
          const x = d[0][0] + (d[d.length - 1][0] - d[0][0]) * (i / N4);
          const ro = lerpTable(d.map(q => [q[0], q[1]]), x), rh = lerpTable(d.map(q => [q[0], q[2]]), x);
          const c = Q / (Math.PI * (ro * ro - rh * rh));
          const pos = polar(x, rh + (ro - rh) * span);
          const pt = pt2 + (ptExit - pt2) * (0.4 + 0.3 * (i / N4));
          push(pos, c, pt - 0.5 * rho * c * c);
        }
        // 5 · curva a 90° verso l'alto e tronchetto di mandata
        const bd = f.bend, N5 = 18, rEnd = lerpTable(d.map(q => [q[0], q[1]]), bd.x) * 0.92;
        const off = (span * 0.84 + 0.08) * rEnd;
        const oy = off * Math.cos(phi), oz = off * Math.sin(phi);
        const cB = Q / (Math.PI * bd.r * bd.r);
        for (let i = 1; i <= N5 + 6; i++) {
          let cx: number, cy: number, nx: number, ny: number;
          if (i <= N5) {
            const al = (Math.PI / 2) * (i / N5);
            cx = bd.x + bd.R * Math.sin(al); cy = bd.R * (1 - Math.cos(al));
            nx = -Math.sin(al); ny = Math.cos(al);
          } else {
            cx = bd.x + bd.R; cy = bd.R + (bd.up - bd.R) * ((i - N5) / 6);
            nx = -1; ny = 0;
          }
          const pos = new THREE.Vector3(cx + nx * oy, cy + ny * oy, oz);
          const pt = pt2 + (ptExit - pt2) * (0.7 + 0.3 * (i / (N5 + 6)));
          push(pos, cB, pt - 0.5 * rho * cB * cB);
        }
      }

      // bolle: dove p < p_v, poi si richiudono (implosione) appena la pressione risale
      let prevB = 0;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        if (!q.b && prevB > 0) { const ds = Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y, q.z - pts[i - 1].z); q.b = prevB * Math.exp(-ds / 0.012); if (q.b < 0.04) q.b = 0; }
        prevB = q.b ?? 0;
        if (prevB > 0) bubbles = true;
      }
      paths.push(makePath(pts));
    }
  });
  return { paths, bubbles, pMin };
}

/* ------------------------------------------------------------------ */
/* Bolle di vapore                                                     */
/* ------------------------------------------------------------------ */
export class BubbleField {
  readonly mesh: THREE.InstancedMesh;
  private items: { path: FlowPath; t0: number; t1: number; ph: number; jitter: THREE.Vector3 }[] = [];
  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private pos = new THREE.Vector3(); private sc = new THREE.Vector3();
  timeScale: number;

  constructor(private size: number, private capacity: number, timeScale: number) {
    this.timeScale = timeScale;
    const geo = new THREE.SphereGeometry(1, 10, 8);
    const mat = new THREE.MeshStandardMaterial({ color: '#f4fbff', metalness: 0, roughness: 0.15, transparent: true, opacity: 0.85, emissive: '#bfe6ff', emissiveIntensity: 0.35 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  setPaths(paths: FlowPath[], perPath = 9) {
    this.items = [];
    for (const path of paths) {
      const S = path.s;
      const first = S.findIndex(q => (q.b ?? 0) > 0);
      if (first < 0) continue;
      let last = first;
      for (let i = first; i < S.length; i++) if ((S[i].b ?? 0) > 0) last = i;
      const t0 = S[Math.max(0, first - 1)].t, t1 = S[Math.min(S.length - 1, last + 1)].t;
      for (let j = 0; j < perPath && this.items.length < this.capacity; j++) {
        this.items.push({ path, t0, t1, ph: j / perPath + Math.random() * 0.1, jitter: new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(this.size * 3) });
      }
    }
    this.mesh.count = this.items.length;
    this.update(0);
  }

  update(dtVis: number) {
    let n = 0;
    for (const it of this.items) {
      const S = it.path.s, span = Math.max(it.t1 - it.t0, 1e-6);
      it.ph = (it.ph + dtVis / this.timeScale / span) % 1;
      const t = it.t0 + it.ph * span;
      let lo = 0, hi = S.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].t <= t) lo = mid; else hi = mid; }
      const a = S[lo], b = S[hi], f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      const size = ((a.b ?? 0) + ((b.b ?? 0) - (a.b ?? 0)) * f) * this.size;
      this.pos.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f).add(it.jitter);
      this.sc.setScalar(Math.max(size, 1e-5));
      this.m4.compose(this.pos, this.q, this.sc);
      this.mesh.setMatrixAt(n++, this.m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
