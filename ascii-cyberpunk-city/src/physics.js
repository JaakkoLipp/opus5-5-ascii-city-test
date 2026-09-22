// ============================================================================
// physics.js — collision against the cell grid, static props and entities
// ----------------------------------------------------------------------------
// Bodies are vertical circles on the ground plane. A cell blocks a body if one
// of its solid spans overlaps the body's vertical extent (feet + step height
// up to head height), so kerbs are stepped over, door lintels are walked
// under, and glass shop fronts stop you. Props are circles or oriented boxes
// looked up through a coarse collider grid; moving cars/walkers/doors are
// supplied each frame by the entity system. Resolution is iterative
// push-out along the shortest separation vector.
// ============================================================================
AC.Physics = (function () {
  'use strict';
  const { wrapDelta } = AC.util;
  let W = null, S = 80, F = null;
  let stamp = null, stampId = 1;

  const STEP = 0.45, HEAD = 1.85;

  function init(world) {
    W = world; S = world.S; F = AC.World.F;
    stamp = new Int32Array(world.colliders.length + 1);
  }

  function blocksBody(ci, zFeet) {
    if (W.flags[ci] & F.GLASS) return true;
    if (W.floorH[ci] > zFeet + STEP) return true;
    const lo = W.spanLo[ci], hi = W.spanHi[ci];
    return hi > lo && lo < zFeet + HEAD && hi > zFeet + STEP;
  }

  // walkable floor height at a point
  function groundAt(x, y) {
    const ci = W.idx(x, y);
    return W.floorH[ci];
  }

  function pushCircle(pos, r, cx, cy, cr) {
    const dx = wrapDelta(pos.x - cx, S), dy = wrapDelta(pos.y - cy, S);
    const d2 = dx * dx + dy * dy, R = r + cr;
    if (d2 >= R * R) return false;
    const d = Math.sqrt(d2);
    if (d < 1e-6) { pos.x += R; return true; }
    const k = (R - d) / d;
    pos.x += dx * k; pos.y += dy * k;
    return true;
  }

  function pushBox(pos, r, bx, by, hx, hy, c, s) {
    const dx = wrapDelta(pos.x - bx, S), dy = wrapDelta(pos.y - by, S);
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const qx = Math.max(-hx, Math.min(hx, lx)), qy = Math.max(-hy, Math.min(hy, ly));
    let ox = lx - qx, oy = ly - qy;
    const d2 = ox * ox + oy * oy;
    if (d2 >= r * r) return false;
    let nlx, nly;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2), k = (r - d) / d;
      nlx = lx + ox * k; nly = ly + oy * k;
    } else {
      // centre inside the box: exit through the nearest side
      const ex = hx - Math.abs(lx), ey = hy - Math.abs(ly);
      if (ex < ey) { nlx = (lx < 0 ? -1 : 1) * (hx + r); nly = ly; }
      else { nlx = lx; nly = (ly < 0 ? -1 : 1) * (hy + r); }
    }
    const wx = nlx * c - nly * s, wy = nlx * s + nly * c;
    pos.x += wx - dx; pos.y += wy - dy;
    return true;
  }

  // Resolve a circle of radius r against everything solid. `dyn` is an
  // optional list of dynamic colliders; `skipProps` ignores static props.
  function collide(pos, r, zFeet, dyn, skipProps, self) {
    for (let it = 0; it < 4; it++) {
      let moved = false;
      const x0 = Math.floor(pos.x - r), x1 = Math.floor(pos.x + r);
      const y0 = Math.floor(pos.y - r), y1 = Math.floor(pos.y + r);
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        const ci = W.idx(gx, gy);
        if (!blocksBody(ci, zFeet)) continue;
        const cx = Math.max(gx, Math.min(pos.x, gx + 1)), cy = Math.max(gy, Math.min(pos.y, gy + 1));
        const dx = pos.x - cx, dy = pos.y - cy, d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2), k = (r - d) / d;
          pos.x += dx * k; pos.y += dy * k;
        } else {
          const l = pos.x - gx, rr = gx + 1 - pos.x, b = pos.y - gy, t = gy + 1 - pos.y;
          const m = Math.min(l, rr, b, t);
          if (m === l) pos.x = gx - r; else if (m === rr) pos.x = gx + 1 + r; else if (m === b) pos.y = gy - r; else pos.y = gy + 1 + r;
        }
        moved = true;
      }
      if (!skipProps) {
        stampId++;
        const cs = W.colGridStart, cl = W.colGridList, C = W.colliders;
        const px = Math.floor(pos.x), py = Math.floor(pos.y);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const ci = W.idx(px + ox, py + oy);
          for (let k = cs[ci]; k < cs[ci + 1]; k++) {
            const id = cl[k];
            if (stamp[id] === stampId) continue;
            stamp[id] = stampId;
            const c = C[id];
            if (c.z1 < zFeet + 0.25) continue;
            if (c.t === 'c' ? pushCircle(pos, r, c.x, c.y, c.r) : pushBox(pos, r, c.x, c.y, c.hx, c.hy, c.c, c.s)) moved = true;
          }
        }
      }
      if (dyn) for (let k = 0; k < dyn.length; k++) {
        const c = dyn[k];
        if (c === self || (self && (c.ped === self || c.car === self))) continue;
        if (c.t === 'c' ? pushCircle(pos, r, c.x, c.y, c.r) : pushBox(pos, r, c.x, c.y, c.hx, c.hy, c.c, c.s)) moved = true;
      }
      if (!moved) break;
    }
  }

  return { init, collide, groundAt, blocksBody };
})();
