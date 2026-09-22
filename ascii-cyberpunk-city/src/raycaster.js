// ============================================================================
// raycaster.js — per-character 3D ray casting through the 2.5D cell grid
// ----------------------------------------------------------------------------
// One ray is cast for every character cell of the terminal. Rays are true 3D
// rays (yaw, pitch and roll are all honoured) but they are *traversed* through
// the 2D cell grid with an Amanatides-Woo DDA, which visits exactly the cells
// the ray's footprint crosses, front to back. In each visited cell we know the
// parametric interval [tEnter, tExit] the ray spends inside it, so the height
// of the ray over that interval is known analytically:
//
//     zin  = oz + dz * tEnter        zout = oz + dz * tExit
//
// That is enough to intersect the cell's vertical spans exactly:
//   * entering a span through its side   -> wall hit at tEnter
//   * descending into a span's top       -> floor / roof hit
//   * rising into a span's bottom        -> ceiling hit
// Cells whose content lies entirely below the ray segment are skipped with a
// single comparison (frameTop), which is what makes long street views cheap.
//
// Objects (props, cars, people) registered in the cell are tested with an
// AABB slab test and then per primitive. A per-object "mailbox" stamp makes
// sure each object is tested at most once per ray even if it spans many
// cells. Traversal stops as soon as the next cell starts beyond the best hit.
//
// The world wraps around: cell indices wrap at S, and when an object is tested
// the ray origin is shifted by a multiple of S so the nearest copy is used.
// ============================================================================
AC.Raycaster = (function () {
  'use strict';
  const World = AC.World;
  const PS = World.PS, OS = World.OS;
  const F_GLASS = World.F.GLASS;

  // hit record (monomorphic object -> fast property access)
  const H = (AC.hit = {
    kind: 0, t: 0.5, x: 0.5, y: 0.5, z: 0.5, nx: 0.5, ny: 0.5, nz: 0.5,
    u: 0.5, v: 0.5, w: 0.5, face: 0, mat: 0, prim: -1, cell: 0, key: 0,
    glassT: -1.5, gnx: 0.5, gny: 0.5, gcell: 0, steps: 0,
  });
  H.t = 0; H.x = 0; H.y = 0; H.z = 0;
  // kinds
  const K_NONE = 0, K_FLOOR = 1, K_FLOORSIDE = 2, K_WALL = 3, K_ROOF = 4, K_CEIL = 5, K_PRIM = 6;

  // world refs (re-bound in init)
  let W = null, S = 0, floorH, spanLo, spanHi, flags, frameTop, stStart, stList, dynHead, dynNext, dynObj;
  let prims, objs, objStamp, maxH = 100;
  let rayId = 1;

  function init(world) {
    W = world; S = world.S;
    floorH = world.floorH; spanLo = world.spanLo; spanHi = world.spanHi; flags = world.flags;
    frameTop = world.frameTop; stStart = world.stStart; stList = world.stList;
    dynHead = world.dynHead; dynNext = world.dynNext; dynObj = world.dynObj;
    prims = world.prims; objs = world.objs; objStamp = world.objStamp;
    maxH = world.maxHeight + 1;
  }

  // ------------------------------------------------ primitive intersection
  // scratch outputs of hitPrim, kept in a typed array so writing doubles does
  // not allocate (closure variables holding doubles get boxed on every write)
  const PH = new Float64Array(8); // nx, ny, nz, u, v, w, face, t

  function hitPrim(o, rox, roy, oz, dx, dy, dz, tmin, tmax) {
    const pr = prims;
    const type = pr[o];
    const rx = rox - pr[o + 1], ry = roy - pr[o + 2];
    if (type === 1) { // ---------------- oriented box
      const c = pr[o + 7], s = pr[o + 8], hx = pr[o + 5], hy = pr[o + 6], z0 = pr[o + 3], z1 = pr[o + 4];
      const px = rx * c + ry * s, py = -rx * s + ry * c;
      const ldx = dx * c + dy * s, ldy = -dx * s + dy * c;
      let tn = -1e30, tf = 1e30, ax = 0, sg = 0;
      if (ldx > 1e-9 || ldx < -1e-9) {
        const inv = 1 / ldx;
        let t1 = (-hx - px) * inv, t2 = (hx - px) * inv, g = -1;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; g = 1; }
        if (t1 > tn) { tn = t1; ax = 0; sg = g; }
        if (t2 < tf) tf = t2;
      } else if (px < -hx || px > hx) return 0;
      if (ldy > 1e-9 || ldy < -1e-9) {
        const inv = 1 / ldy;
        let t1 = (-hy - py) * inv, t2 = (hy - py) * inv, g = -1;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; g = 1; }
        if (t1 > tn) { tn = t1; ax = 1; sg = g; }
        if (t2 < tf) tf = t2;
      } else if (py < -hy || py > hy) return 0;
      if (dz > 1e-9 || dz < -1e-9) {
        const inv = 1 / dz;
        let t1 = (z0 - oz) * inv, t2 = (z1 - oz) * inv, g = -1;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; g = 1; }
        if (t1 > tn) { tn = t1; ax = 2; sg = g; }
        if (t2 < tf) tf = t2;
      } else if (oz < z0 || oz > z1) return 0;
      if (tn > tf || tn < tmin || tn > tmax) return 0;
      if (ax === 0) { PH[0] = sg * c; PH[1] = sg * s; PH[2] = 0; PH[6] = sg < 0 ? 0 : 1; }
      else if (ax === 1) { PH[0] = -sg * s; PH[1] = sg * c; PH[2] = 0; PH[6] = sg < 0 ? 2 : 3; }
      else { PH[0] = 0; PH[1] = 0; PH[2] = sg; PH[6] = sg < 0 ? 4 : 5; }
      PH[3] = px + ldx * tn + hx; PH[4] = py + ldy * tn + hy; PH[5] = oz + dz * tn - z0;
      PH[7] = tn; return 1;
    } else if (type === 2) { // --------- vertical cylinder
      const r = pr[o + 5], z0 = pr[o + 3], z1 = pr[o + 4];
      const a = dx * dx + dy * dy;
      const cc = rx * rx + ry * ry - r * r;
      if (a > 1e-12) {
        const b = rx * dx + ry * dy;
        const disc = b * b - a * cc;
        if (disc < 0) return 0;
        const t = (-b - Math.sqrt(disc)) / a;
        if (t >= tmin) {
          const z = oz + dz * t;
          if (z >= z0 && z <= z1) {
            if (t > tmax) return 0;
            const inv = 1 / r;
            PH[0] = (rx + dx * t) * inv; PH[1] = (ry + dy * t) * inv; PH[2] = 0;
            PH[3] = PH[0]; PH[4] = PH[1]; PH[5] = z - z0; PH[6] = 6;
            PH[7] = t; return 1;
          }
        } else if (cc < 0 && (oz >= z0 && oz <= z1)) return 0; // inside
      } else if (cc > 0) return 0;
      // caps
      let t = -1, top = 0;
      if (dz < 0 && oz > z1) { t = (z1 - oz) / dz; top = 1; }
      else if (dz > 0 && oz < z0) { t = (z0 - oz) / dz; }
      if (t < tmin || t > tmax) return 0;
      const hx = rx + dx * t, hy = ry + dy * t;
      if (hx * hx + hy * hy > r * r) return 0;
      PH[0] = 0; PH[1] = 0; PH[2] = top ? 1 : -1; PH[3] = hx; PH[4] = hy; PH[5] = top ? z1 - z0 : 0; PH[6] = top ? 5 : 4;
      PH[7] = t; return 1;
    } else { // -------------------------- ellipsoid
      const r = pr[o + 5], cz = pr[o + 3], rz = pr[o + 4];
      const k = r / rz;
      const rzv = (oz - cz) * k, dzs = dz * k;
      const a = dx * dx + dy * dy + dzs * dzs;
      const b = rx * dx + ry * dy + rzv * dzs;
      const c = rx * rx + ry * ry + rzv * rzv - r * r;
      const disc = b * b - a * c;
      if (disc < 0 || c < 0) return 0;
      const t = (-b - Math.sqrt(disc)) / a;
      if (t < tmin || t > tmax) return 0;
      const ex = rx + dx * t, ey = ry + dy * t, ez = oz + dz * t - cz;
      let gx = ex, gy = ey, gz = ez * k * k;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-12);
      PH[0] = gx * inv; PH[1] = gy * inv; PH[2] = gz * inv;
      PH[3] = ex; PH[4] = ey; PH[5] = ez; PH[6] = 7;
      PH[7] = t; return 1;
    }
  }

  // ------------------------------------------------------------- main cast
  function castRay(ox, oy, oz, dx, dy, dz, maxT) {
    const id = ++rayId;
    const s = S;
    let ix = Math.floor(ox), iy = Math.floor(oy);
    if (ix >= s) ix -= s; else if (ix < 0) ix += s;
    if (iy >= s) iy -= s; else if (iy < 0) iy += s;
    let ux = ix, uy = iy; // unwrapped cell coordinates (relative to origin tile)
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
    const tdx = adx > 1e-9 ? 1 / adx : 1e30, tdy = ady > 1e-9 ? 1 / ady : 1e30;
    let tmx = adx > 1e-9 ? (dx > 0 ? Math.floor(ox) + 1 - ox : ox - Math.floor(ox)) * tdx : 1e30;
    let tmy = ady > 1e-9 ? (dy > 0 ? Math.floor(oy) + 1 - oy : oy - Math.floor(oy)) * tdy : 1e30;
    let tLim = maxT;
    if (dz > 1e-6) { const t = (maxH - oz) / dz; if (t < tLim) tLim = t; }
    else if (dz < -1e-6) { const t = -oz / dz + 1e-3; if (t < tLim) tLim = t; }
    const idx = dx !== 0 ? 1 / dx : 1e30, idy = dy !== 0 ? 1 / dy : 1e30, idz = dz !== 0 ? 1 / dz : 1e30;

    let tEnter = 0, axis = -1;
    let best = 1e30, hk = K_NONE, hci = 0, hux = 0, huy = 0, hprim = -1;
    let hnx = 0, hny = 0, hnz = 0, hu = 0, hv = 0, hw = 0, hf = 0, hax = 0;
    let glassT = -1, gnx = 0, gny = 0, gci = 0;
    let steps = 0;

    for (;;) {
      steps++;
      let tExit = tmx < tmy ? tmx : tmy;
      if (tExit > tLim) tExit = tLim;
      const ci = iy * s + ix;
      const zin = oz + dz * tEnter, zout = oz + dz * tExit;
      const zlo = zin < zout ? zin : zout;
      if (zlo <= frameTop[ci]) {
        // ---- floor span [0, fh]
        const fh = floorH[ci];
        if (zin <= fh) {
          if (axis >= 0 && tEnter < best) { best = tEnter; hk = K_FLOORSIDE; hci = ci; hax = axis; hux = ux - ix; huy = uy - iy; }
        } else if (dz < 0 && zout <= fh) {
          const t = (fh - oz) / dz;
          if (t < best) { best = t; hk = K_FLOOR; hci = ci; hux = ux - ix; huy = uy - iy; }
        }
        // ---- upper span [lo, hi]
        const lo = spanLo[ci], hi = spanHi[ci];
        if (hi > lo) {
          if (zin >= lo && zin <= hi) {
            if (axis >= 0 && tEnter < best) { best = tEnter; hk = K_WALL; hci = ci; hax = axis; hux = ux - ix; huy = uy - iy; }
          } else if (zin > hi) {
            if (dz < 0 && zout <= hi) {
              const t = (hi - oz) / dz;
              if (t < best) { best = t; hk = K_ROOF; hci = ci; hux = ux - ix; huy = uy - iy; }
            }
          } else {
            if (dz > 0 && zout >= lo) {
              const t = (lo - oz) / dz;
              if (t < best) { best = t; hk = K_CEIL; hci = ci; hux = ux - ix; huy = uy - iy; }
            }
            if (glassT < 0 && axis >= 0 && zin > fh && tEnter < best && (flags[ci] & F_GLASS)) {
              glassT = tEnter; gci = ci;
              if (axis === 0) { gnx = -sx; gny = 0; } else { gnx = 0; gny = -sy; }
            }
          }
        }
        // ---- objects: static list then dynamic list
        let k = stStart[ci];
        const kEnd = stStart[ci + 1];
        let n = dynHead[ci];
        while (k < kEnd || n >= 0) {
          let oi;
          if (k < kEnd) oi = stList[k++];
          else { oi = dynObj[n]; n = dynNext[n]; }
          if (objStamp[oi] === id) continue;
          objStamp[oi] = id;
          const q = oi * OS;
          // choose the copy of the object nearest to this cell (wrap-around)
          let rox = ox, roy = oy;
          const ddx = ux + 0.5 - objs[q + 8], ddy = uy + 0.5 - objs[q + 9];
          if (ddx > s * 0.5 || ddx < -s * 0.5) rox = ox - s * Math.round(ddx / s);
          if (ddy > s * 0.5 || ddy < -s * 0.5) roy = oy - s * Math.round(ddy / s);
          // AABB slab test
          let t1 = (objs[q] - rox) * idx, t2 = (objs[q + 2] - rox) * idx;
          let tn = t1 < t2 ? t1 : t2, tf = t1 < t2 ? t2 : t1;
          t1 = (objs[q + 1] - roy) * idy; t2 = (objs[q + 3] - roy) * idy;
          let a = t1 < t2 ? t1 : t2, b = t1 < t2 ? t2 : t1;
          if (a > tn) tn = a; if (b < tf) tf = b;
          t1 = (objs[q + 4] - oz) * idz; t2 = (objs[q + 5] - oz) * idz;
          a = t1 < t2 ? t1 : t2; b = t1 < t2 ? t2 : t1;
          if (a > tn) tn = a; if (b < tf) tf = b;
          if (tf < tn || tf < 0.02 || tn > best) continue;
          const p0 = objs[q + 6], pn = objs[q + 7];
          for (let p = p0; p < p0 + pn; p++) {
            const o = p * PS;
            if (hitPrim(o, rox, roy, oz, dx, dy, dz, 0.02, best)) {
              best = PH[7]; hk = K_PRIM; hprim = p; hci = ci;
              hnx = PH[0]; hny = PH[1]; hnz = PH[2]; hu = PH[3]; hv = PH[4]; hw = PH[5]; hf = PH[6];
              hux = rox === ox ? 0 : ox - rox; huy = roy === oy ? 0 : oy - roy; // origin shift
            }
          }
        }
      }
      if (tExit >= tLim || best <= tExit) break;
      if (tmx < tmy) {
        tEnter = tmx; tmx += tdx; ix += sx; ux += sx; axis = 0;
        if (ix >= s) ix = 0; else if (ix < 0) ix = s - 1;
      } else {
        tEnter = tmy; tmy += tdy; iy += sy; uy += sy; axis = 1;
        if (iy >= s) iy = 0; else if (iy < 0) iy = s - 1;
      }
    }

    H.steps = steps;
    H.glassT = glassT >= 0 && glassT < best ? glassT : -1;
    if (H.glassT >= 0) { H.gnx = gnx; H.gny = gny; H.gcell = gci; }
    if (hk === K_NONE) { H.kind = K_NONE; H.t = tLim; H.prim = -1; H.key = 0; return; }

    H.kind = hk; H.t = best; H.cell = hci;
    let x = ox + dx * best, y = oy + dy * best;
    const z = oz + dz * best;
    if (hk === K_PRIM) { x -= hux; y -= huy; }       // canonical copy coordinates
    else { x -= hux; y -= huy; }                    // unwrap offset of the cell
    // wrap to [0, S)
    if (x >= s || x < 0) x -= s * Math.floor(x / s);
    if (y >= s || y < 0) y -= s * Math.floor(y / s);
    H.x = x; H.y = y; H.z = z;

    switch (hk) {
      case K_FLOOR:
        H.nx = 0; H.ny = 0; H.nz = 1; H.u = x; H.v = y; H.face = 5; H.prim = -1;
        H.mat = W.floorMat[hci];
        H.key = (1 << 26) | ((Math.round(floorH[hci] * 20) & 0x7ff) << 12);
        break;
      case K_FLOORSIDE:
      case K_WALL: {
        H.prim = -1; H.nz = 0;
        let plane;
        if (hax === 0) { H.nx = -sx; H.ny = 0; H.u = y; H.face = sx > 0 ? 0 : 1; plane = Math.round(x) % s; }
        else { H.nx = 0; H.ny = -sy; H.u = x; H.face = sy > 0 ? 2 : 3; plane = Math.round(y) % s; }
        H.v = z;
        H.mat = hk === K_WALL ? W.wallMat[hci] : W.sideMat[hci];
        const b = W.bld[hci] + 1;
        H.key = ((hk === K_WALL ? 2 : 3) << 26) | (H.face << 23) | ((plane & 0x7ff) << 12) | (b & 0xfff);
        break;
      }
      case K_ROOF:
        H.nx = 0; H.ny = 0; H.nz = 1; H.u = x; H.v = y; H.face = 5; H.prim = -1;
        H.mat = AC.MAT.ROOF;
        H.key = (4 << 26) | ((Math.round(spanHi[hci] * 4) & 0x7ff) << 12) | ((W.bld[hci] + 1) & 0xfff);
        break;
      case K_CEIL:
        H.nx = 0; H.ny = 0; H.nz = -1; H.u = x; H.v = y; H.face = 4; H.prim = -1;
        H.mat = AC.MAT.CEILING;
        H.key = (5 << 26) | ((Math.round(spanLo[hci] * 4) & 0x7ff) << 12);
        break;
      default: {
        H.nx = hnx; H.ny = hny; H.nz = hnz; H.u = hu; H.v = hv; H.w = hw; H.face = hf; H.prim = hprim;
        H.mat = prims[hprim * PS + 9] | 0;
        H.key = -(hprim * 8 + hf + 1);
      }
    }
  }

  // --------------------------------------------------------------- frame
  // cam: {x, y, z, yaw, pitch, roll, tanH}; view rows [r0, r1)
  let uArr = new Float32Array(0), vArr = new Float32Array(0);
  const stats = { rays: 0, steps: 0 };

  // Rows [r0, r1) are cast; `step`/`phase` select an interleaved subset of
  // them (worker k of n renders rows r0+k, r0+k+n, ...) for load balancing.
  function castFrame(cam, scr, r0, r1, maxT, shade, step, phase) {
    step = step || 1; phase = phase || 0;
    const cols = scr.cols, rows = scr.rows;
    if (uArr.length !== cols) uArr = new Float32Array(cols);
    if (vArr.length !== rows) vArr = new Float32Array(rows);
    const tanH = cam.tanH, tanV = tanH * (rows * scr.CH) / (cols * scr.CW);
    for (let c = 0; c < cols; c++) uArr[c] = (2 * (c + 0.5) / cols - 1) * tanH;
    for (let r = 0; r < rows; r++) vArr[r] = (1 - 2 * (r + 0.5) / rows) * tanV;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const fx = cy * cp, fy = sy * cp, fz = sp;
    const rx = sy, ry = -cy;                 // right (rz = 0)
    const upx = -cy * sp, upy = -sy * sp, upz = cp;
    const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
    const ox = cam.x, oy = cam.y, oz = cam.z;
    let steps = 0, rays = 0;
    const gT = scr.gT, gKey = scr.gKey;
    for (let r = r0 + phase; r < r1; r += step) {
      const v0 = vArr[r];
      let i = r * cols;
      for (let c = 0; c < cols; c++, i++) {
        const u0 = uArr[c];
        const u = u0 * cr - v0 * sr, v = u0 * sr + v0 * cr;
        let dx = fx + rx * u + upx * v, dy = fy + ry * u + upy * v, dz = fz + upz * v;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= inv; dy *= inv; dz *= inv;
        castRay(ox, oy, oz, dx, dy, dz, maxT);
        steps += H.steps; rays++;
        gT[i] = H.kind === K_NONE ? 1e4 : H.t;
        gKey[i] = H.key;
        shade(i, c, r, dx, dy, dz);
      }
    }
    stats.rays = rays; stats.steps = steps;
  }

  // Project a world point to screen character coordinates (for particles).
  // Returns false if behind the camera. Results in proj.{col,row,dist}.
  const proj = { col: 0, row: 0, dist: 0, depth: 0 };
  let pc = null;
  function setupProjection(cam, scr) {
    const cols = scr.cols, rows = scr.rows;
    const tanH = cam.tanH, tanV = tanH * (rows * scr.CH) / (cols * scr.CW);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    pc = {
      x: cam.x, y: cam.y, z: cam.z, fx: cy * cp, fy: sy * cp, fz: sp, rx: sy, ry: -cy,
      ux: -cy * sp, uy: -sy * sp, uz: cp, tanH, tanV, cols, rows, cr: Math.cos(cam.roll), sr: Math.sin(cam.roll),
    };
  }
  function project(x, y, z) {
    let dx = x - pc.x, dy = y - pc.y;
    if (dx > S * 0.5) dx -= S; else if (dx < -S * 0.5) dx += S;
    if (dy > S * 0.5) dy -= S; else if (dy < -S * 0.5) dy += S;
    const dz = z - pc.z;
    const zc = dx * pc.fx + dy * pc.fy + dz * pc.fz;
    if (zc < 0.15) return false;
    const u = (dx * pc.rx + dy * pc.ry) / zc, v = (dx * pc.ux + dy * pc.uy + dz * pc.uz) / zc;
    // undo roll
    const u0 = u * pc.cr + v * pc.sr, v0 = -u * pc.sr + v * pc.cr;
    proj.col = ((u0 / pc.tanH) + 1) * 0.5 * pc.cols;
    proj.row = (1 - v0 / pc.tanV) * 0.5 * pc.rows;
    proj.dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    proj.depth = zc;
    return true;
  }

  return { init, castRay, castFrame, setupProjection, project, proj, stats, K: { NONE: K_NONE, FLOOR: K_FLOOR, FLOORSIDE: K_FLOORSIDE, WALL: K_WALL, ROOF: K_ROOF, CEIL: K_CEIL, PRIM: K_PRIM } };
})();
