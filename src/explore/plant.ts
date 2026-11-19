import * as THREE from 'three';
import type { MachineData, PlantDef, PumpDef, Vec3 } from '../machines/types';
import { makeMat, type Comp, type MachineMaterial, type MachineModel } from './model';
import { suctionLayout, type OpResult, type PlantSettings } from './pump';
import { makePath, type FlowPath, type Sample } from './flow';

/*
 * Modello 3D dell'impianto di sollevamento. A differenza delle altre macchine la geometria dipende dai
 * parametri scelti (numero di pompe, serie/parallelo, quota d'installazione, salto geodetico), quindi è
 * generata qui e ricostruita a ogni cambiamento. Le pompe sono copie del modello 3D della macchina singola.
 *
 * Riferimento: y verso l'alto, y = 0 pelo libero del bacino di valle; le pompe sono allineate lungo z.
 * Le altezze sono in scala fino a 10 m; oltre, il bacino di monte è disegnato più in basso (fuori scala)
 * e un'etichetta riporta il salto vero. Le lunghezze delle condotte non sono in scala.
 */

export interface PlantLabel { n: string; label: string; x: number; y: number; z: number; flip?: boolean; kind?: 'cav1' | 'cav2' | 'info' }

export interface PlantScene extends MachineModel {
  rebuild(s: PlantSettings, machine: number, op: OpResult): void;
  labels: PlantLabel[];
  paths: FlowPath[];
  box: [Vec3, Vec3];
  /** livello di cavitazione per il bagliore delle pompe */
  cav: number;
}

/** altezza disegnata del bacino di monte */
export const drawnHeight = (Hg: number) => (Hg <= 10 ? Hg : 10 + (Hg - 10) * 0.4);

const BASIN = { x0: -7.5, x1: -1, wall: 0.4, floor: -7, top: 1.5, W: 4.4 };

interface Template { root: THREE.Object3D; def: PumpDef }

export function buildPlant(data: MachineData, pumps: { model: MachineModel; data: MachineData }[]): PlantScene {
  const plant = data.plant as PlantDef;
  const lay = plant.layout;
  const root = new THREE.Group();
  const comps: Record<string, Comp> = {};
  const pickables: THREE.Mesh[] = [];
  const allMats: MachineMaterial[] = [];
  const color = (c: string) => (c.startsWith('#') ? c : data.palette[c] ?? '#ff00ff');

  // materiali dei componenti (nessun piano di taglio nell'impianto)
  const mats: Record<string, Record<string, MachineMaterial>> = {};
  for (const def of data.components) {
    const group = new THREE.Group(); group.name = def.id; root.add(group);
    comps[def.id] = { id: def.id, def, color: color(def.color), group, meshes: [], mats: new Set(), explode: new THREE.Vector3(...def.explode), parts: [] };
    mats[def.id] = {};
    for (const [k, spec] of Object.entries(def.materials)) {
      const m = makeMat(color(spec.color), spec.T, [], spec.metal ?? 0.4, spec.rough ?? 0.5);
      if (k === 'water' || k === 'pipe') {
        // acqua e tubazioni in trasparenza: si vedono le frecce del flusso
        const op = k === 'water' ? 0.42 : 0.34;
        m.transparent = true; m.opacity = op; m.depthWrite = false; m.userData.opacity = op;
      }
      mats[def.id][k] = m; comps[def.id].mats.add(m); allMats.push(m);
    }
  }

  // copie delle pompe: materiali senza piani di taglio, condivisi tra le copie
  const templates: Template[] = pumps.map(p => {
    const t = p.model.root.clone(true);
    const cache = new Map<THREE.Material, MachineMaterial>();
    t.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as MachineMaterial;
      let m = cache.get(src);
      if (!m) {
        m = makeMat('#' + src.userData.base.getHexString(), src.userData.T, [], src.userData.metal, src.roughness);
        cache.set(src, m); comps.pompe.mats.add(m); allMats.push(m);
      }
      mesh.material = m;
    });
    return { root: t, def: p.data.pump as PumpDef };
  });
  const pumpMats = [...comps.pompe.mats];

  /* ---------------- primitive */
  const owned: THREE.BufferGeometry[] = [];
  const add = (id: string, geo: THREE.BufferGeometry, mat: MachineMaterial, casing = false) => {
    owned.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.comp = id; mesh.userData.casing = casing;
    comps[id].group.add(mesh); comps[id].meshes.push(mesh); pickables.push(mesh);
    return mesh;
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const box = (id: string, m: MachineMaterial, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return add(id, g, m);
  };
  /** cilindro (o tronco di cono) tra due punti */
  const cyl = (id: string, m: MachineMaterial, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0, seg = 28, open = false) => {
    const d = b.clone().sub(a), L = d.length();
    const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, open);
    g.translate(0, L / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()));
    g.translate(a.x, a.y, a.z);
    return add(id, g, m);
  };
  /** tubazione lungo una spezzata con curve raccordate */
  const pipe = (id: string, m: MachineMaterial, pts: THREE.Vector3[], r: number, bend = 0.5) => {
    const path = new THREE.CurvePath<THREE.Vector3>();
    let cur = pts[0].clone();
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (i < pts.length - 1) {
        const din = p.clone().sub(pts[i - 1]), dout = pts[i + 1].clone().sub(p);
        const rb = Math.min(bend, din.length() / 2, dout.length() / 2);
        const a = p.clone().addScaledVector(din.normalize(), -rb), b = p.clone().addScaledVector(dout.normalize(), rb);
        if (a.distanceTo(cur) > 1e-4) path.add(new THREE.LineCurve3(cur, a));
        path.add(new THREE.QuadraticBezierCurve3(a, p.clone(), b));
        cur = b;
      } else if (p.distanceTo(cur) > 1e-4) path.add(new THREE.LineCurve3(cur, p.clone()));
    }
    const len = path.getLength();
    const g = new THREE.TubeGeometry(path, Math.max(8, Math.ceil(len / 0.12)), r, 20, false);
    return add(id, g, m);
  };
  const flange = (id: string, m: MachineMaterial, at: THREE.Vector3, dir: THREE.Vector3, r: number) =>
    cyl(id, m, at.clone().addScaledVector(dir, -0.025), at.clone().addScaledVector(dir, 0.025), r * 1.35);

  /* ---------------- valvole */
  const checkValve = (at: THREE.Vector3, dir: THREE.Vector3, r: number) => {
    const m = mats.valvole.body, a = mats.valvole.trim;
    cyl('valvole', m, at.clone().addScaledVector(dir, -0.22), at.clone().addScaledVector(dir, 0.22), r * 1.25);
    flange('valvole', m, at.clone().addScaledVector(dir, -0.22), dir, r);
    flange('valvole', m, at.clone().addScaledVector(dir, 0.22), dir, r);
    // coperchio del clapet
    const side = Math.abs(dir.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0);
    cyl('valvole', a, at, at.clone().addScaledVector(side, r * 1.6), r * 0.7);
  };
  const gateValve = (at: THREE.Vector3, dir: THREE.Vector3, r: number) => {
    const m = mats.valvole.body, a = mats.valvole.trim;
    cyl('valvole', m, at.clone().addScaledVector(dir, -0.14), at.clone().addScaledVector(dir, 0.14), r * 1.3);
    flange('valvole', m, at.clone().addScaledVector(dir, -0.14), dir, r);
    flange('valvole', m, at.clone().addScaledVector(dir, 0.14), dir, r);
    const side = Math.abs(dir.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0);
    const top = at.clone().addScaledVector(side, r * 3.2);
    cyl('valvole', m, at, top, r * 0.45);
    // volantino
    const wheel = new THREE.TorusGeometry(r * 0.9, 0.025, 8, 28);
    wheel.lookAt(side);
    wheel.translate(top.x, top.y, top.z);
    add('valvole', wheel, a);
  };
  const butterfly = (at: THREE.Vector3, r: number, angle: number) => {
    const m = mats.valvole.body, a = mats.valvole.trim;
    cyl('valvole', m, at.clone().add(V(-0.12, 0, 0)), at.clone().add(V(0.12, 0, 0)), r * 1.32);
    const disc = new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.04, 32);
    disc.rotateZ(Math.PI / 2);
    disc.rotateY(angle);
    disc.translate(at.x, at.y, at.z);
    add('valvole', disc, a);
    cyl('valvole', m, at.clone().add(V(0, r * 1.3, 0)), at.clone().add(V(0, r * 2.2, 0)), r * 0.25);
    box('valvole', a, at.x - 0.2, at.x + 0.2, at.y + r * 2.2, at.y + r * 2.6, at.z - 0.18, at.z + 0.18);
  };

  /* ---------------- stato */
  const scene: PlantScene = {
    root, comps, pickables, allMats, labels: [], paths: [], box: [[-8, -8, -5], [20, 12, 5]], cav: 0,
    update(_angles, selected) {
      // bagliore delle pompe in cavitazione (rosso pulsante)
      if (selected === 'pompe') return;
      const t = performance.now() / 1000;
      const k = scene.cav >= 2 ? 0.35 + 0.25 * Math.sin(t * 9) : scene.cav === 1 ? 0.12 + 0.08 * Math.sin(t * 5) : 0;
      for (const m of pumpMats) { m.emissive.set(k > 0 ? '#ff3b2f' : '#000000'); m.emissiveIntensity = k; }
    },
    rebuild(s, machine, op) {
      // via le geometrie precedenti
      for (const c of Object.values(comps)) {
        for (const mesh of c.meshes) { mesh.parent?.remove(mesh); const i = pickables.indexOf(mesh); if (i >= 0) pickables.splice(i, 1); }
        c.meshes.length = 0;
      }
      owned.forEach(g => g.dispose()); owned.length = 0;
      build(s, machine, op);
    }
  };

  function build(s: PlantSettings, machine: number, op: OpResult) {
    const tpl = templates[machine], pd = tpl.def, mount = pd.mount;
    const N = s.N, series = s.series, z = s.z;
    const Hv = drawnHeight(s.Hg);
    const W = BASIN.W;
    const zs = Array.from({ length: N }, (_, k) => (k - (N - 1) / 2) * lay.spacing);
    const cm = mats.valle.concrete, water = mats.valle.water;

    /* bacino di valle (sezionato sul lato verso chi guarda) */
    box('valle', cm, BASIN.x0 - BASIN.wall, BASIN.x1 + BASIN.wall, BASIN.floor - 0.5, BASIN.floor, -W - BASIN.wall, W);
    box('valle', cm, BASIN.x0 - BASIN.wall, BASIN.x0, BASIN.floor, BASIN.top, -W - BASIN.wall, W);
    box('valle', cm, BASIN.x0, BASIN.x1, BASIN.floor, BASIN.top, -W - BASIN.wall, -W);
    box('valle', cm, BASIN.x1, BASIN.x1 + BASIN.wall, BASIN.floor, BASIN.top, -W - BASIN.wall, W);
    box('valle', water, BASIN.x0, BASIN.x1, BASIN.floor, 0, -W, W - 0.02);

    /* locale pompe: basamento con piano d'appoggio alla quota delle pompe */
    const floorY = z + mount.base;
    const xS0 = BASIN.x1 + BASIN.wall, xS1 = lay.headerX + 1.1;
    box('locale', mats.locale.concrete, xS0, xS1, BASIN.floor - 0.5, floorY, -W - BASIN.wall, W);
    if (floorY < BASIN.top - 0.05) box('locale', mats.locale.concrete, xS0, xS1, floorY, BASIN.top, -W - BASIN.wall, -W);

    /* pompe */
    const place = (k: number) => {
      const g = tpl.root.clone(true);
      g.position.set(lay.pumpX, z, zs[k]);
      g.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.userData.comp = 'pompe'; comps.pompe.meshes.push(o as THREE.Mesh); pickables.push(o as THREE.Mesh); } });
      comps.pompe.group.add(g);
      // il gruppo clonato va rimosso intero alla ricostruzione: lo si registra come "mesh" del componente
      comps.pompe.meshes.push(g as unknown as THREE.Mesh);
    };
    for (let k = 0; k < N; k++) place(k);
    const inlet = (k: number) => V(lay.pumpX + mount.inlet[0], z + mount.inlet[1], zs[k] + mount.inlet[2]);
    const outlet = (k: number) => V(lay.pumpX + mount.outlet[0], z + mount.outlet[1], zs[k] + mount.outlet[2]);

    const rS = plant.pipes.suction.D / 2, rB = plant.pipes.branch.D / 2, rM = plant.pipes.main.D / 2;
    const pipeM = mats.aspirazione.pipe, pipeD = mats.mandata.pipe;
    const sl = suctionLayout(plant, z);

    /* aspirazioni */
    const suctionPts: THREE.Vector3[][] = [];
    const nSuction = series ? 1 : N;
    for (let k = 0; k < nSuction; k++) {
      const pin = inlet(k), xr = pin.x - 0.35;
      // riduzione dal diametro della tubazione a quello della bocca della pompa
      cyl('aspirazione', mats.aspirazione.steel, V(xr, pin.y, pin.z), pin, rS, mount.inletR, 28, true);
      flange('aspirazione', mats.aspirazione.steel, pin, V(1, 0, 0), mount.inletR);
      const pts = sl.horizontal
        ? [V(lay.intakeX, pin.y, pin.z), V(xr, pin.y, pin.z)]
        : [V(lay.intakeX, sl.intakeY, pin.z), V(lay.intakeX, pin.y, pin.z), V(xr, pin.y, pin.z)];
      pipe('aspirazione', pipeM, pts, rS, 0.55);
      suctionPts.push(pts);
      const mouth = pts[0];
      if (sl.lift) {
        // valvola di fondo con succhieruola
        const v = mats.aspirazione.steel;
        cyl('aspirazione', v, mouth.clone().add(V(0, -0.05, 0)), mouth.clone().add(V(0, -0.38, 0)), rS * 1.3);
        const cage = new THREE.CylinderGeometry(rS * 1.45, rS * 1.45, 0.42, 24, 3, true);
        cage.translate(mouth.x, mouth.y - 0.6, mouth.z);
        add('aspirazione', cage, mats.aspirazione.strainer);
        cyl('aspirazione', v, mouth.clone().add(V(0, -0.81, 0)), mouth.clone().add(V(0, -0.84, 0)), rS * 1.45);
      } else if (sl.horizontal) {
        cyl('aspirazione', mats.aspirazione.steel, mouth.clone().add(V(-0.3, 0, 0)), mouth, rS * 1.7, rS, 28, true);
      } else {
        cyl('aspirazione', mats.aspirazione.steel, mouth.clone().add(V(0, -0.3, 0)), mouth, rS * 1.7, rS, 28, true);
      }
      if (!sl.lift) gateValve(V(BASIN.x1 + BASIN.wall + 0.45, pin.y, pin.z), V(1, 0, 0), rS);
    }

    /* mandate, collegamenti in serie, collettore */
    const riserTop = (k: number) => outlet(k).y + 1.9;
    const yH = riserTop(0);
    const branchPts: THREE.Vector3[][] = [];
    const linkPts: THREE.Vector3[][] = [];
    const expand = (k: number) => {
      const o = outlet(k);
      flange('mandata', mats.mandata.steel, o, V(0, 1, 0), mount.outletR);
      cyl('mandata', mats.mandata.steel, o, o.clone().add(V(0, 0.3, 0)), mount.outletR, rB, 28, true);
      return o.clone().add(V(0, 0.3, 0));
    };
    const delivering = series ? [N - 1] : zs.map((_, k) => k);
    for (const k of delivering) {
      const o0 = expand(k);
      const pts = [o0, V(o0.x, yH, o0.z), V(lay.headerX, yH, o0.z)];
      pipe('mandata', pipeD, pts, rB, 0.5);
      branchPts.push(pts);
      checkValve(o0.clone().add(V(0, 0.55, 0)), V(0, 1, 0), rB);
      gateValve(o0.clone().add(V(0, 1.2, 0)), V(0, 1, 0), rB);
    }
    if (series) {
      for (let k = 0; k < N - 1; k++) {
        const o0 = expand(k), pin = inlet(k + 1), xr = pin.x - 0.35;
        const yl = o0.y + 0.55, xb = xr - 0.55;
        const pts = [o0, V(o0.x, yl, o0.z), V(xb, yl, o0.z), V(xb, yl, pin.z), V(xb, pin.y, pin.z), V(xr, pin.y, pin.z)];
        pipe('mandata', pipeD, pts, rB, 0.35);
        cyl('mandata', mats.mandata.steel, V(xr, pin.y, pin.z), pin, rB, mount.inletR, 28, true);
        linkPts.push(pts);
      }
    }
    const zb = delivering.map(k => outlet(k).z);
    const zMin = Math.min(0, ...zb) - 0.35, zMax = Math.max(0, ...zb) + 0.35;
    cyl('mandata', pipeD, V(lay.headerX, yH, zMin), V(lay.headerX, yH, zMax), rM, rM, 28);
    for (const zz of [zMin, zMax]) cyl('mandata', mats.mandata.steel, V(lay.headerX, yH, zz), V(lay.headerX, yH, zz + (zz < 0 ? -0.03 : 0.03)), rM * 1.05);

    /* condotta di mandata fino al bacino di monte */
    const xU = lay.upperX, floorU = Hv - 4, yIn = floorU + 0.7;
    const mainPts = [V(lay.headerX, yH, 0), V(lay.headerX + 2.4, yH, 0), V(lay.headerX + 3.2, yH, 0), V(xU - 1.2, yIn, 0), V(xU + 1.0, yIn, 0)];
    pipe('mandata', pipeD, mainPts, rM, 0.8);
    // valvola di regolazione: il disco ruota quando strozza la portata
    const throttle = op.H > 0 ? Math.min(1, op.Hvalve / Math.max(op.H, 1e-6)) : 0;
    butterfly(V(lay.headerX + 1.4, yH, 0), rM, (Math.PI / 2) * 0.85 * Math.sqrt(throttle));

    /* bacino di monte e rilevato */
    const xU1 = xU + 7;
    const earth = mats.monte.earth;
    // rilevato: stretto sotto la condotta, largo quanto il bacino sotto il bacino di monte
    const yS = yH - rM - 0.05, yE = yIn - rM - 0.05;
    const slope = new THREE.Shape();
    slope.moveTo(lay.headerX + 1.9, BASIN.floor - 0.5);
    slope.lineTo(xU - 0.4, BASIN.floor - 0.5);
    slope.lineTo(xU - 0.4, yE);
    slope.lineTo(xU - 1.2, yE);
    slope.lineTo(lay.headerX + 3.2, yS);
    slope.lineTo(lay.headerX + 1.9, yS);
    slope.closePath();
    const eg = new THREE.ExtrudeGeometry(slope, { depth: W + 1.6, bevelEnabled: false });
    eg.translate(0, 0, -W - 0.4);
    add('monte', eg, earth);
    box('monte', earth, xU - 0.4, xU1 + 0.9, BASIN.floor - 0.5, floorU - 0.4, -W - 0.4, W);
    const cu = mats.monte.concrete;
    box('monte', cu, xU - 0.4, xU1 + 0.4, floorU - 0.4, floorU, -W - 0.4, W);
    box('monte', cu, xU - 0.4, xU, floorU, Hv + 0.8, -W - 0.4, W);
    box('monte', cu, xU1, xU1 + 0.4, floorU, Hv + 0.8, -W - 0.4, W);
    box('monte', cu, xU, xU1, floorU, Hv + 0.8, -W - 0.4, -W);
    box('monte', mats.monte.water, xU, xU1, floorU, Hv, -W, W - 0.02);

    /* etichette */
    const pumpTop = outlet(0).clone(); pumpTop.y = z + 0.45;
    const fmt = (v: number, d = 1) => v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
    const labels: PlantLabel[] = [
      { n: '1', label: 'Pelo libero di valle', x: (BASIN.x0 + BASIN.x1) / 2, y: 0, z: W },
      { n: '2', label: `Pompa · z = ${z > 0 ? '+' : z < 0 ? '−' : ''}${fmt(Math.abs(z))} m${z < 0 ? ' (sotto battente)' : ''}`, x: lay.pumpX, y: z + 0.5, z: zs[N - 1] + 0.6, flip: true },
      { n: '3', label: `Pelo libero di monte · H_g = ${fmt(s.Hg)} m${s.Hg > 10 ? ' (altezza fuori scala)' : ''}`, x: (xU + xU1) / 2, y: Hv, z: W, flip: true }
    ];
    if (op.Hvalve > 0.05) labels.push({ n: 'V', label: `Valvola di regolazione · ΔH = ${fmt(op.Hvalve)} m`, x: lay.headerX + 1.4, y: yH + rM * 2.6, z: 0, kind: 'info' });
    if (op.cav >= 1) labels.push({ n: '!', label: op.cav === 1 ? 'Cavitazione incipiente' : op.cav === 2 ? 'Cavitazione sviluppata' : 'La pompa non aspira più', x: pumpTop.x - 0.3, y: z + 0.3, z: zs[0] - 0.6, kind: op.cav === 1 ? 'cav1' : 'cav2' });
    scene.labels = labels;
    scene.cav = op.Q > 0 || op.cav === 3 ? op.cav : 0;
    const yTop = Math.max(Hv + 1.5, yH + 1.5, BASIN.top + 1);
    scene.box = [[BASIN.x0 - 0.6, BASIN.floor - 0.5, -W - 0.5], [xU1 + 1, yTop, W]];

    /* linee di corrente */
    scene.paths = op.Q > 1e-4 ? flowPaths() : [];
    function flowPaths(): FlowPath[] {
      const { rho } = plant.water, g = plant.g;
      const pAt = (pos: THREE.Vector3, c: number, E: number) => plant.patm + rho * g * (E - pos.y) - 0.5 * rho * c * c;
      const kin = (v: number) => (v * v) / (2 * g);
      const Qp = op.Qp, vS = op.v.suction, vB = op.v.branch, vM = op.v.main;
      const hs = op.losses.suction, hb = op.losses.branch, hl = series && N > 1 ? op.losses.link / (N - 1) : 0;
      const hIn = sl.K > 0 ? Math.min(hs, (sl.fittings[0][1] + (sl.fittings[1]?.[1] ?? 0)) * kin(vS)) : 0;
      const Hother = series && N > 1 ? (op.H - op.Hp) / (N - 1) : 0;
      const out: FlowPath[] = [];
      // nodi: posizione, velocità, energia (m sul pelo libero di valle); i segmenti si suddividono ogni 0,25 m
      type Node = { p: THREE.Vector3; c: number; E: number };
      const sample = (nodes: Node[]) => {
        const pts: Omit<Sample, 't'>[] = [];
        for (let i = 0; i < nodes.length; i++) {
          if (i === 0) { const n0 = nodes[0]; pts.push({ x: n0.p.x, y: n0.p.y, z: n0.p.z, c: n0.c, p: pAt(n0.p, n0.c, n0.E) }); continue; }
          const a = nodes[i - 1], b = nodes[i], L = a.p.distanceTo(b.p), k = Math.max(1, Math.ceil(L / 0.25));
          for (let j = 1; j <= k; j++) {
            const f = j / k, pos = a.p.clone().lerp(b.p, f), c = a.c + (b.c - a.c) * f, E = a.E + (b.E - a.E) * f;
            pts.push({ x: pos.x, y: pos.y, z: pos.z, c, p: pAt(pos, c, E) });
          }
        }
        return makePath(pts);
      };
      const along = (pts: THREE.Vector3[], c: number, E0: number, E1: number): Node[] => {
        let L = 0; const acc = [0];
        for (let i = 1; i < pts.length; i++) { L += pts[i].distanceTo(pts[i - 1]); acc.push(L); }
        return pts.map((p, i) => ({ p, c, E: E0 + (E1 - E0) * (L > 0 ? acc[i] / L : 1) }));
      };
      const mainNodes = (E0: number): Node[] => {
        // dal collettore allo sbocco: perdite distribuite e salto della valvola di regolazione
        const Eend = s.Hg + kin(vM);
        const valveX = lay.headerX + 1.4, hm = Math.max(0, E0 - op.Hvalve - Eend);
        const nodes: Node[] = [];
        const pts = mainPts;
        let L = 0; const acc = [0];
        for (let i = 1; i < pts.length; i++) { L += pts[i].distanceTo(pts[i - 1]); acc.push(L); }
        const xv = valveX - lay.headerX;
        pts.forEach((p, i) => {
          const f = acc[i] / L;
          if (i > 0 && acc[i - 1] < xv && acc[i] >= xv) {
            const pv = V(valveX, yH, 0), fv = xv / L;
            nodes.push({ p: pv.clone().add(V(-0.05, 0, 0)), c: vM, E: E0 - hm * fv });
            nodes.push({ p: pv.clone().add(V(0.05, 0, 0)), c: vM, E: E0 - hm * fv - op.Hvalve });
          }
          nodes.push({ p, c: vM, E: E0 - hm * f - (acc[i] >= xv ? op.Hvalve : 0) });
        });
        const last = pts[pts.length - 1];
        nodes.push({ p: last.clone().add(V(1.2, 0.4, 0)), c: Math.max(0.25, vM * 0.25), E: s.Hg });
        nodes.push({ p: last.clone().add(V(2.6, 0.9, 0)), c: 0.2, E: s.Hg });
        return nodes;
      };
      const pumpNodes = (k: number, E: number, H: number): Node[] => {
        const pin = inlet(k), po = outlet(k), cP = Qp / (Math.PI * mount.inletR * mount.inletR);
        const mid = V(lay.pumpX, z, zs[k]);
        return [{ p: pin, c: cP, E }, { p: mid, c: cP, E: E + H * 0.6 }, { p: po, c: Qp / (Math.PI * mount.outletR ** 2), E: E + H }];
      };
      const suctionNodes = (k: number): Node[] => {
        const pts = suctionPts[k], m = pts[0];
        const pre = sl.lift || !sl.horizontal ? m.clone().add(V(0, -1.3, 0)) : m.clone().add(V(-1.4, 0, 0));
        const pre2 = sl.lift || !sl.horizontal ? m.clone().add(V(-1.2, -2.2, 0)) : m.clone().add(V(-3, 0.3, 0));
        const body = along(pts, vS, -hIn, -hs);
        return [{ p: pre2, c: 0.15, E: 0 }, { p: pre, c: Math.max(0.3, vS * 0.4), E: 0 }, ...body, { p: inlet(k), c: vS, E: -hs }];
      };
      if (!series) {
        for (let k = 0; k < N; k++) {
          const E1 = -hs + op.Hp, E2 = E1 - hb;
          const nodes = [...suctionNodes(k), ...pumpNodes(k, -hs, op.Hp).slice(1), ...along(branchPts[k], vB, E1, E2), { p: V(lay.headerX, yH, 0), c: vM, E: E2 }, ...mainNodes(E2).slice(1)];
          out.push(sample(nodes));
        }
      } else {
        let nodes: Node[] = [...suctionNodes(0), ...pumpNodes(0, -hs, op.Hp).slice(1)];
        let E = -hs + op.Hp;
        for (let k = 0; k < N - 1; k++) {
          nodes = nodes.concat(along(linkPts[k], vB, E, E - hl));
          E -= hl;
          nodes = nodes.concat(pumpNodes(k + 1, E, Hother));
          E += Hother;
        }
        const E2 = E - hb;
        nodes = nodes.concat(along(branchPts[0], vB, E, E2), [{ p: V(lay.headerX, yH, 0), c: vM, E: E2 }], mainNodes(E2).slice(1));
        out.push(sample(nodes));
      }
      return out;
    }
  }
  return scene;
}
