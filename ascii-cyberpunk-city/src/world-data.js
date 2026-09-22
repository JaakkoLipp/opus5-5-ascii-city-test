// ============================================================================
// world-data.js — compact world representation (the "database" of the city)
// ----------------------------------------------------------------------------
// The city is a wrap-around (toroidal) grid of S x S one-metre cells. Each
// cell stores at most two solid vertical spans:
//
//     floor span : [0, floorH]            road = 0, sidewalk = 0.15, sill ...
//     upper span : [spanLo, spanHi]       building = [0,h], interior = [3.6,h],
//                                         doorway lintel = [2.6,h] ...
//
// Everything that is not grid-aligned (lamp posts, trees, cars, people, signs)
// is an OBJECT made of analytic PRIMITIVES (oriented boxes, vertical cylinders,
// ellipsoids). Objects live in a flat Float32Array and are registered in a
// uniform spatial grid (static objects: CSR arrays built once; dynamic
// objects: per-frame linked lists) so a ray only tests objects in the cells
// it actually walks through.
//
// Lights are baked into per-cell lists (with a line-of-sight test) so shading
// a hit only iterates the handful of lights that can reach that cell.
// ============================================================================
AC.MAT = {
  NONE: 0, ASPHALT: 1, SIDEWALK: 2, CURB: 3, ALLEY: 4,
  CONCRETE: 5, PANEL: 6, BRICK: 7, GLASSWALL: 8, INDUSTRIAL: 9,
  ROOF: 10, INT_FLOOR: 11, INT_WALL: 12, CEILING: 13, SILL: 15, DOOR: 16,
  POLE: 17, LAMP: 18, TRUNK: 19, LEAVES: 20, PLANTER: 21,
  CAR_BODY: 22, CAR_CABIN: 23, HEADLIGHT: 24, TAILLIGHT: 25, TIRE: 26,
  PED_BODY: 27, PED_SKIN: 28, PED_LEGS: 29, UMBRELLA: 30,
  SIGN: 31, BILLBOARD: 32, SCREEN: 33, VENDING: 34, SIGNAL: 35, METAL: 36,
  HYDRANT: 37, NEON: 38, COUNTER: 39, WOOD: 40, DUMPSTER: 41, GRAFFITI: 42,
  HOVER: 43, AC_UNIT: 44, TANK: 45, BULB: 46, LANTERN: 47, CRATE: 48,
  AWNING: 49, VISOR: 50, BOLLARD: 51, HAIR: 52, CABINET: 53, STOOL: 54,
  CARPET: 55, PEDSIGNAL: 56, PIPE: 57, KIOSK: 58,
};

// Accent colours (linear-ish RGB). Index 0 = the monochrome phosphor channel.
AC.ACCENT = [
  [1, 1, 1],          // 0 mono (resolved to the phosphor colour at shade time)
  [1.0, 0.18, 0.62],  // 1 hot pink
  [0.12, 0.85, 1.0],  // 2 cyan
  [1.0, 0.70, 0.16],  // 3 amber
  [1.0, 0.13, 0.10],  // 4 red
  [0.22, 1.0, 0.32],  // 5 green
  [0.62, 0.28, 1.0],  // 6 violet
  [1.0, 0.88, 0.70],  // 7 warm white
  [0.22, 0.42, 1.0],  // 8 blue
  [1.0, 0.42, 0.06],  // 9 orange
];

AC.World = (function () {
  'use strict';

  // ---- cell flags
  const F = {
    ROAD: 1, SIDEWALK: 2, ALLEY: 4, BUILDING: 8, INTERIOR: 16, GLASS: 32,
    DOOR: 64, PLAZA: 128,
  };

  // ---- primitive layout (stride PS floats)
  const PS = 16;
  const P = {
    TYPE: 0, X: 1, Y: 2, Z0: 3, Z1: 4, HX: 5, HY: 6, C: 7, S: 8,
    MAT: 9, COL: 10, A: 11, B: 12, EMIT: 13, OBJ: 14, SEED: 15,
  };
  const T_BOX = 1, T_CYL = 2, T_SPH = 3;

  // ---- object layout (stride OS floats): AABB + prim range + wrap anchor
  const OS = 10;
  const O = { X0: 0, Y0: 1, X1: 2, Y1: 3, Z0: 4, Z1: 5, P0: 6, PN: 7, CX: 8, CY: 9 };

  // ---- light layout
  const L_STEADY = 0, L_FLICKER = 1, L_SIGN = 2, L_SIGNAL = 3, L_PULSE = 4, L_LAMP = 5, L_WINDOW = 6;

  class World {
    constructor(S, opts = {}) {
      this.S = S;
      const N = (this.N = S * S);
      this.floorH = new Float32Array(N);
      this.spanLo = new Float32Array(N);
      this.spanHi = new Float32Array(N);
      this.floorMat = new Uint8Array(N);
      this.wallMat = new Uint8Array(N);
      this.sideMat = new Uint8Array(N);
      this.flags = new Uint16Array(N);
      this.bld = new Int16Array(N).fill(-1);
      this.cellTop = new Float32Array(N);
      this.frameTop = new Float32Array(N);
      this.maxHeight = 0;

      const maxObjs = (this.maxObjs = opts.maxObjects || 8192);
      const maxPrims = (this.maxPrims = opts.maxPrims || 32768);
      this.prims = new Float32Array(maxPrims * PS);
      this.objs = new Float32Array(maxObjs * OS);
      this.objStamp = new Int32Array(maxObjs);
      this.objKind = new Uint8Array(maxObjs);
      this.nPrims = 0; this.nObjs = 0; this.nStaticPrims = 0; this.nStaticObjs = 0;
      this._p0 = 0;

      // static grid (CSR)
      this.stStart = new Int32Array(N + 1);
      this.stList = new Int32Array(0);
      // dynamic grid (per-frame singly linked lists)
      const maxReg = 32768;
      this.dynHead = new Int32Array(N).fill(-1);
      this.dynNext = new Int32Array(maxReg);
      this.dynObj = new Int32Array(maxReg);
      this.nReg = 0;

      // lights (static, baked into per-cell lists)
      this.lights = [];
      this.nLights = 0;
      this.lStart = new Int32Array(N + 1);
      this.lList = new Int32Array(0);

      // gameplay data (filled by worldgen)
      this.colliders = [];     // static 2D colliders {t:'c'|'b', x,y,r | hx,hy,c,s, z1}
      this.colGridStart = null; this.colGridList = null;
      this.buildings = [];
      this.signs = [];
      this.doors = [];
      this.interactables = [];
      this.emitters = [];      // steam etc.
      this.nav = null;
      this.lanes = null;
      this.spawn = { x: 14, y: 30, yaw: -Math.PI / 2 };
      this.manholes = [];
      this.npcs = [];          // stationary interior characters
    }

    idx(x, y) {
      const S = this.S;
      x = ((Math.floor(x) % S) + S) % S; y = ((Math.floor(y) % S) + S) % S;
      return y * S + x;
    }

    // ------------------------------------------------------------ prim writer
    beginObject() { this._p0 = this.nPrims; }

    _prim(type, x, y, z0, z1, hx, hy, yaw, mat, col, a, b, seed) {
      if (this.nPrims >= this.maxPrims) throw new Error('prim capacity exceeded');
      const o = this.nPrims++ * PS, p = this.prims;
      p[o] = type; p[o + 1] = x; p[o + 2] = y; p[o + 3] = z0; p[o + 4] = z1;
      p[o + 5] = hx; p[o + 6] = hy; p[o + 7] = Math.cos(yaw); p[o + 8] = Math.sin(yaw);
      p[o + 9] = mat; p[o + 10] = col || 0; p[o + 11] = a || 0; p[o + 12] = b || 0;
      p[o + 13] = 1; p[o + 14] = this.nObjs; p[o + 15] = seed || 0;
      return o;
    }
    // Oriented box: centre (x,y), half extents (hx along yaw, hy across), z range
    box(x, y, z0, z1, hx, hy, yaw, mat, col, a, b, seed) { return this._prim(T_BOX, x, y, z0, z1, hx, hy, yaw, mat, col, a, b, seed); }
    // Vertical cylinder with caps
    cyl(x, y, z0, z1, r, mat, col, a, b, seed) { return this._prim(T_CYL, x, y, z0, z1, r, r, 0, mat, col, a, b, seed); }
    // Ellipsoid: horizontal radius r, vertical radius rz, centre z = cz
    sph(x, y, cz, r, rz, mat, col, a, b, seed) { return this._prim(T_SPH, x, y, cz, rz, r, r, 0, mat, col, a, b, seed); }

    // Close the current object: compute its AABB from its prims.
    endObject(kind) {
      const p0 = this._p0, pn = this.nPrims - p0;
      if (pn <= 0) return -1;
      if (this.nObjs >= this.maxObjs) throw new Error('object capacity exceeded');
      const oi = this.nObjs++;
      let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
      const p = this.prims;
      for (let k = p0; k < p0 + pn; k++) {
        const o = k * PS;
        p[o + 14] = oi;
        const t = p[o], x = p[o + 1], y = p[o + 2];
        let ex, ey, zl, zh;
        if (t === T_BOX) {
          const c = Math.abs(p[o + 7]), s = Math.abs(p[o + 8]), hx = p[o + 5], hy = p[o + 6];
          ex = hx * c + hy * s; ey = hx * s + hy * c; zl = p[o + 3]; zh = p[o + 4];
        } else if (t === T_CYL) {
          ex = ey = p[o + 5]; zl = p[o + 3]; zh = p[o + 4];
        } else {
          ex = ey = p[o + 5]; zl = p[o + 3] - p[o + 4]; zh = p[o + 3] + p[o + 4];
        }
        if (x - ex < x0) x0 = x - ex; if (x + ex > x1) x1 = x + ex;
        if (y - ey < y0) y0 = y - ey; if (y + ey > y1) y1 = y + ey;
        if (zl < z0) z0 = zl; if (zh > z1) z1 = zh;
      }
      const ob = this.objs, q = oi * OS;
      ob[q] = x0; ob[q + 1] = y0; ob[q + 2] = x1; ob[q + 3] = y1; ob[q + 4] = z0; ob[q + 5] = z1;
      ob[q + 6] = p0; ob[q + 7] = pn; ob[q + 8] = (x0 + x1) * 0.5; ob[q + 9] = (y0 + y1) * 0.5;
      this.objKind[oi] = kind || 0;
      return oi;
    }

    // --------------------------------------------------------------- lights
    addLight(x, y, z, r, g, b, radius, intensity, anim, param, mono) {
      const S = this.S;
      this.lights.push({
        x: ((x % S) + S) % S, y: ((y % S) + S) % S, z, r, g, b, radius,
        intensity, anim: anim || 0, param: param || 0, mono: mono ? 1 : 0,
      });
      return this.lights.length - 1;
    }

    // Does the cell block light travelling at head height?
    blocksLight(ci) {
      if (this.flags[ci] & F.GLASS) return false;
      return this.spanHi[ci] > this.spanLo[ci] && this.spanLo[ci] < 1.2 && this.spanHi[ci] > 2.0;
    }

    // 2D grid line-of-sight between two points (excluding both end cells)
    los(x0, y0, x1, y1) {
      const S = this.S;
      let ix = Math.floor(x0), iy = Math.floor(y0);
      const ex = Math.floor(x1), ey = Math.floor(y1);
      const dx = x1 - x0, dy = y1 - y0;
      const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
      const tdx = Math.abs(dx) > 1e-9 ? Math.abs(1 / dx) : 1e30;
      const tdy = Math.abs(dy) > 1e-9 ? Math.abs(1 / dy) : 1e30;
      let tmx = Math.abs(dx) > 1e-9 ? (dx > 0 ? ix + 1 - x0 : x0 - ix) * tdx : 1e30;
      let tmy = Math.abs(dy) > 1e-9 ? (dy > 0 ? iy + 1 - y0 : y0 - iy) * tdy : 1e30;
      for (let guard = 0; guard < 256; guard++) {
        if (tmx < tmy) { if (tmx > 1) break; tmx += tdx; ix += sx; }
        else { if (tmy > 1) break; tmy += tdy; iy += sy; }
        if (ix === ex && iy === ey) break;
        const ci = ((((iy % S) + S) % S) * S) + (((ix % S) + S) % S);
        if (this.blocksLight(ci)) return false;
      }
      return true;
    }

    // ------------------------------------------------------------- finalize
    finalizeStatic() {
      const S = this.S, N = this.N;
      this.nStaticPrims = this.nPrims;
      this.nStaticObjs = this.nObjs;

      // cell tops from spans
      let maxH = 0;
      for (let i = 0; i < N; i++) {
        let top = this.floorH[i];
        if (this.spanHi[i] > this.spanLo[i] && this.spanHi[i] > top) top = this.spanHi[i];
        this.cellTop[i] = top;
        if (top > maxH) maxH = top;
      }
      // static object grid (two passes: count, fill)
      const counts = new Int32Array(N);
      const ob = this.objs;
      const forCells = (oi, fn) => {
        const q = oi * OS;
        const gx0 = Math.floor(ob[q]), gy0 = Math.floor(ob[q + 1]);
        const gx1 = Math.floor(ob[q + 2]), gy1 = Math.floor(ob[q + 3]);
        for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
          fn((((gy % S) + S) % S) * S + (((gx % S) + S) % S));
        }
      };
      for (let oi = 0; oi < this.nObjs; oi++) {
        const z1 = ob[oi * OS + 5];
        if (z1 > maxH) maxH = z1;
        forCells(oi, (ci) => { counts[ci]++; if (z1 > this.cellTop[ci]) this.cellTop[ci] = z1; });
      }
      this.maxHeight = maxH + 0.5;
      const start = this.stStart;
      start[0] = 0;
      for (let i = 0; i < N; i++) start[i + 1] = start[i] + counts[i];
      const list = new Int32Array(start[N]);
      const fill = new Int32Array(N);
      for (let oi = 0; oi < this.nObjs; oi++) {
        forCells(oi, (ci) => { list[start[ci] + fill[ci]++] = oi; });
      }
      this.stList = list;

      this._bakeLights();
      this._bakeColliders();
    }

    _bakeLights() {
      const S = this.S, N = this.N, L = this.lights, n = (this.nLights = L.length);
      this.lx = new Float32Array(n); this.ly = new Float32Array(n); this.lz = new Float32Array(n);
      this.lr = new Float32Array(n); this.lg = new Float32Array(n); this.lb = new Float32Array(n);
      this.lrad2 = new Float32Array(n); this.lbase = new Float32Array(n); this.lcur = new Float32Array(n);
      this.lanim = new Uint8Array(n); this.lparam = new Float32Array(n); this.lmono = new Uint8Array(n);
      const perCell = [];
      for (let i = 0; i < N; i++) perCell.push(null);
      let total = 0;
      for (let k = 0; k < n; k++) {
        const l = L[k];
        this.lx[k] = l.x; this.ly[k] = l.y; this.lz[k] = l.z;
        this.lr[k] = l.r; this.lg[k] = l.g; this.lb[k] = l.b;
        this.lrad2[k] = l.radius * l.radius; this.lbase[k] = l.intensity; this.lcur[k] = l.intensity;
        this.lanim[k] = l.anim; this.lparam[k] = l.param; this.lmono[k] = l.mono;
        const R = Math.ceil(l.radius);
        const cx = Math.floor(l.x), cy = Math.floor(l.y);
        for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
          const gx = cx + ox, gy = cy + oy;
          // distance from light to nearest point of the cell (2D)
          const nx = Math.max(gx, Math.min(l.x, gx + 1)), ny = Math.max(gy, Math.min(l.y, gy + 1));
          if ((nx - l.x) ** 2 + (ny - l.y) ** 2 > l.radius * l.radius) continue;
          if (!this.los(l.x, l.y, gx + 0.5, gy + 0.5)) continue;
          const ci = (((gy % S) + S) % S) * S + (((gx % S) + S) % S);
          (perCell[ci] || (perCell[ci] = [])).push(k);
          total++;
        }
      }
      const start = this.lStart, list = new Int32Array(total);
      let w = 0;
      for (let i = 0; i < N; i++) {
        start[i] = w;
        const a = perCell[i];
        if (a) for (let j = 0; j < a.length; j++) list[w++] = a[j];
      }
      start[N] = w;
      this.lList = list;
    }

    _bakeColliders() {
      // coarse grid of static colliders for player/NPC collision queries
      const S = this.S, N = this.N, C = this.colliders;
      const cells = [];
      for (let i = 0; i < N; i++) cells.push(null);
      C.forEach((c, k) => {
        const r = c.t === 'c' ? c.r : Math.hypot(c.hx, c.hy);
        for (let gy = Math.floor(c.y - r); gy <= Math.floor(c.y + r); gy++)
          for (let gx = Math.floor(c.x - r); gx <= Math.floor(c.x + r); gx++) {
            const ci = (((gy % S) + S) % S) * S + (((gx % S) + S) % S);
            (cells[ci] || (cells[ci] = [])).push(k);
          }
      });
      const start = new Int32Array(N + 1);
      let total = 0;
      for (let i = 0; i < N; i++) total += cells[i] ? cells[i].length : 0;
      const list = new Int32Array(total);
      let w = 0;
      for (let i = 0; i < N; i++) {
        start[i] = w;
        if (cells[i]) for (const k of cells[i]) list[w++] = k;
      }
      start[N] = w;
      this.colGridStart = start; this.colGridList = list;
    }

    // ------------------------------------------------------ dynamic objects
    resetDynamic() {
      this.nPrims = this.nStaticPrims;
      this.nObjs = this.nStaticObjs;
      this.dynHead.fill(-1);
      this.nReg = 0;
      this.frameTop.set(this.cellTop);
    }

    registerDynamic(oi) {
      const S = this.S, ob = this.objs, q = oi * OS;
      const gx0 = Math.floor(ob[q]), gy0 = Math.floor(ob[q + 1]);
      const gx1 = Math.floor(ob[q + 2]), gy1 = Math.floor(ob[q + 3]);
      const z1 = ob[q + 5];
      for (let gy = gy0; gy <= gy1; gy++) {
        const wy = ((gy % S) + S) % S;
        for (let gx = gx0; gx <= gx1; gx++) {
          if (this.nReg >= this.dynNext.length) return;
          const ci = wy * S + (((gx % S) + S) % S);
          const r = this.nReg++;
          this.dynObj[r] = oi;
          this.dynNext[r] = this.dynHead[ci];
          this.dynHead[ci] = r;
          if (z1 > this.frameTop[ci]) this.frameTop[ci] = z1;
        }
      }
    }
  }

  World.F = F; World.P = P; World.PS = PS; World.O = O; World.OS = OS;
  World.T_BOX = T_BOX; World.T_CYL = T_CYL; World.T_SPH = T_SPH;
  World.L = { STEADY: L_STEADY, FLICKER: L_FLICKER, SIGN: L_SIGN, SIGNAL: L_SIGNAL, PULSE: L_PULSE, LAMP: L_LAMP, WINDOW: L_WINDOW };
  return World;
})();
