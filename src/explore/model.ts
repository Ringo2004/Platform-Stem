import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ComponentDef, MachineData, MaterialRef, MaterialSpec, Part, Profile, RadiusSpec, RingPattern, Shape } from '../machines/types';

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
  spools: Map<string, THREE.Group>;
  comps: Record<string, Comp>;
  pickables: THREE.Mesh[];
  allMats: MachineMaterial[];
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
function revolve(profile: Pt[], { seg = 96, phiStart = 0, phiLength = Math.PI * 2 } = {}) {
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
  g.rotateZ(-Math.PI / 2);
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
/* Costruzione                                                         */
/* ------------------------------------------------------------------ */
export function buildModel(data: MachineData, planes: THREE.Plane[]): MachineModel {
  const color = (c: string) => (c.startsWith('#') ? c : data.palette[c] ?? (console.warn(`Colore sconosciuto: ${c}`), '#ff00ff'));
  const FP = data.flowPath;
  const fp = (x: number, k: 1 | 2) => {
    if (x <= FP[0][0]) return FP[0][k];
    for (let i = 1; i < FP.length; i++) if (x <= FP[i][0]) { const a = FP[i - 1], b = FP[i]; return a[k] + (b[k] - a[k]) * (x - a[0]) / (b[0] - a[0]); }
    return FP[FP.length - 1][k];
  };
  const hubR = (x: number) => fp(x, 1), tipR = (x: number) => fp(x, 2);

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
  const spools = new Map<string, THREE.Group>();
  for (const id of Object.keys(data.spools)) { const g = new THREE.Group(); g.name = `spool:${id}`; root.add(g); spools.set(id, g); }
  const comps: Record<string, Comp> = {};
  const pickables: THREE.Mesh[] = [];
  const allMats: MachineMaterial[] = [];

  for (const def of data.components) {
    const group = new THREE.Group(); group.name = def.id;
    (def.spool ? spools.get(def.spool) ?? root : root).add(group);
    const c: Comp = { id: def.id, def, color: color(def.color), group, meshes: [], mats: new Set(), explode: new THREE.Vector3(...def.explode), parts: [] };
    comps[def.id] = c;

    let halves: { up: THREE.Group; lo: THREE.Group } | null = null;
    if (def.split) {
      const up = new THREE.Group(), lo = new THREE.Group();
      group.add(up, lo);
      c.parts.push({ obj: up, dir: new THREE.Vector3(0, def.split, 0) }, { obj: lo, dir: new THREE.Vector3(0, -def.split, 0) });
      halves = { up, lo };
    }
    const sideGroup = (side?: 'up' | 'lo') => (side && halves ? halves[side] : group);

    // materiali: quelli con nome sono condivisi, quelli scritti sul posto sono condivisi se identici
    const matCache = new Map<string, MachineMaterial>();
    const mat = (ref: MaterialRef): MachineMaterial => {
      const key = typeof ref === 'string' ? `@${ref}` : JSON.stringify(ref);
      let m = matCache.get(key);
      if (!m) {
        const spec: MaterialSpec | undefined = typeof ref === 'string' ? def.materials[ref] : ref;
        if (!spec) throw new Error(`${def.id}: materiale "${String(ref)}" non definito`);
        m = makeMat(color(spec.color), spec.T, planes, spec.metal, spec.rough);
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
        addInst(geo, m, all.filter(isUp), halves.up, p.casing);
        addInst(geo, m, all.filter(t => !isUp(t)), halves.lo, p.casing);
      } else addInst(geo, m, all, sideGroup(p.side), p.casing);
    };

    for (const p of def.parts) {
      const m = mat(p.mat);
      switch (p.type) {
        case 'revolve': {
          const prof = profile(p.profile);
          const seg = p.seg ?? 96;
          if (p.halves && halves) {
            add(revolve(prof, { ...HALF.up, seg }), m, halves.up, p.casing);
            add(revolve(prof, { ...HALF.lo, seg }), m, halves.lo, p.casing);
          } else add(revolve(prof, { seg }), m, sideGroup(p.side), p.casing);
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
            add(tor, m, halves.up, p.casing);
            const lo = tor.clone(); lo.rotateX(Math.PI); add(lo, m, halves.lo, p.casing);
          } else add(tor, m, sideGroup(p.side), p.casing);
          break;
        }
        case 'cylinder': {
          const g = new THREE.CylinderGeometry(p.r, p.r, p.h, p.seg ?? 16);
          if (p.axis === 'x') g.rotateZ(Math.PI / 2);
          g.translate(...p.at);
          add(g, m, sideGroup(p.side), p.casing);
          break;
        }
        case 'box': {
          const g = new THREE.BoxGeometry(...p.size); g.translate(...p.at);
          add(g, m, sideGroup(p.side), p.casing);
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
            add(mergeGeometries(gs), m, parent, p.casing);
            gs.forEach(g => g.dispose());
          }
          break;
        }
      }
    }
  }
  return { root, spools, comps, pickables, allMats };
}
