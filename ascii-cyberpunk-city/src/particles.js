// ============================================================================
// particles.js — rain, splashes and steam, rendered as depth-tested glyphs
// ----------------------------------------------------------------------------
// Particles live in world space around the camera. They are projected into
// the character grid after the scene pass and only drawn where they are in
// front of the depth stored for that cell (gT), so rain falls *between*
// buildings and steam rises behind lamp posts. Rain streaks pick their glyph
// ( | / \ ) from the streak's projected screen slope, and add their light to
// whatever is behind them, so drops in front of neon glow in that colour.
// ============================================================================
AC.Particles = (function () {
  'use strict';
  const { RNG, wrap, wrapDelta, hash3 } = AC.util;
  const RC = AC.Raycaster;
  const MAX_RAIN = 1100, MAX_SPLASH = 256, MAX_STEAM = 420;
  let W = null, S = 80, rng = null, G = null;
  const rx = new Float32Array(MAX_RAIN), ry = new Float32Array(MAX_RAIN), rz = new Float32Array(MAX_RAIN), rs = new Float32Array(MAX_RAIN);
  let nRain = 0;
  const sx = new Float32Array(MAX_SPLASH), sy = new Float32Array(MAX_SPLASH), sz = new Float32Array(MAX_SPLASH), sa = new Float32Array(MAX_SPLASH);
  let sHead = 0;
  const px = new Float32Array(MAX_STEAM), py = new Float32Array(MAX_STEAM), pz = new Float32Array(MAX_STEAM), pa = new Float32Array(MAX_STEAM),
    pl = new Float32Array(MAX_STEAM), pvx = new Float32Array(MAX_STEAM), pvy = new Float32Array(MAX_STEAM), pvz = new Float32Array(MAX_STEAM), pSize = new Float32Array(MAX_STEAM);
  let nSteam = 0;
  const emitAcc = [];
  let windX = 1.4, windY = 0.5;
  let gBar, gSl, gBs, gDot, gCom, gCol, STEAMG;

  function init(world, seed) {
    W = world; S = world.S; rng = new RNG(seed);
    sa.fill(99);
    G = AC.Glyphs.index;
    gBar = G('|'); gSl = G('/'); gBs = G('\\'); gDot = G('.'); gCom = G(','); gCol = G(':');
    STEAMG = Array.from(' .:;oO').map(G);
    for (let i = 0; i < world.emitters.length; i++) emitAcc.push(0);
  }

  function covered(x, y, z) {
    const ci = W.idx(x, y);
    const lo = W.spanLo[ci], hi = W.spanHi[ci];
    if (hi > lo && z < hi) return true; // inside a building or below a ceiling/awning line
    return z < W.floorH[ci];
  }

  // drops are spawned with a density that falls off with distance (sqrt of a
  // uniform radius gives uniform area density; using the radius directly
  // concentrates drops near the camera where each streak is visible)
  function respawnDrop(i, cam, anyZ) {
    const a = rng.next() * Math.PI * 2, r = 0.6 + Math.pow(rng.next(), 0.8) * 17;
    rx[i] = wrap(cam.x + Math.cos(a) * r, S);
    ry[i] = wrap(cam.y + Math.sin(a) * r, S);
    rz[i] = anyZ ? rng.range(0, cam.z + 12) : cam.z + rng.range(6, 12);
    rs[i] = rng.range(13, 17);
  }

  function update(dt, cam, env, t) {
    windX = 2.6 + Math.sin(t * 0.13) * 1.2; windY = 1.2 + Math.sin(t * 0.07) * 0.8;
    // --- rain
    const want = Math.floor(env.rain * 900);
    while (nRain < want) { respawnDrop(nRain, cam, true); nRain++; }
    if (nRain > want) nRain = want;
    for (let i = 0; i < nRain; i++) {
      rz[i] -= rs[i] * dt;
      rx[i] += windX * dt; ry[i] += windY * dt;
      const dx = wrapDelta(rx[i] - cam.x, S), dy = wrapDelta(ry[i] - cam.y, S);
      if (dx * dx + dy * dy > 330) { respawnDrop(i, cam, true); continue; }
      const ci = W.idx(rx[i], ry[i]);
      const fl = W.floorH[ci];
      const lo = W.spanLo[ci], hi = W.spanHi[ci];
      if (rz[i] <= fl || (hi > lo && rz[i] < hi)) {
        if (rz[i] <= fl + 0.05 && !(hi > lo) && dx * dx + dy * dy < 200) {
          sx[sHead] = rx[i]; sy[sHead] = ry[i]; sz[sHead] = fl + 0.03; sa[sHead] = 0;
          sHead = (sHead + 1) % MAX_SPLASH;
        }
        respawnDrop(i, cam, false);
      }
    }
    for (let i = 0; i < MAX_SPLASH; i++) sa[i] += dt;
    // --- steam
    const E = W.emitters;
    for (let e = 0; e < E.length; e++) {
      const em = E[e];
      const dx = wrapDelta(em.x - cam.x, S), dy = wrapDelta(em.y - cam.y, S);
      if (dx * dx + dy * dy > 1600) continue;
      emitAcc[e] += dt * em.rate;
      while (emitAcc[e] >= 1 && nSteam < MAX_STEAM) {
        emitAcc[e] -= 1;
        const k = nSteam++;
        px[k] = em.x + rng.range(-em.spread, em.spread); py[k] = em.y + rng.range(-em.spread, em.spread); pz[k] = em.z;
        pa[k] = 0; pl[k] = em.life * rng.range(0.7, 1.2);
        pvx[k] = rng.range(-0.1, 0.1); pvy[k] = rng.range(-0.1, 0.1); pvz[k] = em.rise * rng.range(0.7, 1.3);
        pSize[k] = rng.range(0.15, 0.3);
      }
      if (emitAcc[e] > 1) emitAcc[e] = 1;
    }
    for (let k = 0; k < nSteam; k++) {
      pa[k] += dt;
      if (pa[k] >= pl[k]) {
        nSteam--;
        px[k] = px[nSteam]; py[k] = py[nSteam]; pz[k] = pz[nSteam]; pa[k] = pa[nSteam]; pl[k] = pl[nSteam];
        pvx[k] = pvx[nSteam]; pvy[k] = pvy[nSteam]; pvz[k] = pvz[nSteam]; pSize[k] = pSize[nSteam];
        k--; continue;
      }
      px[k] += (pvx[k] + windX * 0.25 * pa[k]) * dt; py[k] += (pvy[k] + windY * 0.25 * pa[k]) * dt;
      pz[k] += pvz[k] * dt; pvz[k] *= 1 - dt * 0.3;
      pSize[k] += dt * 0.35;
    }
  }

  const stats = { drawn: 0, rain: 0 };
  // rain is tinted slightly cooler than the phosphor so it reads as its own layer
  const RAIN = [0.62, 0.8, 1.0];
  function put(scr, col, row, dist, g, add, env) {
    const cols = scr.cols;
    col |= 0; row |= 0;
    if (col < 0 || col >= cols || row < 1 || row >= scr.rows - 1) return;
    const i = row * cols + col;
    if (dist >= scr.gT[i]) return;
    stats.drawn++;
    scr.glyph[i] = g;
    const P = env.phosphor;
    const r = P[0] * 0.4 + RAIN[0] * 0.6, gg = P[1] * 0.4 + RAIN[1] * 0.6, b = P[2] * 0.4 + RAIN[2] * 0.6;
    scr.fr[i] = scr.fr[i] * 0.7 + r * add; scr.fg[i] = scr.fg[i] * 0.7 + gg * add; scr.fb[i] = scr.fb[i] * 0.7 + b * add;
    if (scr.gLum[i] < add / 255) scr.gLum[i] = add / 255;
  }

  function render(scr, cam, env, frame) {
    RC.setupProjection(cam, scr);
    const proj = RC.proj;
    stats.drawn = 0; stats.rain = nRain;
    // rain streaks
    // rain streaks: project the drop and the tail of its motion-blur segment,
    // then walk the characters between them
    const blur = 0.06;
    for (let i = 0; i < nRain; i++) {
      if (!RC.project(rx[i], ry[i], rz[i])) continue;
      const c0 = proj.col, r0 = proj.row, dist = proj.dist;
      if (dist > 20) continue;
      if (!RC.project(rx[i] - windX * blur, ry[i] - windY * blur, rz[i] + rs[i] * blur)) continue;
      const c1 = proj.col, r1 = proj.row;
      const dc = c1 - c0, dr = r1 - r0;
      const fade = 1 - dist / 20;
      const add = 50 + 150 * fade * fade;
      let g = gBar;
      if (Math.abs(dc) > Math.abs(dr) * 0.5) g = dc * dr < 0 ? gSl : gBs;
      if (dist > 13) g = gCol;
      const n = Math.min(4, Math.max(1, Math.round(Math.max(Math.abs(dr), Math.abs(dc)))));
      for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0 : k / (n - 1);
        put(scr, c0 + dc * f, r0 + dr * f, dist, g, add * (1 - f * 0.5), env);
      }
    }
    // splashes
    for (let k = 0; k < MAX_SPLASH; k++) {
      if (sa[k] > 0.16) continue;
      if (!RC.project(sx[k], sy[k], sz[k])) continue;
      put(scr, proj.col, proj.row, proj.dist - 0.05, sa[k] < 0.07 ? gDot : gCom, 90, env);
    }
    // steam puffs: small noisy discs
    const tanH = cam.tanH, cols = scr.cols;
    for (let k = 0; k < nSteam; k++) {
      if (!RC.project(px[k], py[k], pz[k])) continue;
      const dist = proj.dist, cc = proj.col, rr = proj.row;
      const life = pa[k] / pl[k];
      const dens = (life < 0.15 ? life / 0.15 : 1 - (life - 0.15) / 0.85) * 0.85;
      const radC = (pSize[k] / proj.depth) / tanH * cols * 0.5;
      const radR = radC * scr.CW / scr.CH;
      const rc = Math.min(8, Math.ceil(radC)), rw = Math.min(6, Math.ceil(radR));
      for (let oy = -rw; oy <= rw; oy++) for (let ox = -rc; ox <= rc; ox++) {
        const nx = ox / Math.max(radC, 0.5), ny = oy / Math.max(radR, 0.5);
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const n = hash3((cc + ox) | 0, (rr + oy) | 0, (frame >> 2) + k);
        const v = dens * (1 - d2) * (0.6 + 0.4 * n);
        if (v < 0.12) continue;
        const g = STEAMG[Math.min(5, (v * 6) | 0)];
        const col = (cc + ox) | 0, row = (rr + oy) | 0;
        if (col < 0 || col >= cols || row < 1 || row >= scr.rows - 1) continue;
        const i = row * cols + col;
        if (dist >= scr.gT[i]) continue;
        const add = 60 * v;
        scr.glyph[i] = g;
        const P = env.phosphor;
        scr.fr[i] = scr.fr[i] * 0.6 + P[0] * add + 25 * v; scr.fg[i] = scr.fg[i] * 0.6 + P[1] * add + 25 * v; scr.fb[i] = scr.fb[i] * 0.6 + P[2] * add + 25 * v;
      }
    }
  }

  return { init, update, render, covered, stats };
})();
