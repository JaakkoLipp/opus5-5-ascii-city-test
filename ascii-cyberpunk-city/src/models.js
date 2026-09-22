// ============================================================================
// models.js — data-driven object builders
// ----------------------------------------------------------------------------
// A "model" is a function that writes analytic primitives into the World's
// primitive buffer. The same builders are used for static props (baked once
// by world generation) and for dynamic entities (re-emitted every frame by the
// entity system), so a parked car and a moving car are literally the same
// data. Local frames: +x = forward, +y = left, z = up; yaw rotates local->world.
// ============================================================================
AC.Models = (function () {
  'use strict';
  const M = AC.MAT;

  // local -> world helpers (no allocation: results in LX/LY)
  let LX = 0, LY = 0;
  function tf(x, y, c, s, lx, ly) { LX = x + lx * c - ly * s; LY = y + lx * s + ly * c; }

  // ---------------------------------------------------------------- props
  // Street lamp: pole + arm reaching over the road + emissive head.
  // Returns the world position of the lamp head (for the light).
  function streetLamp(W, x, y, dirX, dirY, seed) {
    const yaw = Math.atan2(dirY, dirX);
    W.beginObject();
    W.cyl(x, y, 0, 6.7, 0.09, M.POLE, 0);
    W.cyl(x, y, 0, 0.5, 0.16, M.POLE, 0);                      // base
    W.box(x + dirX * 1.05, y + dirY * 1.05, 6.55, 6.68, 1.05, 0.05, yaw, M.POLE, 0);
    const head = W.box(x + dirX * 2.15, y + dirY * 2.15, 6.35, 6.6, 0.38, 0.17, yaw, M.LAMP, 0, 0, 0, seed);
    W.endObject(1);
    W.colliders.push({ t: 'c', x, y, r: 0.2, z1: 6.7 });
    return { x: x + dirX * 2.15, y: y + dirY * 2.15, z: 6.2, prim: head };
  }

  function tree(W, x, y, scale, seed) {
    const s = scale;
    W.beginObject();
    W.box(x, y, 0, 0.42, 0.62, 0.62, 0, M.PLANTER, 0);
    W.cyl(x, y, 0.42, 2.7 * s, 0.12 * s, M.TRUNK, 0);
    W.sph(x, y, 3.3 * s, 1.25 * s, 1.05 * s, M.LEAVES, 0, 0, 0, seed);
    W.sph(x + 0.45 * s, y - 0.3 * s, 2.75 * s, 0.8 * s, 0.7 * s, M.LEAVES, 0, 0, 0, seed + 1);
    W.endObject(2);
    W.colliders.push({ t: 'b', x, y, hx: 0.62, hy: 0.62, c: 1, s: 0, z1: 0.42 });
  }

  // Traffic signal: pole with a mast arm, the head faces `faceYaw`.
  // axis: 0 = controls N-S traffic, 1 = controls E-W traffic.
  function trafficLight(W, x, y, armX, armY, armLen, faceYaw, axis) {
    const yaw = Math.atan2(armY, armX);
    W.beginObject();
    W.cyl(x, y, 0, 6.0, 0.13, M.POLE, 0);
    W.box(x + armX * armLen * 0.5, y + armY * armLen * 0.5, 5.75, 5.9, armLen * 0.5, 0.06, yaw, M.POLE, 0);
    const hx = x + armX * armLen, hy = y + armY * armLen;
    W.box(hx, hy, 4.55, 5.75, 0.2, 0.2, faceYaw, M.SIGNAL, 0, axis, 0);
    // pedestrian signal box on the pole, facing along the crosswalk
    W.box(x + Math.cos(faceYaw + Math.PI / 2) * 0.2, y + Math.sin(faceYaw + Math.PI / 2) * 0.2, 2.5, 2.95, 0.16, 0.16, faceYaw, M.PEDSIGNAL, 0, axis, 0);
    W.endObject(3);
    W.colliders.push({ t: 'c', x, y, r: 0.2, z1: 6 });
    return { x: hx, y: hy };
  }

  function bench(W, x, y, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    W.beginObject();
    W.box(x, y, 0.4, 0.48, 0.25, 0.9, yaw, M.WOOD, 0);
    tf(x, y, c, s, -0.22, 0); W.box(LX, LY, 0.48, 0.92, 0.04, 0.9, yaw, M.WOOD, 0);
    tf(x, y, c, s, 0, 0.8); W.box(LX, LY, 0, 0.4, 0.2, 0.04, yaw, M.METAL, 0);
    tf(x, y, c, s, 0, -0.8); W.box(LX, LY, 0, 0.4, 0.2, 0.04, yaw, M.METAL, 0);
    W.endObject(4);
    W.colliders.push({ t: 'b', x, y, hx: 0.3, hy: 0.95, c, s, z1: 0.9 });
  }

  function bin(W, x, y) {
    W.beginObject();
    W.cyl(x, y, 0, 0.95, 0.28, M.METAL, 0, 1);
    W.endObject(4);
    W.colliders.push({ t: 'c', x, y, r: 0.3, z1: 0.95 });
  }

  function hydrant(W, x, y) {
    W.beginObject();
    W.cyl(x, y, 0, 0.62, 0.14, M.HYDRANT, 4);
    W.sph(x, y, 0.62, 0.14, 0.12, M.HYDRANT, 4);
    W.cyl(x, y, 0.35, 0.47, 0.2, M.HYDRANT, 4);
    W.endObject(4);
    W.colliders.push({ t: 'c', x, y, r: 0.2, z1: 0.75 });
  }

  function bollard(W, x, y, col) {
    W.beginObject();
    W.cyl(x, y, 0, 0.95, 0.1, M.BOLLARD, col);
    W.endObject(4);
    W.colliders.push({ t: 'c', x, y, r: 0.12, z1: 0.95 });
  }

  // Vending machine; front = local +x.
  function vending(W, x, y, yaw, col, seed) {
    W.beginObject();
    W.box(x, y, 0, 1.95, 0.4, 0.5, yaw, M.VENDING, col, 0, 0, seed);
    W.endObject(5);
    W.colliders.push({ t: 'b', x, y, hx: 0.42, hy: 0.52, c: Math.cos(yaw), s: Math.sin(yaw), z1: 1.95 });
  }

  // Street data kiosk with a screen facing local +x
  function kiosk(W, x, y, yaw, seed) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    W.beginObject();
    W.box(x, y, 0, 1.1, 0.3, 0.35, yaw, M.KIOSK, 0);
    tf(x, y, c, s, 0.05, 0);
    W.box(LX, LY, 1.1, 2.1, 0.22, 0.35, yaw, M.KIOSK, 0);
    tf(x, y, c, s, 0.285, 0);
    W.box(LX, LY, 1.25, 1.95, 0.015, 0.28, yaw, M.SCREEN, 2, 2, seed);
    W.endObject(5);
    W.colliders.push({ t: 'b', x, y, hx: 0.35, hy: 0.4, c, s, z1: 2.1 });
  }

  function dumpster(W, x, y, yaw) {
    W.beginObject();
    W.box(x, y, 0.1, 1.25, 0.55, 1.0, yaw, M.DUMPSTER, 0);
    W.endObject(4);
    W.colliders.push({ t: 'b', x, y, hx: 0.6, hy: 1.05, c: Math.cos(yaw), s: Math.sin(yaw), z1: 1.25 });
  }

  function crates(W, x, y, seed) {
    const r = new AC.util.RNG(seed);
    W.beginObject();
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const sz = r.range(0.3, 0.45);
      W.box(x + r.range(-0.1, 0.1), y + r.range(-0.1, 0.1), z, z + sz * 1.6, sz, sz, r.range(0, 0.5), M.CRATE, 0);
      z += sz * 1.6;
      if (r.chance(0.4)) break;
    }
    W.endObject(4);
    W.colliders.push({ t: 'c', x, y, r: 0.5, z1: z });
  }

  // ----------------------------------------------------------------- cars
  // o: {paint (accent idx or 0), shade (mono albedo), lights (0/1), brake (0..1),
  //     blink (-1 left, 1 right, 0 none), type ('sedan'|'taxi'|'van'|'police'), seed}
  function car(W, x, y, yaw, o) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const van = o.type === 'van';
    const L = van ? 2.45 : 2.25, Wd = 0.95;
    const paint = o.paint | 0, seed = o.seed | 0;
    W.beginObject();
    // wheels
    for (let i = 0; i < 4; i++) {
      tf(x, y, c, s, (i & 1 ? 1 : -1) * (L - 0.85), (i & 2 ? 1 : -1) * (Wd - 0.12));
      W.box(LX, LY, 0, 0.62, 0.34, 0.13, yaw, M.TIRE, 0);
    }
    // body + cabin
    W.box(x, y, 0.3, van ? 1.25 : 0.98, L, Wd, yaw, M.CAR_BODY, paint, o.shade || 0.5, 0, seed);
    if (van) {
      tf(x, y, c, s, -0.35, 0);
      W.box(LX, LY, 1.25, 2.05, L - 0.45, Wd - 0.04, yaw, M.CAR_CABIN, paint, o.shade || 0.5, 1, seed);
    } else {
      tf(x, y, c, s, -0.3, 0);
      W.box(LX, LY, 0.98, 1.44, 1.2, Wd - 0.1, yaw, M.CAR_CABIN, paint, o.shade || 0.5, 0, seed);
    }
    // head lights (front, local +x)
    const hl = o.lights ? 1 : 0;
    tf(x, y, c, s, L + 0.01, 0.62); W.box(LX, LY, 0.62, 0.8, 0.03, 0.2, yaw, M.HEADLIGHT, 7, hl, o.blink === -1 ? 1 : 0);
    tf(x, y, c, s, L + 0.01, -0.62); W.box(LX, LY, 0.62, 0.8, 0.03, 0.2, yaw, M.HEADLIGHT, 7, hl, o.blink === 1 ? 1 : 0);
    // tail light bar (rear)
    tf(x, y, c, s, -L - 0.01, 0); W.box(LX, LY, 0.72, 0.84, 0.03, Wd - 0.08, yaw, M.TAILLIGHT, 4, (o.lights ? 0.45 : 0.12) + (o.brake || 0), o.blink || 0);
    if (o.type === 'taxi') {
      tf(x, y, c, s, -0.3, 0);
      W.box(LX, LY, 1.44, 1.68, 0.18, 0.42, yaw + Math.PI / 2, M.SIGN, 3, o.signIdx || 0, 0);
    } else if (o.type === 'police') {
      tf(x, y, c, s, -0.2, 0.3); W.box(LX, LY, 1.44, 1.6, 0.14, 0.26, yaw, M.BULB, 4, 3, 0);
      tf(x, y, c, s, -0.2, -0.3); W.box(LX, LY, 1.44, 1.6, 0.14, 0.26, yaw, M.BULB, 8, 3, 0.5);
    }
    W.endObject(6);
  }

  // Hover car flying in the sky lanes
  function hover(W, x, y, z, yaw, o) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    W.beginObject();
    W.box(x, y, z, z + 0.7, 2.3, 1.05, yaw, M.HOVER, o.paint | 0, 0, 0, o.seed | 0);
    tf(x, y, c, s, -0.2, 0);
    W.sph(LX, LY, z + 0.75, 1.1, 0.45, M.CAR_CABIN, 0, 0.3, 2, o.seed | 0);
    W.box(x, y, z - 0.08, z, 1.8, 0.8, yaw, M.NEON, o.glow || 2, 1, 0);          // under-glow
    tf(x, y, c, s, 0.0, 1.12); W.box(LX, LY, z + 0.25, z + 0.45, 0.4, 0.06, yaw, M.BULB, 4, 1, 0);   // port (red)
    tf(x, y, c, s, 0.0, -1.12); W.box(LX, LY, z + 0.25, z + 0.45, 0.4, 0.06, yaw, M.BULB, 5, 1, 0.5); // starboard (green)
    tf(x, y, c, s, -2.32, 0); W.box(LX, LY, z + 0.15, z + 0.55, 0.03, 0.7, yaw, M.TAILLIGHT, o.police ? 8 : 4, 1.2, 0);
    if (o.police) {
      tf(x, y, c, s, 0.4, 0.35); W.box(LX, LY, z + 0.7, z + 0.85, 0.2, 0.25, yaw, M.BULB, 4, 3, 0);
      tf(x, y, c, s, 0.4, -0.35); W.box(LX, LY, z + 0.7, z + 0.85, 0.2, 0.25, yaw, M.BULB, 8, 3, 0.5);
    }
    W.endObject(7);
  }

  // ----------------------------------------------------------- pedestrians
  // o: {h (height scale), w (width scale), phase, stride (0..1), coat (accent idx),
  //     shade, trim (accent idx or 0), umbrella (accent idx or 0), visor (accent or 0),
  //     hat (0/1), sit (0/1), seed}
  function ped(W, x, y, yaw, o) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const k = o.h || 1, wd = o.w || 1, seed = o.seed | 0;
    const ph = o.phase || 0, st = o.stride || 0;
    const sw = Math.sin(ph) * 0.26 * st;
    const bob = Math.abs(Math.cos(ph)) * 0.035 * st;
    const hip = 0.88 * k;
    W.beginObject();
    if (o.sit) {
      // seated: thighs forward, shins down
      tf(x, y, c, s, 0.22, 0.1); W.box(LX, LY, 0.62, 0.76, 0.24, 0.08, yaw, M.PED_LEGS, 0);
      tf(x, y, c, s, 0.22, -0.1); W.box(LX, LY, 0.62, 0.76, 0.24, 0.08, yaw, M.PED_LEGS, 0);
      tf(x, y, c, s, 0.44, 0.1); W.cyl(LX, LY, 0, 0.66, 0.07, M.PED_LEGS, 0);
      tf(x, y, c, s, 0.44, -0.1); W.cyl(LX, LY, 0, 0.66, 0.07, M.PED_LEGS, 0);
    } else {
      tf(x, y, c, s, sw, 0.1 * wd); W.cyl(LX, LY, 0, hip + bob, 0.075, M.PED_LEGS, 0);
      tf(x, y, c, s, -sw, -0.1 * wd); W.cyl(LX, LY, 0, hip + bob, 0.075, M.PED_LEGS, 0);
    }
    const base = o.sit ? 0.72 : hip + bob;
    const top = base + 0.58 * k;
    W.box(x, y, base, top, 0.13 * wd, 0.21 * wd, yaw, M.PED_BODY, o.coat | 0, o.shade || 0.35, o.trim | 0, seed);
    // arms swing opposite to legs
    tf(x, y, c, s, -sw * 0.7, 0.27 * wd); W.cyl(LX, LY, base + 0.02, top - 0.03, 0.05, M.PED_BODY, o.coat | 0, o.shade || 0.35, 0, seed);
    tf(x, y, c, s, sw * 0.7, -0.27 * wd); W.cyl(LX, LY, base + 0.02, top - 0.03, 0.05, M.PED_BODY, o.coat | 0, o.shade || 0.35, 0, seed);
    const hz = top + 0.16 * k;
    W.sph(x, y, hz, 0.115, 0.13, M.PED_SKIN, 0, 0, 0, seed);
    if (o.visor) {
      tf(x, y, c, s, 0.09, 0);
      W.box(LX, LY, hz - 0.01, hz + 0.045, 0.03, 0.1, yaw, M.VISOR, o.visor, 0, 0);
    }
    if (o.hat) W.cyl(x, y, hz + 0.07, hz + 0.16, 0.15, M.HAIR, 0);
    if (o.umbrella) {
      W.cyl(x + c * 0.1, y + s * 0.1, top - 0.1, hz + 0.45, 0.012, M.POLE, 0);
      W.sph(x + c * 0.1, y + s * 0.1, hz + 0.45, 0.58, 0.13, M.UMBRELLA, o.umbrella, 0, 0, seed);
    }
    W.endObject(8);
  }

  // ------------------------------------------------------------- door panel
  // A sliding door panel; `open` in [0,1] slides it along its width into the wall
  function door(W, d) {
    const off = d.open * 0.98;
    W.beginObject();
    W.box(d.px + d.tx * off, d.py + d.ty * off, 0, d.h, 0.49, 0.05, d.yaw, M.DOOR, d.locked ? 4 : 5, d.enterable ? 1 : 0, d.open, d.seed);
    W.endObject(9);
  }

  // A flat box sign on a wall. Local +x runs along the text direction.
  function sign(W, x, y, z0, z1, halfLen, halfDepth, yaw, signIdx, mat) {
    W.beginObject();
    W.box(x, y, z0, z1, halfLen, halfDepth, yaw, mat || M.SIGN, 0, signIdx, 0);
    W.endObject(10);
  }

  return { streetLamp, tree, trafficLight, bench, bin, hydrant, bollard, vending, kiosk, dumpster, crates, car, hover, ped, door, sign };
})();
