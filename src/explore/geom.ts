import * as THREE from 'three';
import type { VoluteSpec } from '../machines/types';

/* Funzioni geometriche condivise tra il modello 3D e la simulazione del flusso. */

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const smoothstep = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** interpolazione lineare in una tabella [[x, y], ...] ordinata per x, costante oltre gli estremi */
export function lerpTable(pts: [number, number][], x: number) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
  return pts[pts.length - 1][1];
}
/** derivata della tabella (pendenza del tratto che contiene x) */
export function slopeTable(pts: [number, number][], x: number) {
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0] || i === pts.length - 1) { const a = pts[i - 1], b = pts[i]; return (b[1] - a[1]) / (b[0] - a[0]); }
  return 0;
}

export interface VoluteFrame { center: THREE.Vector3; radius: number; tangent: THREE.Vector3; e1: THREE.Vector3; e2: THREE.Vector3 }

/**
 * Chiocciola: u ∈ [0, 1] percorre la spirale dalla lingua (angolo ψ = 2πu), u ∈ [1, 2] il condotto
 * di mandata. La sezione è un cerchio nel piano (e1, e2): e1 = asse x, e2 = normale nel piano della spirale.
 */
export function voluteAt(v: VoluteSpec, u: number): VoluteFrame {
  const rcAt = (q: number) => v.rc0 + (v.rcMax - v.rc0) * Math.sqrt(clamp(q, 0, 1));
  const spiral = (q: number) => {
    const phi = (v.tongue * Math.PI) / 180 + 2 * Math.PI * q, R = v.r3 + rcAt(q) * (1 - v.overlap);
    return new THREE.Vector3(v.x, R * Math.cos(phi), R * Math.sin(phi));
  };
  const e1 = new THREE.Vector3(1, 0, 0);
  if (u <= 1) {
    const q = clamp(u, 0, 1), h = 1e-3;
    const center = spiral(q);
    const tangent = spiral(Math.min(1, q + h)).sub(spiral(Math.max(0, q - h))).normalize();
    return { center, radius: rcAt(q), tangent, e1, e2: tangent.clone().cross(e1).normalize() };
  }
  const end = voluteAt(v, 1), s = clamp(u - 1, 0, 1);
  return {
    center: end.center.clone().addScaledVector(end.tangent, s * v.discharge.length),
    radius: v.rcMax + (v.discharge.rExit - v.rcMax) * s,
    tangent: end.tangent, e1, e2: end.e2
  };
}

/**
 * Superficie a griglia indicizzata (normali morbide). outward(i, j) indica il verso esterno:
 * serve a scegliere l'orientamento dei triangoli, perché la faccia posteriore è colorata come "sezione".
 */
export function gridSurface(nu: number, nv: number, pos: (i: number, j: number) => THREE.Vector3, outward: (i: number, j: number) => THREE.Vector3, closeV = false) {
  const verts: number[] = [], idx: number[] = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const p = pos(i, j); verts.push(p.x, p.y, p.z); }
  const ci = Math.floor((nu - 1) / 2), cj = Math.floor((nv - 1) / 2);
  const a = pos(ci, cj), b = pos(ci + 1, cj), c = pos(ci, cj + 1);
  const n = b.clone().sub(a).cross(c.clone().sub(a));
  const flip = n.dot(outward(ci, cj)) < 0;
  const cols = closeV ? nv : nv - 1;
  for (let i = 0; i < nu - 1; i++) for (let j = 0; j < cols; j++) {
    const j1 = (j + 1) % nv;
    const p00 = i * nv + j, p10 = (i + 1) * nv + j, p01 = i * nv + j1, p11 = (i + 1) * nv + j1;
    if (!flip) idx.push(p00, p10, p01, p10, p11, p01); else idx.push(p00, p01, p10, p10, p01, p11);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
