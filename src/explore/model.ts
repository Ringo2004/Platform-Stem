import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CamSpec, ComponentDef, MachineData, MaterialRef, MaterialSpec, Part, Profile, RadiusSpec, RingPattern, Shape, Shape2D, Vec3 } from '../machines/types';

/*
 * Costruisce il modello Three.js a partire dalla descrizione dati della macchina.
 * Tutte le geometrie sono generate qui: il file JSON contiene solo numeri.
 */

type Pt = [number, number]; // [r, x]

export interface MachineMaterial extends THREE.MeshStandardMaterial {
  userData: { base: THREE.Color; T: number; metal: number; cap: { value: THREE.Color } };
}

export interface Comp {
  id: string;
  def: ComponentDef;
  color: string;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  mats: Set<MachineMaterial>;
  explode: THREE.Vector3;
  parts: { obj: THREE.Object3D; dir: THREE.Vector3 }[];
}

export interface MachineModel {
  root: THREE.Group;
  comps: Record<string, Comp>;
  pickables: THREE.Mesh[];
  /** materiali soggetti alla mappa temperature */
  allMats: MachineMaterial[];
  /** posiziona alberi e parti mobili per gli angoli dati (rad); selected = componente evidenziato */
  update(angles: Record<string, number>, selected: string | null): void;
}

const WHITE = new THREE.Color('#ffffff');
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Scala delle temperature                                             */
/* ------------------------------------------------------------------ */
export function temperatureScale(stops: [number, string][]) {
  const s = stops.map(([t, c]) => [t, new THREE.Color(c)] as const);
  return (T: number): THREE.Color => {
    if (T <= s[0][0]) return s[0][1].clone();
    for (let i = 1; i < s.length; i++) {
      if (T <= s[i][0]) {
        const [ta, ca] = s[i - 1], [tb, cb] = s[i];
        return ca.clone().lerp(cb, (T - ta) / (tb - ta));
      }
    }
    return s[s.length - 1][1].clone();
  };
}

/* ------------------------------------------------------------------ */
/* Materiali: faccia anteriore metallica, faccia posteriore = sezione  */
/* ------------------------------------------------------------------ */
function makeMat(hex: string, T: number, planes: THREE.Plane[], metal = 0.55, rough = 0.42): MachineMaterial {
  const m = new THREE.MeshStandardMaterial({ color: hex, metalness: metal, roughness: rough, side: THREE.DoubleSide, clippingPlanes: planes, clipIntersection: true }) as MachineMaterial;
  m.userData = { base: new THREE.Color(hex), T, metal, cap: { value: new THREE.Color(hex).lerp(WHITE, 0.28) } };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCap = m.userData.cap;
    shader.fragmentShader = 'uniform vec3 uCap;\n' + shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (!gl_FrontFacing) { gl_FragColor = vec4(uCap, gl_FragColor.a); }');
  };
  return m;
}

/* ------------------------------------------------------------------ */
/* Geometrie di base                                                   */
/* ------------------------------------------------------------------ */
// profilo [[r, x], ...] chiuso, rivoluzionato attorno all'asse x
function revolve(profile: Pt[], { seg = 96, phiStart = 0, phiLength = Math.PI * 2, axis = 'x' as 'x' | 'y' } = {}) {
  const pts = profile.slice();
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const [r1, x1] = pts[i], [r2, x2] = pts[(i + 1) % pts.length]; area += r1 * x2 - r2 * x1; }
  if (area < 0) pts.reverse();
  const geoms: THREE.BufferGeometry[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) continue;
    geoms.push(new THREE.LatheGeometry([new THREE.Vector2(a[0], a[1]), new THREE.Vector2(b[0], b[1])], seg, phiStart, phiLength));
  }
  const g = mergeGeometries(geoms, false);
  geoms.forEach(x => x.dispose());
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  return g;
}
const HALF = { up: { phiStart: Math.PI, phiLength: Math.PI }, lo: { phiStart: 0, phiLength: Math.PI } };

function strip(pts: Pt[], t: number): Pt[] {
  const off = pts.map((p, i): Pt => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dr = b[0] - a[0], dx = b[1] - a[1], L = Math.hypot(dr, dx) || 1;
    return [p[0] + t * dx / L, p[1] - t * dr / L];
  });
  return [...pts, ...off.reverse()];
}
function sample(x0: number, x1: number, rFn: (x: number) => number, n = 28): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n; out.push([rFn(x), x]); }
  return out;
}
const ringP = (r0: number, r1: number, x0: number, x1: number): Pt[] => [[r0, x0], [r1, x0], [r1, x1], [r0, x1]];
function discP(xc: number, rb: number, rim: number, tb: number, tw: number): Pt[] {
  const a = rb + 0.035;
  return [[rb, xc - tb / 2], [a, xc - tb / 2], [a, xc - tw / 2], [rim, xc - tw / 2], [rim, xc + tw / 2], [a, xc + tw / 2], [a, xc + tb / 2], [rb, xc + tb / 2]];
}
function lerpPoints(pts: [number, number][], x: number) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
  return pts[pts.length - 1][1];
}

// pala: corda lungo x, apertura lungo y (radiale), spessore lungo z (tangenziale)
function bladeGeo(chord: number, span: number, { thick = 0.1, stagger = 0, twist = 0, camber = 0.08, taper = 0.15 } = {}) {
  const g = new THREE.BoxGeometry(chord, span, chord * thick, 4, 6, 1);
  g.translate(0, span / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), z = p.getZ(i);
    const y = p.getY(i);
    const s = y / span;
    x *= (1 - taper * s);
    const xc = x / chord;
    z = z * (1 - 2.4 * xc * xc) + camber * chord * (0.25 - xc * xc);
    const a = (stagger + twist * (s - 0.5)) * DEG;
    p.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a));
  }
  g.computeVertexNormals();
  return g;
}

interface Transform { psi: number; x: number; r: number }
const ringAt = ({ n, x, r, offset = 0 }: RingPattern): Transform[] => Array.from({ length: n }, (_, i) => ({ psi: (i + offset) / n * Math.PI * 2, x, r }));
const isUp = (t: Transform) => Math.cos(t.psi) >= 0;

/* ------------------------------------------------------------------ */
/* Camme e forme piane                                                 */
/* ------------------------------------------------------------------ */
const wrapDeg = (d: number) => ((d % 360) + 540) % 360 - 180;

/** raggio del profilo di camma alla direzione t (gradi, nel riferimento della camma) */
export function camRadius(c: CamSpec, t: number) {
  const d = wrapDeg(t - c.angle);
  return Math.abs(d) < c.duration / 2 ? c.base + c.lift * 0.5 * (1 + Math.cos(2 * Math.PI * d / c.duration)) : c.base;
}

/** alzata di una punteria piana: funzione di supporto del profilo, tabellata grado per grado */
const liftTables = new Map<string, Float32Array>();
function flatFollowerLift(c: CamSpec) {
  const key = JSON.stringify(c);
  let tab = liftTables.get(key);
  if (!tab) {
    tab = new Float32Array(360);
    for (let b = 0; b < 360; b++) {
      let h = 0;
      for (let t = 0; t < 360; t += 0.5) h = Math.max(h, camRadius(c, t) * Math.cos((t - b) * DEG));
      tab[b] = Math.max(0, h - c.base);
    }
    liftTables.set(key, tab);
  }
  const table = tab;
  return (beta: number) => {
    const b = ((beta % 360) + 360) % 360, i = Math.floor(b), f = b - i;
    return table[i] * (1 - f) + table[(i + 1) % 360] * f;
  };
}

function hull2D(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function shapePoints(s: Shape2D): [number, number][] | null {
  const arc = (u: number, v: number, r: number, a0: number, a1: number, n: number) =>
    Array.from({ length: n + 1 }, (_, i): [number, number] => { const a = (a0 + (a1 - a0) * i / n) * DEG; return [u + r * Math.cos(a), v + r * Math.sin(a)]; });
  if ('rect' in s) { const [u0, v0, u1, v1] = s.rect; return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]; }
  if ('rrect' in s) {
    const [u0, v0, u1, v1, r] = s.rrect;
    return [...arc(u1 - r, v0 + r, r, -90, 0, 6), ...arc(u1 - r, v1 - r, r, 0, 90, 6), ...arc(u0 + r, v1 - r, r, 90, 180, 6), ...arc(u0 + r, v0 + r, r, 180, 270, 6)];
  }
  if ('polygon' in s) return s.polygon;
  if ('hull' in s) return hull2D(s.hull.flatMap(([u, v, r]) => arc(u, v, r, 0, 360, 64).slice(0, -1)));
  if ('sector' in s) {
    const [u, v, r0, r1, a0, a1] = s.sector, n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 6));
    const outer = arc(u, v, r1, a0, a1, n);
    return r0 > 0 ? [...outer, ...arc(u, v, r0, a1, a0, n)] : [...outer, [u, v]];
  }
  if ('cam' in s) {
    const c = s.cam, out: [number, number][] = [];
    for (let t = 0; t < 360; t += 2) { const r = camRadius(c, t); out.push([c.u + r * Math.cos(t * DEG), c.v + r * Math.sin(t * DEG)]); }
    return out;
  }
  return null; // circle
}
function toPath<T extends THREE.Path>(s: Shape2D, target: T): T {
  if ('circle' in s) { const [u, v, r] = s.circle; target.absarc(u, v, r, 0, Math.PI * 2, false); return target; }
  const pts = shapePoints(s)!;
  target.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) target.lineTo(pts[i][0], pts[i][1]);
  target.closePath();
  return target;
}
// (u, v, profondità) → coordinate del mondo; terne cicliche, quindi rotazioni proprie
const AXIS_MAP = {
  x: new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1),
  y: new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1),
  z: new THREE.Matrix4()
};

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private at: Vec3, private radius: number, private height: number, private turns: number) { super(); }
  getPoint(t: number, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(this.at[0] + this.radius * Math.cos(a), this.at[1] + this.height * t, this.at[2] + this.radius * Math.sin(a));
  }
}

/* ------------------------------------------------------------------ */
/* Costruzione                                                         */
/* ------------------------------------------------------------------ */
export function buildModel(data: MachineData, planes: THREE.Plane[]): MachineModel {
  const color = (c: string) => (c.startsWith('#') ? c : data.palette[c] ?? (console.warn(`Colore sconosciuto: ${c}`), '#ff00ff'));
  const FP = data.flowPath ?? [[0, 0, 0]];
  const fp = (x: number, k: 1 | 2) => {
    if (x <= FP[0][0]) return FP[0][k];
    for (let i = 1; i < FP.length; i++) if (x <= FP[i][0]) { const a = FP[i - 1], b = FP[i]; return a[k] + (b[k] - a[k]) * (x - a[0]) / (b[0] - a[0]); }
    return FP[FP.length - 1][k];
  };
  const hubR = (x: number) => fp(x, 1), tipR = (x: number) => fp(x, 2);

  // manovellismo: quota dello spinotto e inclinazione della biella in funzione dell'angolo di manovella a (rad)
  const crank = data.kinematics?.crank;
  const pinY = (a: number) => (crank ? crank.radius * Math.cos(a) + Math.sqrt(crank.rod ** 2 - (crank.radius * Math.sin(a)) ** 2) : 0);
  const rodAngle = (a: number) => (crank ? -Math.asin(crank.radius * Math.sin(a) / crank.rod) : 0);

  function radius(spec: RadiusSpec): (x: number) => number {
    if ('ref' in spec) { const f = spec.ref === 'hub' ? hubR : tipR, add = spec.add ?? 0; return x => f(x) + add; }
    if ('points' in spec) return x => lerpPoints(spec.points, x);
    const { r0, a, xRef, exp } = spec.bell;
    return x => r0 + a * Math.pow(x / xRef, exp);
  }
  function profile(p: Profile): Pt[] {
    if ('shell' in p) { const s = p.shell; return strip(sample(s.x0, s.x1, radius(s.r), s.n), s.t); }
    if ('ring' in p) return ringP(...p.ring);
    if ('disc' in p) return discP(...p.disc);
    if ('polygon' in p) return p.polygon;
    const { r, x, dr, dx, n, t } = p.arc;
    const arc: Pt[] = [];
    for (let i = 0; i <= n; i++) { const th = Math.PI * (1 - i / n); arc.push([r + dr * Math.cos(th), x + dx * Math.sin(th)]); }
    return strip(arc, t);
  }
  function shapeGeo(s: Shape): THREE.BufferGeometry {
    let g: THREE.BufferGeometry, offset;
    if ('cylinder' in s) {
      const c = s.cylinder;
      g = new THREE.CylinderGeometry(c.r, c.r, c.h, c.seg ?? 16);
      if (c.axis === 'x') g.rotateZ(Math.PI / 2);
      offset = c.offset;
    } else {
      g = new THREE.BoxGeometry(...s.box.size);
      offset = s.box.offset;
    }
    if (offset) g.translate(...offset);
    return g;
  }

  const root = new THREE.Group();
  const comps: Record<string, Comp> = {};
  const pickables: THREE.Mesh[] = [];
  const allMats: MachineMaterial[] = [];
  /** aggiornamenti per fotogramma (alberi, pistoni, bielle, valvole, gas) */
  const updaters: ((ang: Record<string, number>, selected: string | null) => void)[] = [];

  const strokeColors = data.cycle?.strokes.map(s => new THREE.Color(s.color)) ?? [];
  const FLASH = new THREE.Color('#ffd27a'), ACCENT = new THREE.Color('#f0a43a'), BLACK = new THREE.Color('#000000');

  for (const def of data.components) {
    const group = new THREE.Group(); group.name = def.id;
    root.add(group);
    const c: Comp = { id: def.id, def, color: color(def.color), group, meshes: [], mats: new Set(), explode: new THREE.Vector3(...def.explode), parts: [] };
    comps[def.id] = c;

    let halves: { up: THREE.Group; lo: THREE.Group } | null = null;
    if (def.split) {
      const up = new THREE.Group(), lo = new THREE.Group();
      group.add(up, lo);
      c.parts.push({ obj: up, dir: new THREE.Vector3(0, def.split, 0) }, { obj: lo, dir: new THREE.Vector3(0, -def.split, 0) });
      halves = { up, lo };
    }

    // alberi rotanti: un perno per ogni (gruppo, albero), con l'asse eventualmente fuori centro
    const pivots = new Map<string, THREE.Object3D>();
    const spoolParent = (parent: THREE.Object3D, spool: string) => {
      const key = `${parent.uuid}:${spool}`;
      let t = pivots.get(key);
      if (!t) {
        const sd = data.spools[spool];
        if (!sd) throw new Error(`${def.id}: albero "${spool}" non definito`);
        const [cy, cz] = sd.center ?? [0, 0];
        const pivot = new THREE.Group(); pivot.position.set(0, cy, cz); parent.add(pivot);
        updaters.push(ang => { pivot.rotation.x = ang[spool] ?? 0; });
        if (cy || cz) { const off = new THREE.Group(); off.position.set(0, -cy, -cz); pivot.add(off); t = off; } else t = pivot;
        pivots.set(key, t);
      }
      return t;
    };
    // moto delle parti: un contenitore che viene spostato a ogni fotogramma
    const motionParent = (parent: THREE.Object3D, p: Part) => {
      const m = p.motion;
      if (!m) return parent;
      const holder = new THREE.Group(); parent.add(holder);
      if ('piston' in m) {
        const ph = m.piston.phase * DEG, y0 = pinY(ph), spool = crank!.spool;
        updaters.push(ang => { holder.position.y = pinY((ang[spool] ?? 0) + ph) - y0; });
        return holder;
      }
      if ('rod' in m) {
        const ph = m.rod.phase * DEG, y0 = pinY(ph), b0 = rodAngle(ph), x = m.rod.x, spool = crank!.spool;
        holder.position.set(x, y0, 0);
        const inner = new THREE.Group(); inner.position.set(-x, -y0, 0); holder.add(inner);
        updaters.push(ang => { const a = (ang[spool] ?? 0) + ph; holder.position.y = pinY(a); holder.rotation.x = rodAngle(a) - b0; });
        return inner;
      }
      const v = m.valve, lift = flatFollowerLift(v.cam);
      // la punteria è sotto la camma (direzione 180°): nel riferimento della camma è a 180° − α
      const liftAt = (ang: Record<string, number>) => lift(180 - (ang[v.spool] ?? 0) / DEG);
      if (v.spring) {
        const [yb, yt] = v.spring;
        holder.position.y = yb;
        const inner = new THREE.Group(); inner.position.y = -yb; holder.add(inner);
        updaters.push(ang => { holder.scale.y = (yt - liftAt(ang) - yb) / (yt - yb); });
        return inner;
      }
      updaters.push(ang => { holder.position.y = -liftAt(ang); });
      return holder;
    };

    const sideGroup = (side?: 'up' | 'lo') => (side && halves ? halves[side] : group);
    const container = (base: THREE.Object3D, p: Part) => {
      const spool = p.spool ?? def.spool;
      return motionParent(spool ? spoolParent(base, spool) : base, p);
    };

    const clipPlanes = def.clip === false ? [] : planes;
    // materiali: quelli con nome sono condivisi, quelli scritti sul posto sono condivisi se identici
    const matCache = new Map<string, MachineMaterial>();
    const specOf = (ref: MaterialRef): MaterialSpec => {
      const spec = typeof ref === 'string' ? def.materials[ref] : ref;
      if (!spec) throw new Error(`${def.id}: materiale "${String(ref)}" non definito`);
      return spec;
    };
    const mat = (ref: MaterialRef): MachineMaterial => {
      const key = typeof ref === 'string' ? `@${ref}` : JSON.stringify(ref);
      let m = matCache.get(key);
      if (!m) {
        const spec = specOf(ref);
        m = makeMat(color(spec.color), spec.T, clipPlanes, spec.metal, spec.rough);
        matCache.set(key, m); allMats.push(m);
      }
      return m;
    };

    const add = (geo: THREE.BufferGeometry, m: MachineMaterial, parent: THREE.Object3D, casing = false) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.userData.comp = c.id; mesh.userData.casing = casing;
      parent.add(mesh); c.meshes.push(mesh); c.mats.add(m); pickables.push(mesh);
      return mesh;
    };
    const addInst = (geo: THREE.BufferGeometry, m: MachineMaterial, transforms: Transform[], parent: THREE.Object3D, casing = false) => {
      const im = new THREE.InstancedMesh(geo, m, transforms.length);
      const m4 = new THREE.Matrix4();
      transforms.forEach((t, k) => { m4.makeRotationX(t.psi); m4.setPosition(t.x, t.r * Math.cos(t.psi), t.r * Math.sin(t.psi)); im.setMatrixAt(k, m4); });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.userData.comp = c.id; im.userData.casing = casing;
      parent.add(im); c.meshes.push(im); c.mats.add(m); pickables.push(im);
      return im;
    };
    const addSplit = (geo: THREE.BufferGeometry, m: MachineMaterial, all: Transform[], p: Part) => {
      if ('split' in p && p.split && halves) {
        addInst(geo, m, all.filter(isUp), container(halves.up, p), p.casing);
        addInst(geo, m, all.filter(t => !isUp(t)), container(halves.lo, p), p.casing);
      } else addInst(geo, m, all, container(sideGroup(p.side), p), p.casing);
    };
    const place = (p: Part) => container(sideGroup(p.side), p);

    for (const p of def.parts) {
      if (p.type === 'charge') {
        // colonna di gas: cilindro unitario scalato tra cielo del pistone e testata
        const spec = specOf(p.mat);
        const m = makeMat(color(spec.color), spec.T, clipPlanes, spec.metal ?? 0, spec.rough ?? 0.6);
        const geo = new THREE.CylinderGeometry(p.r, p.r, 1, 40); geo.translate(0, 0.5, 0);
        const mesh = add(geo, m, place(p));
        mesh.position.x = p.x;
        const ph = p.phase * DEG, cyc = data.cycle, spool = crank?.spool ?? '';
        const offset = cyc?.cylinders[p.cylinder]?.offset ?? 0, len = cyc?.length ?? 720, n = strokeColors.length;
        updaters.push((ang, selected) => {
          const a = ang[spool] ?? 0;
          const yc = pinY(a + ph) + p.crown;
          mesh.position.y = yc; mesh.scale.y = Math.max(1e-4, p.top - yc);
          if (!n) return;
          const local = (((a / DEG - offset) % len) + len) % len, k = Math.floor(local / (len / n)), f = (local % (len / n)) / (len / n);
          // colore della fase, sfumato verso la fase successiva nell'ultimo quarto
          const col = strokeColors[k].clone();
          if (f > 0.75) col.lerp(strokeColors[(k + 1) % n], (f - 0.75) / 0.25);
          m.color.copy(col); m.userData.cap.value.copy(col).lerp(WHITE, 0.2);
          // lampo della scintilla all'inizio dell'espansione (terza fase)
          const flash = k === 2 ? Math.max(0, 1 - f * 5) : 0;
          if (selected === c.id) { m.emissive.copy(ACCENT); m.emissiveIntensity = 0.22; }
          else { m.emissive.copy(flash > 0 ? FLASH : BLACK); m.emissiveIntensity = flash * 1.4; }
        });
        continue;
      }
      const m = mat(p.mat);
      switch (p.type) {
        case 'revolve': {
          const prof = profile(p.profile);
          const seg = p.seg ?? 96, axis = p.axis ?? 'x';
          if (p.halves && halves) {
            add(revolve(prof, { ...HALF.up, seg }), m, container(halves.up, p), p.casing);
            add(revolve(prof, { ...HALF.lo, seg }), m, container(halves.lo, p), p.casing);
          } else {
            const g = revolve(prof, { seg, axis });
            if (p.at) g.translate(...p.at);
            add(g, m, place(p), p.casing);
          }
          break;
        }
        case 'row': {
          const rh = p.root ?? hubR(p.x), rt = p.tip ?? tipR(p.x);
          const geo = bladeGeo(p.chord, rt - rh - 0.004, { thick: p.thick ?? 0.1, stagger: p.stagger, twist: p.twist ?? 0, camber: p.camber ?? 0.1, taper: p.taper ?? 0.15 });
          const all: Transform[] = [];
          const rotor = p.rotor ?? true;
          for (let i = 0; i < p.n; i++) all.push({ psi: (i + (rotor ? 0 : 0.5)) / p.n * Math.PI * 2, x: p.x, r: rh });
          addSplit(geo, m, all, p);
          break;
        }
        case 'torus': {
          const tor = new THREE.TorusGeometry(p.r, p.tube, p.radialSeg ?? 8, p.tubularSeg ?? 64, p.halves ? Math.PI : Math.PI * 2);
          tor.rotateY(Math.PI / 2); tor.translate(p.x, 0, 0);
          if (p.halves && halves) {
            add(tor, m, container(halves.up, p), p.casing);
            const lo = tor.clone(); lo.rotateX(Math.PI); add(lo, m, container(halves.lo, p), p.casing);
          } else add(tor, m, place(p), p.casing);
          break;
        }
        case 'cylinder': {
          const g = new THREE.CylinderGeometry(p.r, p.r, p.h, p.seg ?? 16);
          if (p.axis === 'x') g.rotateZ(Math.PI / 2);
          if (p.axis === 'z') g.rotateX(Math.PI / 2);
          g.translate(...p.at);
          add(g, m, place(p), p.casing);
          break;
        }
        case 'box': {
          const g = new THREE.BoxGeometry(...p.size); g.translate(...p.at);
          add(g, m, place(p), p.casing);
          break;
        }
        case 'bar': {
          const a = new THREE.Vector3(...p.from), b = new THREE.Vector3(...p.to), d = b.clone().sub(a);
          const g = new THREE.CylinderGeometry(p.r, p.r, d.length(), p.seg ?? 16);
          g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
          g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
          add(g, m, place(p), p.casing);
          break;
        }
        case 'tube': {
          let curve: THREE.Curve<THREE.Vector3>, segs = p.seg ?? 48;
          if (p.helix) { const h = p.helix; curve = new HelixCurve(h.at, h.radius, h.height, h.turns); segs = p.seg ?? Math.ceil(h.turns * 28); }
          else curve = new THREE.CatmullRomCurve3((p.points ?? []).map(q => new THREE.Vector3(...q)), !!p.closed, 'centripetal');
          add(new THREE.TubeGeometry(curve, segs, p.r, p.radialSeg ?? 12, !!p.closed), m, place(p), p.casing);
          break;
        }
        case 'extrude': {
          const shape = toPath(p.shape, new THREE.Shape());
          for (const h of p.holes ?? []) shape.holes.push(toPath(h, new THREE.Path()));
          const g = new THREE.ExtrudeGeometry(shape, { depth: p.to - p.from, bevelEnabled: false, curveSegments: 40 });
          g.translate(0, 0, p.from);
          g.applyMatrix4(AXIS_MAP[p.axis]);
          add(g, m, place(p), p.casing);
          break;
        }
        case 'instances': {
          addSplit(shapeGeo(p.shape), m, p.rings.flatMap(ringAt), p);
          break;
        }
        case 'splitFlanges': {
          // flange del piano di divisione orizzontale, una fila per lato in ciascuna metà
          for (const sign of [1, -1]) {
            const gs: THREE.BufferGeometry[] = [];
            for (let i = 0; i < p.count; i++) {
              const xm = p.xStart + i * p.step, r = tipR(xm) + p.tipOffset;
              for (const side of [1, -1]) { const b = new THREE.BoxGeometry(p.len, p.height, p.width); b.translate(xm, sign * p.height / 2, side * r); gs.push(b); }
            }
            const parent = halves ? (sign > 0 ? halves.up : halves.lo) : group;
            add(mergeGeometries(gs), m, container(parent, p), p.casing);
            gs.forEach(g => g.dispose());
          }
          break;
        }
      }
    }
  }
  return {
    root, comps, pickables, allMats,
    update(angles, selected) { for (const u of updaters) u(angles, selected); }
  };
}
