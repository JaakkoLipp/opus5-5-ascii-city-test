// ============================================================================
// entities.js — dynamic world state: cars, pedestrians, hover cars, NPCs, doors
// ----------------------------------------------------------------------------
// Entities are plain data records. Every frame `emit()` turns them into
// primitives with the same model builders used for static props, registers
// them in the per-frame dynamic grid and publishes dynamic lights
// (headlights, strobes, LED umbrellas) for the shader.
// ============================================================================
AC.dynLights = (function () {
  const N = 64, B = 10;            // up to 64 lights, 10x10 buckets of 8 m over the 80 m tile
  const f = () => new Float32Array(N);
  const D = { n: 0, max: N, x: f(), y: f(), z: f(), dx: f(), dy: f(), dz: f(), cos: f(), r2: f(), I: f(), r: f(), g: f(), b: f(), mono: new Uint8Array(N),
    B, bSize: 8, bStart: new Int32Array(B * B + 1), bList: new Int16Array(N * 9), bCount: new Int32Array(B * B) };
  // Bucket every light into the 8 m cells its radius touches so the shader
  // only tests lights near the shaded point.
  D.build = function () {
    const cnt = D.bCount; cnt.fill(0);
    const spans = [];
    for (let k = 0; k < D.n; k++) {
      const r = Math.sqrt(D.r2[k]);
      const x0 = Math.floor((D.x[k] - r) / 8), x1 = Math.floor((D.x[k] + r) / 8);
      const y0 = Math.floor((D.y[k] - r) / 8), y1 = Math.floor((D.y[k] + r) / 8);
      spans.push(x0, x1, y0, y1);
      for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) cnt[(((by % B) + B) % B) * B + (((bx % B) + B) % B)]++;
    }
    let w = 0;
    for (let i = 0; i < B * B; i++) { D.bStart[i] = w; w += cnt[i]; cnt[i] = 0; }
    D.bStart[B * B] = w;
    if (D.bList.length < w) D.bList = new Int16Array(w * 2);
    for (let k = 0; k < D.n; k++) {
      const [x0, x1, y0, y1] = spans.slice(k * 4, k * 4 + 4);
      for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) {
        const b = (((by % B) + B) % B) * B + (((bx % B) + B) % B);
        D.bList[D.bStart[b] + cnt[b]++] = k;
      }
    }
  };
  return D;
})();

AC.Entities = (function () {
  'use strict';
  const { RNG, wrap, wrapDelta } = AC.util;
  const Models = AC.Models;
  const DLT = AC.dynLights;

  function addDynLight(x, y, z, dx, dy, dz, cos, radius, I, r, g, b, mono) {
    const k = DLT.n;
    if (k >= DLT.max || I <= 0.01) return;
    DLT.n++;
    DLT.x[k] = x; DLT.y[k] = y; DLT.z[k] = z; DLT.dx[k] = dx; DLT.dy[k] = dy; DLT.dz[k] = dz;
    DLT.cos[k] = cos; DLT.r2[k] = radius * radius; DLT.I[k] = I; DLT.r[k] = r; DLT.g[k] = g; DLT.b[k] = b; DLT.mono[k] = mono ? 1 : 0;
  }

  class System {
    constructor(W, seed) {
      this.W = W; this.S = W.S;
      this.rng = new RNG(seed);
      this.cars = []; this.peds = []; this.hovers = []; this.npcs = [];
      this.colliders = [];
      this._spawnCars(11);
      this._spawnPeds(24);
      this._spawnHovers(7);
      this._spawnNpcs();
    }

    // ---------------------------------------------------------------- spawn
    _spawnCars(n) {
      const r = this.rng, S = this.S, lanes = this.W.lanes;
      const taken = lanes.map(() => []);
      for (let k = 0; k < n; k++) {
        const li = k % lanes.length;
        let s = 0, ok = false;
        for (let tries = 0; tries < 50 && !ok; tries++) {
          s = r.range(20, S - 6);
          ok = taken[li].every((o) => Math.abs(o - s) > 11);
        }
        taken[li].push(s);
        const type = r.chance(0.18) ? 'taxi' : r.chance(0.1) ? 'van' : r.chance(0.08) ? 'police' : 'sedan';
        const car = {
          lane: li, s, v: r.range(4, 9), v0: r.range(8, 12.5), len: type === 'van' ? 2.45 : 2.25, type,
          paint: type === 'taxi' ? 3 : type === 'police' ? 0 : r.chance(0.3) ? r.pick([1, 2, 6, 4, 5]) : 0,
          shade: type === 'police' ? 0.6 : r.range(0.2, 0.7), seed: r.int(1, 99999),
          turn: null, theta: 0, wantTurn: r.chance(0.35), brake: 0, blink: 0, x: 0, y: 0, yaw: 0, honk: 0,
        };
        this.placeCar(car);
        this.cars.push(car);
      }
    }

    placeCar(car) {
      const L = this.W.lanes[car.lane];
      if (car.turn) {
        const T = car.turn, a = T.phi0 - car.theta;
        car.x = wrap(T.cx + T.R * Math.cos(a), this.S); car.y = wrap(T.cy + T.R * Math.sin(a), this.S);
        car.yaw = a - Math.PI / 2;
      } else if (L.axis === 1) { car.x = L.c; car.y = car.s; car.yaw = L.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
      else { car.x = car.s; car.y = L.c; car.yaw = L.dir > 0 ? 0 : Math.PI; }
    }

    _spawnPeds(n) {
      const r = this.rng, nav = this.W.nav;
      const walkEdges = nav.edges.filter((e) => e.type === 'walk');
      for (let k = 0; k < n; k++) {
        const e = walkEdges[r.int(0, walkEdges.length - 1)];
        const A = nav.nodes[e.a], B = nav.nodes[e.b];
        const t = r.next();
        const x = wrap(A.x + wrapDelta(B.x - A.x, this.S) * t, this.S), y = wrap(A.y + wrapDelta(B.y - A.y, this.S) * t, this.S);
        const fwd = r.chance(0.5);
        this.peds.push(this._makePed(x, y, fwd ? e.a : e.b, fwd ? e.b : e.a, r));
      }
    }

    _makePed(x, y, from, to, r) {
      const accent = r.chance(0.18);
      return {
        x, y, yaw: 0, vx: 0, vy: 0, speed: 0, vmax: r.range(1.05, 1.65),
        node: from, prev: -1, target: to, edgeType: 'walk', state: 'walk', timer: 0, crossRoad: 0,
        off: r.range(0.25, 0.85), phase: r.range(0, 6), visible: true, door: -1,
        look: {
          h: r.range(0.9, 1.08), w: r.range(0.88, 1.18), coat: accent ? r.pick([1, 2, 6, 9, 5]) : 0,
          shade: r.range(0.14, 0.48), trim: r.chance(0.22) ? r.pick([1, 2, 5, 6, 3]) : 0,
          umbrella: r.chance(0.3) ? r.pick([1, 2, 6, 3, 5, 7]) : 0, visor: r.chance(0.14) ? r.pick([2, 4, 1]) : 0,
          hat: r.chance(0.2) ? 1 : 0, seed: r.int(1, 99999),
        },
      };
    }

    _spawnHovers(n) {
      const r = this.rng, lanes = this.W.skyLanes;
      for (let k = 0; k < n; k++) {
        const police = k === 0;
        this.hovers.push({
          lane: k % lanes.length, s: r.range(0, this.S), v: police ? 24 : r.range(11, 19), seed: r.int(1, 9999),
          paint: police ? 8 : r.pick([0, 0, 1, 2, 6]), glow: r.pick([1, 2, 6, 3]), police, x: 0, y: 0, z: 0, yaw: 0,
        });
      }
    }

    _spawnNpcs() {
      for (const n of this.W.npcs) {
        this.npcs.push({
          bx: n.pos[0], by: n.pos[1], x: n.pos[0], y: n.pos[1], yaw: n.yaw, anim: n.anim, phase: this.rng.range(0, 6),
          look: { h: 1, w: 1, coat: n.coat || 0, shade: n.shade || 0.3, trim: 0, umbrella: 0, visor: n.visor || 0, hat: n.hat || 0, sit: n.sit, seed: this.rng.int(1, 9999) },
          stride: 0,
        });
      }
    }

    // ----------------------------------------------------------------- emit
    // Rebuild the dynamic part of the world for this frame.
    emit(t, env, cam) {
      const W = this.W, S = this.S;
      W.resetDynamic();
      DLT.n = 0;
      const near = (x, y, r) => { const dx = wrapDelta(x - cam.x, S), dy = wrapDelta(y - cam.y, S); return dx * dx + dy * dy < r * r; };
      this.colliders.length = 0;

      for (const c of this.cars) {
        if (!near(c.x, c.y, 75)) continue;
        Models.car(W, c.x, c.y, c.yaw, {
          paint: c.paint, shade: c.shade, lights: 1, brake: c.brake, blink: c.blink, type: c.type, seed: c.seed,
          signIdx: c.type === 'taxi' ? this._taxiSign() : 0,
        });
        W.registerDynamic(W.nObjs - 1);
        this.colliders.push({ t: 'b', x: c.x, y: c.y, hx: c.len + 0.05, hy: 1.0, c: Math.cos(c.yaw), s: Math.sin(c.yaw), z1: 1.5, car: c });
        if (near(c.x, c.y, 55)) {
          const hx = Math.cos(c.yaw), hy = Math.sin(c.yaw);
          const n = Math.hypot(hx, hy, 0.16);
          addDynLight(c.x + hx * (c.len + 0.35), c.y + hy * (c.len + 0.35), 0.75, hx / n, hy / n, -0.16 / n, 0.78, 24, 1.5 * env.headlightGain, 1, 1, 1, true);
          if (c.brake > 0.5 && near(c.x, c.y, 25)) addDynLight(c.x - hx * (c.len + 0.4), c.y - hy * (c.len + 0.4), 0.8, 0, 0, 0, -2, 3.2, 0.9, 1, 0.12, 0.1, false);
          if (c.type === 'police') {
            const on = Math.floor(t * 7) & 1;
            addDynLight(c.x, c.y, 2.0, 0, 0, 0, -2, 10, 1.3, on ? 1 : 0.2, 0.12, on ? 0.12 : 1, false);
          }
        }
      }
      for (const h of this.hovers) {
        if (!near(h.x, h.y, 90)) continue;
        Models.hover(W, h.x, h.y, h.z, h.yaw, { paint: h.paint, glow: h.glow, police: h.police, seed: h.seed });
        W.registerDynamic(W.nObjs - 1);
        if (h.police && near(h.x, h.y, 60)) {
          const on = Math.floor(t * 7) & 1;
          addDynLight(h.x, h.y, h.z - 0.5, 0, 0, 0, -2, 22, 1.6, on ? 1 : 0.15, 0.1, on ? 0.1 : 1, false);
          // searchlight sweeping the street
          const a = t * 0.6;
          const n = Math.hypot(Math.cos(a) * 0.35, Math.sin(a) * 0.35, 1);
          addDynLight(h.x, h.y, h.z - 0.6, Math.cos(a) * 0.35 / n, Math.sin(a) * 0.35 / n, -1 / n, 0.975, 45, 2.2, 1, 1, 1, true);
        }
      }
      for (const p of this.peds) {
        if (!p.visible || !near(p.x, p.y, 70)) continue;
        const L = p.look;
        Models.ped(W, p.x, p.y, p.yaw, {
          h: L.h, w: L.w, phase: p.phase, stride: Math.min(1, p.speed / 1.1), coat: L.coat, shade: L.shade, trim: L.trim,
          umbrella: env.rain > 0 ? L.umbrella : 0, visor: L.visor, hat: L.hat, seed: L.seed,
        });
        W.registerDynamic(W.nObjs - 1);
        this.colliders.push({ t: 'c', x: p.x, y: p.y, r: 0.28, z1: 1.8, ped: p });
        if (L.umbrella && env.rain > 0 && near(p.x, p.y, 28)) {
          const c = AC.ACCENT[L.umbrella];
          addDynLight(p.x, p.y, 1.9 * L.h + 0.2, 0, 0, 0, -2, 2.8, 0.55, c[0], c[1], c[2], false);
        }
      }
      for (const n of this.npcs) {
        if (!near(n.x, n.y, 40)) continue;
        const L = n.look;
        Models.ped(W, n.x, n.y, n.yaw, {
          h: L.h, w: L.w, phase: n.phase, stride: n.stride, coat: L.coat, shade: L.shade, trim: L.trim,
          umbrella: 0, visor: L.visor, hat: L.hat, sit: L.sit, seed: L.seed,
        });
        W.registerDynamic(W.nObjs - 1);
        if (!L.sit) this.colliders.push({ t: 'c', x: n.x, y: n.y, r: 0.28, z1: 1.8 });
      }
      DLT.build();
      for (const d of W.doors) {
        Models.door(W, d);
        W.registerDynamic(W.nObjs - 1);
        if (d.open < 0.75) {
          const off = d.open * 0.98;
          this.colliders.push({ t: 'b', x: d.px + d.tx * off, y: d.py + d.ty * off, hx: 0.5, hy: 0.08, c: Math.cos(d.yaw), s: Math.sin(d.yaw), z1: 2.6 });
        }
      }
    }

    _taxiSign() {
      if (this._ts === undefined) this._ts = this.W.signs.findIndex((s) => s.text === 'TAXI');
      if (this._ts < 0) {
        this.W.signs.push({ text: 'TAXI', col: 3, vertical: false, anim: 'steady', speed: 1, phase: 0, cur: 1, scroll: 0, colCur: 3, chase: 99, broken: -1, brokenOn: 1 });
        this._ts = this.W.signs.length - 1;
      }
      return this._ts;
    }
  }

  return { System, addDynLight };
})();
