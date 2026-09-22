// ============================================================================
// shading.js — materials, lighting and glyph selection
// ----------------------------------------------------------------------------
// For every ray hit the shader produces three things:
//
//   1. a MATERIAL response: albedo, optional accent tint, emission, specular,
//      a preferred glyph "ramp" (ordered from sparse to dense characters) and
//      optionally an explicit glyph (window blinds '=', neon letters, lane
//      paint '-' ...). Patterns are procedural functions of the hit's world or
//      primitive-local coordinates — there are no textures.
//   2. LIGHTING: hemispheric ambient + sun + the baked per-cell light list +
//      dynamic lights (car headlights, police lights). Light is kept in two
//      channels: a monochrome "phosphor" channel and an RGB accent channel, so
//      the city stays a terminal-green image while neon light keeps its hue.
//   3. a CHARACTER: luminance -> tone map -> glyph from the material's ramp,
//      with a 4x4 ordered dither for density variation, distance fog that
//      dissolves far geometry into noise / data glyphs, and a colour whose
//      brightness follows the same luminance.
// ============================================================================
AC.Shading = (function () {
  'use strict';
  const { hash2, hash3, vnoise2, smoothstep } = AC.util;
  const M = AC.MAT, ACC = AC.ACCENT, World = AC.World, F = World.F, PS = World.PS;
  const Font = AC.Font;
  const H = AC.hit;
  const TAU = Math.PI * 2;

  let G = null;             // char -> glyph index
  const R = {};             // glyph ramps (arrays of glyph indices)
  let LETTER = null;        // charCode -> glyph index
  let DIGITS = null, NOISE = null;

  let W = null, S = 80, HS = 40, env = null, scr = null;
  let lStart, lList, lx, ly, lz, lr, lg, lb, lrad2, lcur, lmono, ldown;
  let prims, flags, bld, spanLo, spanHi, floorH;
  let time = 0, frame = 0, maxT = 100;
  let PR = 0.55, PG = 1, PB = 0.72; // phosphor colour
  let DL = null;                     // dynamic lights
  let camX = 0, camY = 0, camZ = 0;
  let pixK = 0.01;                   // metres per character per metre of distance

  const BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.47));

  // per-pixel material outputs. Float state lives in fields of one object so
  // V8 updates the doubles in place instead of boxing them on every write.
  const Q = { alb: 0.5, emM: 0.5, emR: 0.5, emG: 0.5, emB: 0.5, spec: 0.5, shin: 0.5, ao: 0.5, refl: 0.5, lod: 0.5, rM: 0.5, rR: 0.5, rG: 0.5, rB: 0.5 };
  let tint = 0, gOv = -1, ramp = null, indoor = 0, dataOk = 0;

  function init(world, environment, screen) {
    W = world; S = world.S; HS = S * 0.5; env = environment; scr = screen;
    lStart = world.lStart; lList = world.lList; lx = world.lx; ly = world.ly; lz = world.lz;
    lr = world.lr; lg = world.lg; lb = world.lb; lrad2 = world.lrad2; lcur = world.lcur; lmono = world.lmono; ldown = world.ldown;
    prims = world.prims; flags = world.flags; bld = world.bld; spanLo = world.spanLo; spanHi = world.spanHi; floorH = world.floorH;
    G = AC.Glyphs.index;
    const mk = (s) => Array.from(s).map((c) => G(c));
    R.def = mk(' .:-=+*#%@');
    R.wall = mk(' .,:;+*#%@');
    R.brick = mk(' .,:=+#%%');
    R.panel = mk(' .:|+#%');
    R.ledge = mk(' .-_=');
    R.ground = mk(' .,-:;=+*#');
    R.metal = mk(' .:;!|I#');
    R.leaf = mk(' .,;*&%8@');
    R.body = mk(' .:;=+oO#@');
    R.window = mk(' .:=+#%@');
    R.glass = mk(' .,:-');
    R.sky = mk(' .`\'-~=');
    R.glow = mk(' .:oO0@');
    R.tire = mk(' .:oO');
    R.cloud = mk(' .-~=');
    NOISE = mk(' .,`\'. ');
    DIGITS = mk('0123456789ABCDEF');
    G_EQ = G('='); G_TIL = G('~'); G_HASH = G('#');
    LETTER = new Int16Array(128).fill(-1);
    for (let c = 33; c < 127; c++) LETTER[c] = G(String.fromCharCode(c));
  }

  function beginFrame(t, fr, cam, maxDist) {
    time = t; frame = fr; maxT = maxDist;
    PR = env.phosphor[0]; PG = env.phosphor[1]; PB = env.phosphor[2];
    DL = AC.dynLights;
    camX = cam.x; camY = cam.y; camZ = cam.z;
    const tanV = cam.tanH * (scr.rows * scr.CH) / (scr.cols * scr.CW);
    pixK = (2 * tanV) / scr.rows;
  }

  // ----------------------------------------------------------------- output
  function out(i, col, row, mono, cr, cg, cb, fog) {
    const L = mono + cr * 0.3 + cg * 0.55 + cb * 0.15;
    const v = 1 - Math.exp(-L * env.exposure);
    const d = BAYER[((row & 3) << 2) | (col & 3)];
    let g;
    if (gOv >= 0 && v > 0.05) g = gOv;
    else {
      const n = ramp.length - 1;
      let k = (v * n + 0.5 + d * 0.45) | 0;
      if (k < 0) k = 0; else if (k > n) k = n;
      g = ramp[k];
    }
    // far geometry dissolves into noise
    if (fog > 0.45) {
      // haze: glyphs flicker between sparse noise characters like analog static
      const p = smoothstep(0.45, 1.0, fog) * 0.7;
      if (hash3(col, row, frame >> 1) < p) g = NOISE[(hash3(row, col, (frame >> 1) + 7) * NOISE.length) | 0];
    }
    // distant facades stream data: glyphs attached to the surface, scrolling down
    if (dataOk && fog > 0.25 && env.dataStreams) {
      // columns of hex digits raining down far facades; each streak has a bright head
      const hu = Math.floor(H.u * 1.25);
      if (hash2(hu, 911) < 0.13) {
        const sp = 2 + hash2(hu, 7) * 3;
        const pos = H.z * 2.4 + time * sp;
        const cell = Math.floor(pos), seg = Math.floor(cell / 14), k = cell - seg * 14;
        if (hash2(hu * 5 + 1, seg) < 0.5 && k < 9) {
          g = DIGITS[(hash2(hu, cell) * 16) | 0];
          const a = smoothstep(0.25, 0.5, fog) * (k < 1 ? 0.8 : 0.4 - k * 0.03);
          scr.glyph[i] = g;
          const I = (0.15 + 0.6 * a) * env.gain;
          scr.fr[i] = 255 * PR * I; scr.fg[i] = 255 * PG * I; scr.fb[i] = 255 * PB * I;
          scr.gLum[i] = v;
          return;
        }
      }
    }
    scr.glyph[i] = g;
    // colour: hue from radiance, brightness from the tone-mapped luminance
    let r = mono * PR + cr, gg = mono * PG + cg, b = mono * PB + cb;
    const sc = ((0.3 + 0.7 * Math.sqrt(v)) / (L + 1e-4)) * env.gain;
    r *= sc; gg *= sc; b *= sc;
    const m = r > gg ? (r > b ? r : b) : (gg > b ? gg : b);
    if (m > 1) {
      const w = Math.min(1, (m - 1) * 0.3);
      r = r / m + (1 - r / m) * w; gg = gg / m + (1 - gg / m) * w; b = b / m + (1 - b / m) * w;
    }
    scr.fr[i] = r * 255; scr.fg[i] = gg * 255; scr.fb[i] = b * 255;
    scr.gLum[i] = v;
  }

  function fogAt(t) {
    const f = 1 - Math.exp(-Math.max(0, t - env.fogStart) * env.fogDensity);
    const e = smoothstep(maxT * 0.8, maxT, t);
    return f + (1 - f) * e;
  }

  // ------------------------------------------------------------------- sky
  function sky(i, col, row, dx, dy, dz) {
    ramp = R.sky; gOv = -1; dataOk = 0;
    const n = env.night;
    const up = dz > 0 ? dz : 0;
    const hz = Math.exp(-up * 5.5);
    let mono = env.skyZenith + (env.skyHorizon - env.skyZenith) * hz;
    let cr = env.fogR * hz, cg = env.fogG * hz, cb = env.fogB * hz;
    if (dz <= 0.01) {
      // ray ran out of range near the horizon: fog
      out(i, col, row, env.fogM, env.fogR, env.fogG, env.fogB, 1);
      return;
    }
    // clouds / smog layer
    const k = 1 / (up + 0.08);
    const cx = dx * k * 0.9 + time * 0.012, cy = dy * k * 0.9 - time * 0.004;
    const c = vnoise2(cx, cy) * 0.62 + vnoise2(cx * 2.9 + 3.1, cy * 2.9) * 0.38;
    if (c > 0.5) {
      const a = (c - 0.5) * 2.3 * (1 - hz * 0.4);
      mono += a * env.cloudLight;
      cr += a * env.fogR * 0.8; cg += a * env.fogG * 0.8; cb += a * env.fogB * 0.8;
      ramp = R.cloud;
    } else if (n > 0.2 && up > 0.06) {
      // stars
      const kk = 1 / (1 + up);
      const sx = Math.floor(dx * kk * 95), sy = Math.floor(dy * kk * 95);
      const h = hash2(sx + 1000, sy + 1000);
      if (h < 0.01) {
        const tw = 0.5 + 0.5 * Math.sin(time * (1.5 + h * 400) + h * 900);
        mono += n * (0.18 + 0.5 * tw) * (h < 0.0025 ? 2.2 : 1) * (1 - c);
        gOv = h < 0.0025 ? G('+') : G('.');
      }
    }
    // moon / sun
    const md = dx * env.moonX + dy * env.moonY + dz * env.moonZ;
    if (md > 0.9982) { mono += 1.4 * n + 0.2; gOv = G(md > 0.9993 ? '@' : 'O'); }
    else if (md > 0.985) mono += (md - 0.985) * 16 * n;
    const sd = dx * env.sunX + dy * env.sunY + dz * env.sunZ;
    if (env.daylight > 0.02) {
      if (sd > 0.998) { mono += 3 * env.daylight; gOv = G('@'); }
      else if (sd > 0.95) mono += (sd - 0.95) * 6 * env.daylight;
    }
    // hover-traffic data rain in the night sky (very faint)
    if (n > 0.35 && up > 0.12 && env.dataStreams) {
      const az = Math.atan2(dy, dx);
      const cid = Math.floor(az * 26);
      const sp = 0.6 + hash2(cid, 3) * 1.6;
      const cell = Math.floor(up * 55 + time * sp * 2.2);
      const seg = hash2(cid, Math.floor(cell / 11));
      if (seg < 0.1) {
        const pos = (cell % 11) / 11;
        mono += n * 0.05 * (1 - pos);
        cg += n * 0.03 * (1 - pos);
        if (pos < 0.8) gOv = DIGITS[(hash2(cid, cell) * 16) | 0];
      }
    }
    out(i, col, row, mono, cr, cg, cb, 0);
  }

  // -------------------------------------------------------------- lighting
  // debug view: glyph = hit kind, brightness = distance (toggle with V)
  function debugShade(i, col, row) {
    const k = H.kind;
    ramp = R.def; gOv = G(' .=#^vo'[k] || '?'); dataOk = 0;
    if (k === 6) gOv = G('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[H.mat % 36]);
    const b = k === 0 ? 0.05 : 1.5 / (1 + H.t * 0.08);
    out(i, col, row, b, 0, 0, 0, 0);
  }

  function shade(i, col, row, dx, dy, dz) {
    if (env.debugView) { debugShade(i, col, row); return; }
    if (H.kind === 0) { sky(i, col, row, dx, dy, dz); return; }
    Q.alb = 0.3; tint = 0; Q.emM = 0; Q.emR = 0; Q.emG = 0; Q.emB = 0; gOv = -1; ramp = R.def;
    Q.spec = 0; Q.shin = 16; Q.ao = 1; indoor = 0; dataOk = 0; Q.refl = 0;
    const ci = H.cell;
    indoor = flags[ci] & F.INTERIOR ? 1 : 0;
    Q.lod = H.t * pixK;
    material(H.mat, dx, dy, dz);

    const x = H.x, y = H.y, z = H.z, nx = H.nx, ny = H.ny, nz = H.nz;
    const amb = env.ambient * (indoor ? 0.3 : 1);
    let Lm = amb * (0.62 + 0.38 * nz) + (nz < 0 ? -nz * env.bounce : 0);
    let Lr = 0, Lg = 0, Lb = 0, Sm = 0, Sr = 0, Sg = 0, Sb = 0;
    if (env.sunI > 0 && !indoor) {
      const d = nx * env.sunX + ny * env.sunY + nz * env.sunZ;
      if (d > 0) Lm += env.sunI * d;
    }
    let rfx = 0, rfy = 0, rfz = 0;
    if (Q.spec > 0) {
      const dn = dx * nx + dy * ny + dz * nz;
      rfx = dx - 2 * dn * nx; rfy = dy - 2 * dn * ny; rfz = dz - 2 * dn * nz;
    }
    // baked static lights reaching this cell
    for (let k = lStart[ci], ke = lStart[ci + 1]; k < ke; k++) {
      const l = lList[k];
      const I = lcur[l];
      if (I < 0.004) continue;
      let ddx = lx[l] - x; if (ddx > HS) ddx -= S; else if (ddx < -HS) ddx += S;
      let ddy = ly[l] - y; if (ddy > HS) ddy -= S; else if (ddy < -HS) ddy += S;
      const ddz = lz[l] - z;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      const r2 = lrad2[l];
      if (d2 >= r2) continue;
      const inv = 1 / Math.sqrt(d2 + 1e-4);
      const ndl = (nx * ddx + ny * ddy + nz * ddz) * inv;
      let a = 1 - d2 / r2; a *= a;
      const cone = ldown[l];
      if (cone > 0) {
        // downward cone: cosine between "straight down" and the direction to the point
        const cs = ddz * inv;
        if (cs < cone) continue;
        a *= smoothstep(cone, cone + 0.25, cs);
      }
      const c = ndl > 0 ? I * a * (0.15 + 0.85 * ndl) : 0;
      let sp = 0;
      if (Q.spec > 0) {
        const rl = (rfx * ddx + rfy * ddy + rfz * ddz) * inv;
        if (rl > 0.5) sp = I * a * Q.spec * Math.pow(rl, Q.shin) * 2.2;
      }
      if (lmono[l]) { Lm += c; Sm += sp; }
      else { Lr += c * lr[l]; Lg += c * lg[l]; Lb += c * lb[l]; Sr += sp * lr[l]; Sg += sp * lg[l]; Sb += sp * lb[l]; }
    }
    // dynamic lights (headlights, police strobes ...)
    if (DL && DL.n) {
      const bx = (x / 8) | 0, by = (y / 8) | 0, bk = (by < 10 ? by : 9) * 10 + (bx < 10 ? bx : 9);
      for (let j = DL.bStart[bk], je = DL.bStart[bk + 1]; j < je; j++) {
        const k = DL.bList[j];
        let ddx = DL.x[k] - x; if (ddx > HS) ddx -= S; else if (ddx < -HS) ddx += S;
        let ddy = DL.y[k] - y; if (ddy > HS) ddy -= S; else if (ddy < -HS) ddy += S;
        const ddz = DL.z[k] - z;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        const r2 = DL.r2[k];
        if (d2 >= r2) continue;
        const inv = 1 / Math.sqrt(d2 + 1e-4);
        let a = 1 - d2 / r2; a *= a;
        const cc = DL.cos[k];
        if (cc > -1) {
          const cs = -(ddx * DL.dx[k] + ddy * DL.dy[k] + ddz * DL.dz[k]) * inv;
          if (cs < cc) continue;
          a *= smoothstep(cc, cc + 0.12, cs);
        }
        const ndl = (nx * ddx + ny * ddy + nz * ddz) * inv;
        const I = DL.I[k] * a;
        const c = ndl > 0 ? I * (0.15 + 0.85 * ndl) : 0;
        let sp = 0;
        if (Q.spec > 0) {
          const rl = (rfx * ddx + rfy * ddy + rfz * ddz) * inv;
          if (rl > 0.5) sp = I * Q.spec * Math.pow(rl, Q.shin) * 2.2;
        }
        if (DL.mono[k]) { Lm += c; Sm += sp; }
        else { Lr += c * DL.r[k]; Lg += c * DL.g[k]; Lb += c * DL.b[k]; Sr += sp * DL.r[k]; Sg += sp * DL.g[k]; Sb += sp * DL.b[k]; }
      }
    }
    // cheap contact shadows
    if (H.kind === 1) Q.ao *= floorAO(x, y);
    else if (H.kind === 3) Q.ao *= 0.5 + 0.5 * smoothstep(0.15, 1.4, z);

    const aa = Q.alb * Q.ao;
    let mono, cr, cg, cb;
    if (tint === 0) { mono = aa * Lm; cr = aa * Lr; cg = aa * Lg; cb = aa * Lb; }
    else {
      const T = ACC[tint];
      mono = 0; cr = aa * T[0] * (Lm + Lr); cg = aa * T[1] * (Lm + Lg); cb = aa * T[2] * (Lm + Lb);
    }
    mono += Q.emM + Sm; cr += Q.emR + Sr; cg += Q.emG + Sg; cb += Q.emB + Sb;

    // wet ground: trace a mirrored ray and add what it sees (neon in puddles)
    if (Q.refl > 0.03 && H.kind === 1 && H.t < env.reflDist && env.reflections) {
      reflect(dx, dy, dz);
      const base = mono + cr * 0.3 + cg * 0.55 + cb * 0.15;
      mono += Q.rM * Q.refl; cr += Q.rR * Q.refl; cg += Q.rG * Q.refl; cb += Q.rB * Q.refl;
      const rl = (Q.rM + Q.rR * 0.3 + Q.rG * 0.55 + Q.rB * 0.15) * Q.refl;
      if (Q.refl > 0.3 && rl > 0.08 && rl > base * 0.8) gOv = rl > 0.4 ? G_EQ : G_TIL;
    }

    // glass pane in front of the hit (shop windows): tint + reflections
    if (H.glassT >= 0) {
      const gt = H.glassT;
      mono *= 0.62; cr *= 0.7; cg *= 0.7; cb *= 0.7;
      const gx = camX + dx * gt, gy = camY + dy * gt, gz = camZ + dz * gt;
      const gu = H.gnx !== 0 ? gy : gx;
      const s = gu * 0.9 + gz * 0.55;
      const st = s - Math.floor(s);
      if (st < 0.06) { mono += 0.1 + env.daylight * 0.25; if (mono < 0.12) gOv = G('/'); }
      mono += env.daylight * 0.12;
    }

    const f = fogAt(H.t);
    const nf = 1 - f, ne = 1 - f * 0.55;
    mono = (mono - Q.emM) * nf + Q.emM * ne + env.fogM * f;
    cr = (cr - Q.emR) * nf + Q.emR * ne + env.fogR * f;
    cg = (cg - Q.emG) * nf + Q.emG * ne + env.fogG * f;
    cb = (cb - Q.emB) * nf + Q.emB * ne + env.fogB * f;
    out(i, col, row, mono, cr, cg, cb, f);
  }

  // ------------------------------------------------------ mirror reflections
  let G_EQ = 0, G_TIL = 0, G_HASH = 0;
  const stats = { refl: 0 };
  function reflect(dx, dy, dz) {
    stats.refl++;
    // save hit + material state
    const sT = H.t, sX = H.x, sY = H.y, sZ = H.z, sCell = H.cell, sKind = H.kind, sGlass = H.glassT;
    const sAlb = Q.alb, sTint = tint, sEM = Q.emM, sER = Q.emR, sEG = Q.emG, sEB = Q.emB, sG = gOv, sRamp = ramp, sSpec = Q.spec, sShin = Q.shin, sAo = Q.ao, sInd = indoor, sData = dataOk, sRefl = Q.refl, sLod = Q.lod;
    // rain ripples wobble the mirror normal
    const rip = env.rain > 0 ? 0.05 * env.rain : 0.012;
    const wx = (vnoise2(sX * 7, sY * 7 + time * 4) - 0.5) * rip, wy = (vnoise2(sY * 7 + 3, sX * 7 - time * 3) - 0.5) * rip;
    let rx = dx + wx, ry = dy + wy, rz = -dz;
    const inv = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz);
    rx *= inv; ry *= inv; rz *= inv;
    AC.Raycaster.castRay(sX, sY, sZ + 0.02, rx, ry, rz, 40);
    Q.rM = 0; Q.rR = 0; Q.rG = 0; Q.rB = 0;
    if (H.kind === 0) {
      const up = rz > 0 ? rz : 0, hz = Math.exp(-up * 5.5);
      Q.rM = env.skyZenith + (env.skyHorizon - env.skyZenith) * hz;
      Q.rR = env.fogR * hz; Q.rG = env.fogG * hz; Q.rB = env.fogB * hz;
    } else {
      Q.alb = 0.3; tint = 0; Q.emM = 0; Q.emR = 0; Q.emG = 0; Q.emB = 0; gOv = -1; Q.spec = 0; Q.refl = 0;
      indoor = flags[H.cell] & F.INTERIOR ? 1 : 0;
      Q.lod = (H.t + sT) * pixK;
      material(H.mat, rx, ry, rz);
      // cheap lighting for the reflected surface: ambient + nearby lamps only
      let L = env.ambient * (indoor ? 0.3 : 1) + env.sunI * 0.5;
      const ci = H.cell;
      for (let k = lStart[ci], ke = lStart[ci + 1]; k < ke; k++) {
        const l = lList[k];
        if (!lmono[l]) continue;
        let ddx = lx[l] - H.x; if (ddx > HS) ddx -= S; else if (ddx < -HS) ddx += S;
        let ddy = ly[l] - H.y; if (ddy > HS) ddy -= S; else if (ddy < -HS) ddy += S;
        const ddz = lz[l] - H.z, d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < lrad2[l] && (ldown[l] === 0 || ddz * ddz > ldown[l] * ldown[l] * d2)) { const a = 1 - d2 / lrad2[l]; L += lcur[l] * a * a * 0.6; }
      }
      const f = fogAt(H.t + sT), nf = 1 - f;
      if (tint) { const T = ACC[tint]; Q.rR = Q.alb * T[0] * L; Q.rG = Q.alb * T[1] * L; Q.rB = Q.alb * T[2] * L; }
      else Q.rM = Q.alb * L;
      Q.rM = (Q.rM + Q.emM) * nf + env.fogM * f; Q.rR = (Q.rR + Q.emR) * nf + env.fogR * f; Q.rG = (Q.rG + Q.emG) * nf + env.fogG * f; Q.rB = (Q.rB + Q.emB) * nf + env.fogB * f;
    }
    // restore
    H.t = sT; H.x = sX; H.y = sY; H.z = sZ; H.cell = sCell; H.kind = sKind; H.glassT = sGlass;
    Q.alb = sAlb; tint = sTint; Q.emM = sEM; Q.emR = sER; Q.emG = sEG; Q.emB = sEB; gOv = sG; ramp = sRamp; Q.spec = sSpec; Q.shin = sShin; Q.ao = sAo; indoor = sInd; dataOk = sData; Q.refl = sRefl; Q.lod = sLod;
  }

  function solidTall(ci) { return spanHi[ci] > 1.2 && spanLo[ci] < 0.5 && !(flags[ci] & F.GLASS); }
  function floorAO(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const xm = ix === 0 ? S - 1 : ix - 1, xp = ix === S - 1 ? 0 : ix + 1;
    const ym = iy === 0 ? S - 1 : iy - 1, yp = iy === S - 1 ? 0 : iy + 1;
    let a = 1;
    if (solidTall(iy * S + xm)) a *= 0.45 + 0.55 * smoothstep(0, 0.85, fx);
    if (solidTall(iy * S + xp)) a *= 0.45 + 0.55 * smoothstep(0, 0.85, 1 - fx);
    if (solidTall(ym * S + ix)) a *= 0.45 + 0.55 * smoothstep(0, 0.85, fy);
    if (solidTall(yp * S + ix)) a *= 0.45 + 0.55 * smoothstep(0, 0.85, 1 - fy);
    return a;
  }

  // ------------------------------------------------------------- materials
  function emit(col, I) {
    if (col === 0) Q.emM += I;
    else { const c = ACC[col]; Q.emR += c[0] * I; Q.emG += c[1] * I; Q.emB += c[2] * I; }
  }

  function material(mat, dx, dy, dz) {
    const o = H.prim >= 0 ? H.prim * PS : -1;
    switch (mat) {
      case M.ASPHALT: road(H.x, H.y); break;
      case M.SIDEWALK: sidewalk(H.x, H.y); break;
      case M.ALLEY: alley(H.x, H.y); break;
      case M.CURB: Q.alb = 0.42; ramp = R.wall; break;
      case M.SILL: Q.alb = 0.26; ramp = R.metal; Q.spec = 0.3; break;
      case M.CONCRETE: case M.PANEL: case M.BRICK: case M.GLASSWALL: case M.INDUSTRIAL:
        wall(mat); break;
      case M.ROOF:
        Q.alb = 0.15 + 0.08 * vnoise2(H.x * 1.5, H.y * 1.5, 120); ramp = R.ground; Q.spec = env.wet * 0.25; Q.shin = 10;
        dataOk = 1; break;
      case M.CEILING: ceiling(); break;
      case M.INT_FLOOR: {
        const chk = (Math.floor(H.x / 0.6) + Math.floor(H.y / 0.6)) & 1;
        Q.alb = chk ? 0.44 : 0.09; Q.spec = 0.3; Q.shin = 40; ramp = R.ground; Q.refl = 0.1;
        break;
      }
      case M.CARPET: carpet(); break;
      default: primMaterial(mat, o, dx, dy, dz);
    }
  }

  // ---- road with lane paint, crosswalks, stop lines, manholes, puddles
  function paint(color, glyph, a) { Q.alb = a || 0.62; tint = color; Q.spec *= 0.3; gOv = glyph; }
  function road(x, y) {
    Q.alb = 0.12 + 0.08 * vnoise2(x * 2, y * 2, 160);
    ramp = R.ground; Q.spec = env.wet * 0.3; Q.shin = 24;
    const pud = vnoise2(x * 0.35, y * 0.35, 28);
    Q.refl = env.wet * 0.2;
    if (pud > 0.56 && env.wet > 0) { Q.spec = env.wet * 1.2; Q.shin = 60; Q.alb *= 0.55; Q.refl = env.wet * (0.45 + 0.4 * smoothstep(0.56, 0.7, pud)); }
    // manholes
    const mh = W.manholes;
    for (let k = 0; k < mh.length; k++) {
      const ddx = x - mh[k].x, ddy = y - mh[k].y, d = ddx * ddx + ddy * ddy;
      if (d < 0.3) {
        const r = Math.sqrt(d);
        if (r > 0.44) { Q.alb = 0.35; gOv = G('o'); }
        else { Q.alb = (((x * 8) | 0) + ((y * 8) | 0)) & 1 ? 0.3 : 0.12; ramp = R.metal; }
        Q.spec = 0.2; return;
      }
    }
    const inNS = x >= 3 && x < 13, inEW = y >= 3 && y < 13;
    if (inNS && inEW) return;
    if (inNS) marks(x, y, 0);
    else if (inEW) marks(y, x, 1);
  }
  // a: across-road coordinate, s: along-road coordinate
  function marks(a, s, axis) {
    if ((s >= 0.35 && s < 2.65) || (s >= 13.35 && s < 15.65)) {
      if (a > 3.3 && a < 12.7 && (((a - 3.3) * 1.66) | 0) % 2 === 0) paint(0, G('#'), 0.42);
      return;
    }
    if (s < 16) return;
    if (Math.abs(a - 8) < 0.1 && (s % 5) < 2.6) { paint(3, G('='), 0.6); return; }
    if (Math.abs(a - 5) < 0.06 || Math.abs(a - 11) < 0.06) { paint(0, G('-'), 0.5); return; }
    if ((a < 5 || a > 11) && (s % 6.3) < 0.1) { paint(0, G('-'), 0.45); return; }
    const hiLane = a >= 8;
    const stopFar = s > 78.7 && s < 79.25, stopNear = s > 16.75 && s < 17.3;
    if (axis === 0 ? (hiLane && stopFar) || (!hiLane && a > 5 && stopNear) : (!hiLane && a > 5 && stopFar) || (hiLane && a < 11 && stopNear)) {
      paint(0, G('='), 0.62);
      return;
    }
    // "STOP" painted before the stop line, readable by the approaching driver
    const inLane = hiLane ? a < 11 : a > 5;
    if (inLane) {
      let t = -1, across = 0;
      const approachHigh = axis === 0 ? hiLane : !hiLane; // lane driving towards +s
      if (approachHigh && s > 73.5 && s < 77.5) { t = (s - 73.5) / 4; across = hiLane ? (a - 8) / 3 : (a - 5) / 3; }
      else if (!approachHigh && s > 18.5 && s < 22.5) { t = (22.5 - s) / 4; across = hiLane ? (11 - a) / 3 : (8 - a) / 3; }
      if (t >= 0) {
        if (axis === 1) across = 1 - across;
        const res = Font.sample('STOP', false, across, 1 - t, 0);
        if (res === 1) paint(0, G('#'), 0.5);
      }
    }
  }
  function sidewalk(x, y) {
    Q.alb = 0.24 + 0.08 * vnoise2(x * 3, y * 3, 240);
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const j = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (j < 0.035 && Q.lod < 0.05) Q.alb *= 0.45;
    Q.spec = env.wet * 0.35; Q.shin = 12; ramp = R.ground;
    Q.refl = env.wet * 0.12;
  }
  function alley(x, y) {
    Q.alb = 0.1 + 0.1 * vnoise2(x * 0.9, y * 0.9, 72);
    ramp = R.ground; Q.spec = env.wet * 0.9; Q.shin = 24;
    const g = vnoise2(x * 0.5, y * 0.5, 40);
    Q.refl = env.wet * 0.2;
    if (g > 0.62) { Q.spec = env.wet * 2.2; Q.shin = 60; Q.alb *= 0.5; Q.refl = env.wet * 0.7; }
  }

  // ---- building walls
  function wall(style) {
    const ci = H.cell;
    const b = W.buildings[bld[ci]];
    if (!b) { Q.alb = 0.3; ramp = R.wall; return; }
    const z = H.z;
    // interior side of a wall?
    const nci = W.idx(H.x + H.nx * 0.5, H.y + H.ny * 0.5);
    if (flags[nci] & F.INTERIOR) { indoor = 1; interiorWall(b, H.u, z); return; }
    const face = H.face;
    const ua = H.u - (face < 2 ? b.y0 : b.x0);
    dataOk = 1;
    if (z < b.groundH) { groundFloor(b, ua, z, face); return; }
    const top = spanHi[ci];
    if (z > top - 0.5 && Q.lod < 0.6) { Q.alb = 0.44 * b.shade; ramp = R.ledge; return; }
    const fh = b.floorH, zf = z - b.groundH, flf = zf / fh, fl = Math.floor(flf), fz = flf - fl;
    const sp = b.winSp, cu = ua / sp, wc = Math.floor(cu), fu = cu - wc;
    if (fz < 0.06 && style !== M.GLASSWALL && Q.lod < 0.35) { Q.alb = 0.46 * b.shade; ramp = R.ledge; return; }
    const hw = b.winFrac * 0.5;
    const du = hw - Math.abs(fu - 0.5);
    if (du > 0 && fz > b.winV0 && fz < b.winV1) {
      const em = du * sp, ev = Math.min(fz - b.winV0, b.winV1 - fz) * fh;
      if ((em < 0.07 || ev < 0.07) && Q.lod < 0.14) { Q.alb = 0.5 * b.shade; ramp = R.metal; return; }
      windowPane(b, fl, wc, face, zf, fz, fu, hw);
      return;
    }
    wallStyle(b, style, ua, z, zf, fz);
  }

  function windowPane(b, fl, wc, face, zf, fz, fu, hw) {
    const hs = hash3(b.id * 7 + face, fl, wc);
    let lit = hs < b.lit * env.windowsLit;
    if (hash3(b.id * 13 + wc, fl, Math.floor(time / 23 + hs * 97)) < 0.04) lit = !lit;
    dataOk = 0;
    if (lit) {
      const h2 = hash3(b.id, fl * 31 + wc, face + 7);
      let I = (0.3 + 0.55 * h2) * env.windowGain;
      const blind = hash3(b.id + 5, fl, wc);
      Q.alb = 0.05; ramp = R.window;
      if (Q.lod > 0.3) { /* too small on screen for blinds or silhouettes */ }
      else if (blind < 0.35) { if (((zf * 7) | 0) & 1) I *= 0.5; gOv = G('='); }
      else if (blind < 0.47) I *= 0.4;
      else if (blind > 0.86) {
        // a silhouette standing in the window
        const cx = Math.abs(fu - 0.5) / hw;
        const top = b.winV0 + (b.winV1 - b.winV0) * 0.78;
        if (cx < 0.3 && fz < top && !(fz > top - 0.1 && cx > 0.18)) I *= 0.1;
      }
      if (h2 > 0.93) { I *= 0.45 + 0.55 * vnoise2(time * 7, wc + fl * 3); emit(8, I); }
      else if (hash3(b.id + 3, fl, wc) < b.accentWin) emit(b.winAccent, I * 0.8);
      else Q.emM += I;
    } else {
      Q.alb = 0.02; Q.spec = 0.45; Q.shin = 90; ramp = R.glass;
      Q.emM += env.daylight * 0.16 * (0.6 + 0.4 * hs);
    }
  }

  function wallStyle(b, style, ua, z, zf, fz) {
    switch (style) {
      case M.CONCRETE: {
        Q.alb = (0.2 + 0.08 * vnoise2(ua * 0.7, z * 0.5)) * b.shade;
        const st = vnoise2(ua * 2.3, z * 0.12);
        if (st > 0.7) Q.alb *= 0.7;
        ramp = R.wall; break;
      }
      case M.PANEL: {
        Q.alb = 0.32 * b.shade;
        const fp = ua / 1.5 - Math.floor(ua / 1.5);
        const h2 = (zf / (b.floorH * 0.5)) % 1;
        if ((fp < 0.035 || h2 < 0.05) && Q.lod < 0.12) Q.alb *= 0.45;
        ramp = R.panel; break;
      }
      case M.BRICK: {
        const row = Math.floor(z / 0.25);
        const bu = (ua + (row & 1) * 0.3) / 0.6;
        const mortar = Q.lod < 0.1 && (z / 0.25 - row < 0.2 || bu - Math.floor(bu) < 0.08);
        Q.alb = mortar ? 0.14 : (0.26 + (Q.lod < 0.2 ? 0.12 * hash2(row, Math.floor(bu)) : 0.05)) * b.shade;
        ramp = R.brick; break;
      }
      case M.GLASSWALL:
        Q.alb = 0.12 * b.shade; Q.spec = 0.8; Q.shin = 40; ramp = R.glass; break;
      case M.INDUSTRIAL: {
        const rib = Q.lod < 0.12 ? 0.5 + 0.5 * Math.cos(ua * TAU / 0.35) : 0.5;
        Q.alb = (0.14 + 0.14 * rib) * b.shade;
        ramp = R.metal; break;
      }
      default: Q.alb = 0.3; ramp = R.wall;
    }
  }

  function groundFloor(b, ua, z, face) {
    const seg = Math.floor(ua / 4.2), fu = ua / 4.2 - seg;
    const st = hash3(b.id, seg, face + 3);
    ramp = R.wall;
    if (z > 3.0) { Q.alb = 0.13; return; }
    if (z < 0.25) { Q.alb = 0.2; return; }
    if (fu < 0.05 || fu > 0.95) { Q.alb = 0.36 * b.shade; ramp = R.panel; return; }
    if (st < 0.34) {
      // rolling shutter
      const rib = ((z * 9) | 0) & 1;
      Q.alb = rib ? 0.34 : 0.22;
      if (rib) gOv = G('=');
      if (hash3(b.id, seg, 99) < 0.22) {
        // spray-paint tag on the shutter
        const tu = (fu - 0.3) / 0.45, tv = (2.1 - z) / 0.55;
        if (tu > 0 && tu < 1 && tv > 0 && tv < 1) {
          const words = ['XX', 'FREE', 'V01D', 'Z3N', 'RUN'];
          const w = words[(hash2(b.id, seg) * words.length) | 0];
          if (Font.sample(w, false, tu, tv, 0) === 1) { tint = [1, 2, 5, 6][seg & 3]; Q.alb = 0.55; gOv = LETTER[Font.lastChar]; }
        }
      }
    } else if (st < 0.62) {
      // lit display window
      if (z > 0.7 && z < 2.8) {
        const I = 0.3 + 0.3 * hash3(b.id, seg, 5);
        const gx = Math.floor(ua * 3), gz = Math.floor(z * 3);
        const p = hash2(gx + b.id * 17, gz);
        const col = hash3(b.id, seg, 6) < 0.5 ? 0 : [1, 2, 3, 6][seg & 3];
        emit(col, I * (p < 0.3 ? 1.7 : 0.8));
        Q.alb = 0.05; ramp = R.window;
        if (p < 0.3) gOv = G(p < 0.1 ? 'o' : p < 0.2 ? '#' : '[');
      } else Q.alb = 0.3;
    } else if (st < 0.84) {
      // dark glass
      if (z > 0.6 && z < 2.8) { Q.alb = 0.04; Q.spec = 1.1; Q.shin = 60; ramp = R.glass; Q.emM += env.daylight * 0.12; }
      else Q.alb = 0.3;
    } else {
      // plain wall with posters
      Q.alb = 0.26 * b.shade;
      const pu = Math.floor(ua / 1.1), pz = z > 0.9 && z < 2.1;
      const ph = hash3(b.id, pu, 7);
      if (pz && ph < 0.5 && (ua / 1.1 - pu) > 0.1 && (ua / 1.1 - pu) < 0.85) {
        tint = [1, 2, 3, 6, 9][((ph * 10) | 0) % 5]; Q.alb = 0.45;
        const gx = Math.floor(ua * 4), gz = Math.floor(z * 4);
        if (hash2(gx, gz) < 0.35) gOv = G(hash2(gz, gx) < 0.5 ? '#' : '=');
      }
    }
  }

  function interiorWall(b, u, z) {
    ramp = R.wall;
    if (b.shop === 'arcade') {
      Q.alb = 0.1;
      if (z > 2.3 && z < 2.42) { emit(((u * 0.5) | 0) & 1 ? 1 : 2, 1.2); gOv = G('='); }
      else if (z > 0.3 && z < 2.1) {
        // retro posters
        const pu = Math.floor(u / 1.6);
        if (hash2(pu, 3) < 0.5 && (u / 1.6 - pu) > 0.15 && (u / 1.6 - pu) < 0.8) {
          emit([1, 2, 6, 3][pu & 3], 0.18); Q.alb = 0.2;
          if (hash2(Math.floor(u * 5), Math.floor(z * 5)) < 0.3) gOv = G('*');
        }
      }
    } else {
      if (z < 1.05) {
        Q.alb = 0.24; const fp = u * 4 - Math.floor(u * 4);
        if (fp < 0.1) Q.alb = 0.1;
      } else if (z < 1.13) Q.alb = 0.45;
      else {
        Q.alb = 0.34;
        const pu = Math.floor(u / 1.3);
        if (z > 1.6 && z < 2.5 && hash2(pu, 9) < 0.45 && (u / 1.3 - pu) > 0.15 && (u / 1.3 - pu) < 0.85) {
          tint = hash2(pu, 10) < 0.5 ? 3 : 1; Q.alb = 0.5;
          if (hash2(Math.floor(u * 6), Math.floor(z * 6)) < 0.4) gOv = G('=');
        }
      }
    }
  }

  function ceiling() {
    Q.alb = 0.12; ramp = R.ledge; indoor = 1;
    const b = W.buildings[bld[H.cell]];
    const fx = H.x * 0.83 - Math.floor(H.x * 0.83), fy = H.y * 0.83 - Math.floor(H.y * 0.83);
    if (fx < 0.03 || fy < 0.03) Q.alb = 0.05;
    if (b && b.ceil) {
      // light panels above every ceiling light
      const L = b.ceilLights;
      if (L) for (let k = 0; k < L.length; k++) {
        const ddx = Math.abs(H.x - L[k][0]), ddy = Math.abs(H.y - L[k][1]);
        if (ddx < 0.6 && ddy < 0.6 && Math.min(ddx, ddy) < 0.22) {
          if (b.shop === 'arcade') emit(L[k][2], 1.5); else Q.emM += 1.6;
          gOv = G('#'); Q.alb = 0.1; break;
        }
      }
    }
  }

  function carpet() {
    Q.alb = 0.08; ramp = R.ground; indoor = 1;
    const gx = Math.floor(H.x * 1.4), gy = Math.floor(H.y * 1.4);
    const h = hash2(gx, gy);
    if (h < 0.2) {
      const px = H.x * 1.4 - gx - 0.5, py = H.y * 1.4 - gy - 0.5;
      let on = false, ch = 'o';
      if (h < 0.07) { const r = Math.sqrt(px * px + py * py); on = Math.abs(r - 0.28) < 0.07; ch = 'o'; }
      else if (h < 0.14) { const d = Math.abs(px) + Math.abs(py); on = d < 0.34 && d > 0.22; ch = '^'; }
      else { on = Math.abs(py - 0.2 * Math.sin(px * 12)) < 0.06 && Math.abs(px) < 0.4; ch = '~'; }
      if (on) { emit([1, 2, 6][(h * 97 | 0) % 3], 0.4); gOv = G(ch); }
    }
  }

  // ---- primitives
  function sideUV(o) {
    // returns u across the face (0..1) for faces 0..3 of a box
    return H.face < 2 ? H.v / (2 * prims[o + 6]) : H.u / (2 * prims[o + 5]);
  }

  function primMaterial(mat, o, dx, dy, dz) {
    const col = prims[o + 10] | 0, A = prims[o + 11], B = prims[o + 12], seed = prims[o + 15];
    const face = H.face;
    switch (mat) {
      case M.POLE: Q.alb = 0.3; Q.spec = 0.4; Q.shin = 20; ramp = R.metal; break;
      case M.PIPE: Q.alb = 0.28; Q.spec = 0.3; ramp = R.metal; if ((H.w % 1.6) < 0.07) Q.alb = 0.45; break;
      case M.LAMP: {
        Q.alb = 0.25; ramp = R.metal;
        if (face === 4) {
          let I = env.lampsOn;
          if (A > 0) { const li = A - 1; I = W.lbase[li] > 0 ? lcur[li] / W.lbase[li] : 0; }
          if (I > 0.05) { Q.emM += 2.6 * I; gOv = G('@'); }
        }
        break;
      }
      case M.TRUNK: Q.alb = 0.24; ramp = R.metal; break;
      case M.LEAVES: {
        const n = vnoise2(H.u * 4.5 + H.w * 2.1 + seed * 3.7, H.v * 4.5 - H.w * 1.7);
        Q.alb = 0.1 + 0.36 * n; ramp = R.leaf;
        if ((seed | 0) % 3 === 0) {
          const g = hash3(Math.floor(H.u * 5), Math.floor(H.v * 5), Math.floor(H.w * 5) + (seed | 0));
          if (g < 0.07) {
            const tw = 0.55 + 0.45 * Math.sin(time * 3 + g * 300);
            emit([2, 1, 3][(seed | 0) % 3 === 0 ? ((seed / 3) | 0) % 3 : 0], 1.6 * tw);
            gOv = G('*');
          }
        }
        break;
      }
      case M.PLANTER: Q.alb = face === 5 ? 0.08 : 0.32; ramp = R.wall; break;
      case M.METAL:
        Q.alb = 0.3; Q.spec = 0.35; ramp = R.metal;
        if (A === 1 && (H.w % 0.3) < 0.05) Q.alb = 0.15;
        break;
      case M.HYDRANT: tint = 4; Q.alb = 0.55; Q.spec = 0.5; ramp = R.body; break;
      case M.BOLLARD:
        Q.alb = 0.3; ramp = R.metal;
        if (H.w > 0.78 && H.w < 0.87) { emit(col || 2, 1.6); gOv = G('='); }
        break;
      case M.CAR_BODY:
        tint = col; Q.alb = A || 0.4; Q.spec = 0.9; Q.shin = 40; ramp = R.body;
        if (H.w < 0.12 && face < 4) Q.alb *= 0.5;
        if (face >= 2 && face <= 3) { const u = H.u; if (Math.abs(u - prims[o + 5] * 1.05) < 0.02) Q.alb *= 0.4; }
        break;
      case M.CAR_CABIN: {
        if (B === 2) { Q.alb = 0.05; Q.spec = 1.3; Q.shin = 60; ramp = R.glass; emit(2, 0.15); break; }
        const hx = prims[o + 5];
        if (face === 5) { tint = col; Q.alb = A || 0.4; Q.spec = 0.8; Q.shin = 40; ramp = R.body; break; }
        let glass = true;
        if (face === 2 || face === 3) {
          const u = H.u;
          if (u < 0.14 || u > 2 * hx - 0.12 || Math.abs(u - hx * (B === 1 ? 1.5 : 0.95)) < 0.06) glass = false;
          if (B === 1 && H.w < 0.35) glass = false;
        } else {
          const u = H.v;
          if (u < 0.1 || u > 2 * prims[o + 6] - 0.1 || H.w < 0.06) glass = false;
        }
        if (glass) { Q.alb = 0.04; Q.spec = 1.3; Q.shin = 60; ramp = R.glass; }
        else { tint = col; Q.alb = A || 0.4; Q.spec = 0.7; ramp = R.body; }
        break;
      }
      case M.HEADLIGHT: {
        Q.alb = 0.35; ramp = R.glow;
        if (B && env.blinkOn) { emit(3, 2.2); gOv = G('*'); }
        else if (A > 0) { emit(7, 3.2); gOv = G('@'); }
        break;
      }
      case M.TAILLIGHT: {
        Q.alb = 0.2; ramp = R.glow;
        const across = H.v, w = 2 * prims[o + 6];
        const blinkEnd = B !== 0 && env.blinkOn && ((B === -1 || B === 2) && across > w - 0.35 || (B === 1 || B === 2) && across < 0.35);
        if (blinkEnd) { emit(3, 2.2); gOv = G('*'); }
        else { emit(col || 4, 0.4 + A * 1.5); gOv = A > 0.8 ? G('#') : G('='); }
        break;
      }
      case M.TIRE: Q.alb = 0.06; ramp = R.tire; break;
      case M.PED_BODY: {
        tint = col; Q.alb = A || 0.3; ramp = R.body;
        if (B > 0 && prims[o] === 1) {
          const f = H.w / (prims[o + 4] - prims[o + 3]);
          if ((f > 0.5 && f < 0.58) || (face < 2 && Math.abs(H.v - prims[o + 6]) < 0.025)) { emit(B | 0, 1.4); gOv = G('='); }
        }
        break;
      }
      case M.PED_SKIN: Q.alb = 0.5; ramp = R.body; break;
      case M.PED_LEGS: Q.alb = 0.15; ramp = R.body; break;
      case M.HAIR: Q.alb = 0.09; ramp = R.body; break;
      case M.VISOR: emit(col || 2, 2.0); gOv = G('='); Q.alb = 0.1; break;
      case M.UMBRELLA: {
        const r = Math.sqrt(H.u * H.u + H.v * H.v), R0 = prims[o + 5];
        ramp = R.glow; Q.alb = 0.1;
        if (r > R0 * 0.84) { emit(col, 1.7); gOv = G('~'); }
        else {
          const ang = Math.atan2(H.v, H.u) / TAU * 8;
          if (ang - Math.floor(ang) < 0.1) { emit(col, 0.9); gOv = G(H.u * H.v > 0 ? '\\' : '/'); }
          else emit(col, 0.24);
        }
        break;
      }
      case M.SIGN: signMat(o, false); break;
      case M.GRAFFITI: signMat(o, true); break;
      case M.BILLBOARD: billboard(o); break;
      case M.SCREEN: screenMat(o); break;
      case M.VENDING: vendingMat(o, col, A); break;
      case M.SIGNAL: signalMat(o, A | 0); break;
      case M.PEDSIGNAL: {
        Q.alb = 0.12; ramp = R.metal;
        if (face === 1) {
          const walk = env.pedWalk[1 - (A | 0)];
          const u = H.v / (2 * prims[o + 6]), v = 1 - H.w / (prims[o + 4] - prims[o + 3]);
          if (u > 0.15 && u < 0.85 && v > 0.12 && v < 0.88) {
            if (walk) { emit(5, 1.6); gOv = G(v < 0.35 ? 'o' : v < 0.7 ? 'Y' : 'A'); }
            else if (!env.pedFlash || env.blinkOn) { emit(4, 1.4); gOv = G(v < 0.5 ? '#' : 'U'); }
          }
        }
        break;
      }
      case M.NEON: {
        const tall = (prims[o + 4] - prims[o + 3]) > 2 * Math.max(prims[o + 5], prims[o + 6]);
        const hum = 0.9 + 0.1 * Math.sin(time * 40 + seed);
        emit(col, 1.9 * (A || 1) * hum); Q.alb = 0.1; ramp = R.glow;
        gOv = G(tall ? '|' : '=');
        break;
      }
      case M.BULB: {
        let I = 1;
        if (A === 1) I = ((time + B) % 1.2) < 0.6 ? 1 : 0.05;
        else if (A === 2) I = ((time * 0.7 + B) % 1.5) < 0.18 ? 1 : 0.08;
        else if (A === 3) I = (Math.floor(time * 7 + B * 2) & 1) ? 1 : 0.05;
        emit(col, 2.6 * I); Q.alb = 0.2; ramp = R.glow;
        gOv = I > 0.5 ? G('@') : G('o');
        break;
      }
      case M.LANTERN: {
        const I = 0.9 + 0.1 * Math.sin(time * 2 + seed);
        const rib = (H.w * 9 + 10) % 1 < 0.22;
        emit(col, (rib ? 0.6 : 1.25) * I); Q.alb = 0.2; ramp = R.glow;
        gOv = G(rib ? '=' : '#');
        break;
      }
      case M.COUNTER:
        Q.alb = 0.26; ramp = R.wall;
        if (face < 4 && H.w < 0.12) { emit(col || 1, 1.5); gOv = G('='); }
        else if (face < 4 && (H.u * 3) % 1 < 0.08) Q.alb = 0.12;
        break;
      case M.WOOD: Q.alb = 0.26 + 0.08 * Math.sin((H.u + H.v) * 25 + vnoise2(H.u * 3, H.w * 3) * 4); ramp = R.wall; break;
      case M.STOOL: tint = col; Q.alb = 0.5; Q.spec = 0.5; ramp = R.body; break;
      case M.DUMPSTER:
        Q.alb = 0.2; ramp = R.metal;
        if (face < 4 && (H.u * 3) % 1 < 0.12) Q.alb = 0.1;
        break;
      case M.CRATE: Q.alb = 0.28; ramp = R.wall; if ((H.w * 5) % 1 < 0.15) Q.alb = 0.12; break;
      case M.AC_UNIT: {
        Q.alb = 0.3; ramp = R.metal;
        if (face === 1) {
          const u = H.v - prims[o + 6], w = H.w - (prims[o + 4] - prims[o + 3]) * 0.5;
          const r = Math.sqrt(u * u + w * w);
          if (r < 0.2) {
            if (r > 0.17) { Q.alb = 0.45; gOv = G('O'); }
            else { Q.alb = 0.35; gOv = G('|/-\\'[Math.floor(time * 12 + (seed | 0)) & 3]); }
          } else if ((H.w * 14) % 1 < 0.5) { Q.alb = 0.2; gOv = G('='); }
        }
        break;
      }
      case M.TANK:
        Q.alb = 0.26; ramp = R.wall;
        if (H.w % 1.0 < 0.08) { Q.alb = 0.45; gOv = G('='); }
        break;
      case M.AWNING: {
        const st = (H.u * 2) % 1 < 0.5;
        if (st) { tint = col; Q.alb = 0.5; } else Q.alb = 0.22;
        ramp = R.wall; if (face === 4) Q.alb *= 0.4;
        break;
      }
      case M.CABINET:
        Q.alb = 0.13; ramp = R.metal;
        if (face === 2 || face === 3) {
          if ((H.u * 2 + H.w * 2) % 1 < 0.14) { emit(col, 0.6); gOv = G('/'); }
        }
        break;
      case M.KIOSK:
        Q.alb = 0.24; ramp = R.metal;
        if (H.w > 0.9 && H.w < 1.0) { emit(2, 1.2); gOv = G('='); }
        break;
      case M.DOOR: doorMat(o, col); break;
      case M.HOVER:
        tint = col; Q.alb = 0.32; Q.spec = 1.0; Q.shin = 30; ramp = R.body;
        if (face === 4) Q.alb = 0.1;
        break;
      default: Q.alb = 0.3; ramp = R.def;
    }
  }

  function signMat(o, graffiti) {
    const face = H.face;
    const sg = W.signs[prims[o + 11] | 0];
    if (!sg || (face !== 2 && face !== 3)) { Q.alb = 0.18; ramp = R.metal; return; }
    const hx = prims[o + 5], z0 = prims[o + 3], z1 = prims[o + 4];
    let u = H.u / (2 * hx);
    if (face === 3) u = 1 - u;
    const v = 1 - H.w / (z1 - z0);
    const res = Font.sample(sg.text, sg.vertical, u, v, sg.scroll);
    const col = sg.colCur;
    if (graffiti) {
      Q.alb = 0.16; ramp = R.wall;
      if (res === 1) {
        const drip = hash2(Math.floor(u * 60), 3) < 0.08;
        tint = col; Q.alb = 0.38; gOv = LETTER[Font.lastChar];
        if (drip) gOv = G('|');
      }
      return;
    }
    let I = sg.cur;
    if (sg.anim === 'chase' && res === 1) {
      const ci = Font.lastIndex;
      I *= ci < sg.chase ? 1 : 0.1;
    }
    if (sg.broken >= 0 && res === 1 && Font.lastIndex === sg.broken) I *= sg.brokenOn;
    Q.alb = 0.08;
    // letters are painted with their own character when each font pixel spans
    // several screen cells, otherwise with solid blocks so they stay legible
    const px = sg.vertical ? (2 * hx) / 7 : (z1 - z0) / 9;
    if (res === 1) { emit(col, 1.8 * I); gOv = Q.lod < px * 0.34 ? LETTER[Font.lastChar] : G_HASH; ramp = R.glow; }
    else if (res === 2) { emit(col, 0.5 * I); gOv = G(sg.vertical ? '|' : '='); }
    else { emit(col, 0.05 * I); ramp = R.def; }
  }

  function billboard(o) {
    const face = H.face;
    const sg = W.signs[prims[o + 11] | 0];
    if (!sg || (face !== 2 && face !== 3)) { Q.alb = 0.18; ramp = R.metal; return; }
    const mode = prims[o + 12] | 0;
    const hx = prims[o + 5], z0 = prims[o + 3], z1 = prims[o + 4];
    let u = H.u / (2 * hx);
    if (face === 3) u = 1 - u;
    const v = 1 - H.w / (z1 - z0);
    const col = sg.colCur;
    const col2 = mode ? 6 : 2;
    Q.alb = 0.05; ramp = R.glow;
    if (u < 0.015 || u > 0.985 || v < 0.03 || v > 0.97) { emit(col, 0.7); gOv = G(v < 0.03 || v > 0.97 ? '=' : '|'); return; }
    // scanline flicker
    const scan = 0.85 + 0.15 * Math.sin(v * 90 - time * 12);
    if (v > 0.7) {
      const vv = (v - 0.7) / 0.27;
      const n = sg.text.length, cols = n * 6 + 1;
      const res = Font.sample(sg.text, false, u * 61 / cols, vv, sg.scroll);
      if (res === 1) { emit(col, 2.0 * scan); gOv = LETTER[Font.lastChar]; }
      else emit(col, 0.07);
      return;
    }
    const aspect = (2 * hx) / ((z1 - z0) * 0.7);
    const cx = (u - 0.5) * aspect * 2, cy = (v / 0.7 - 0.5) * 2;
    if (mode === 0) {
      // a giant watching eye
      const blink = Math.max(0, Math.sin(time * 0.9)) > 0.985 ? 0.08 : 1;
      const lid = Math.abs(cy) < 0.72 * blink * Math.cos(Math.min(1.5, Math.abs(cx) * 0.62));
      const lookX = Math.sin(time * 0.37) * 0.45, lookY = Math.sin(time * 0.53) * 0.15;
      const ex = cx - lookX, ey = cy - lookY;
      const r = Math.sqrt(ex * ex + ey * ey);
      if (lid) {
        if (r < 0.18) { Q.emM += 0.02; gOv = G(' '); }
        else if (r < 0.5) {
          const ring = Math.sin(r * 40 - time * 3);
          emit(col2, (0.8 + 0.6 * ring) * scan); gOv = G(ring > 0.3 ? '@' : ring > -0.3 ? 'O' : 'o');
        } else { Q.emM += 0.55 * scan; gOv = G(r < 0.56 ? '#' : ':'); }
      } else {
        const d = Math.abs(cx) + Math.abs(cy);
        const w = Math.sin(d * 10 - time * 2.5);
        if (w > 0.6) { emit(col, 0.5); gOv = G('/'); } else emit(col, 0.06);
      }
    } else {
      // pulsing logo + equaliser
      const d = Math.max(Math.abs(cx * 0.8), Math.abs(cy));
      const rot = Math.sin(d * 14 - time * 3);
      if (d < 0.8) {
        if (rot > 0.4) { emit(col, 1.3 * scan); gOv = G('#'); }
        else if (rot > -0.2) { emit(col2, 0.7 * scan); gOv = G('+'); }
        else emit(col, 0.05);
      } else {
        const bar = Math.floor(u * 24);
        const hgt = 0.5 + 0.5 * Math.sin(time * (2 + hash2(bar, 1) * 5) + bar);
        if ((1 - v / 0.7) < hgt * 0.35) { emit(col2, 1.1); gOv = G('|'); } else emit(col, 0.05);
      }
    }
  }

  function screenMat(o) {
    const face = H.face;
    Q.alb = 0.12; ramp = R.metal;
    if (face >= 4) return;
    const type = prims[o + 11] | 0, seed = prims[o + 15];
    const u = sideUV(o), v = 1 - H.w / (prims[o + 4] - prims[o + 3]);
    if (u < 0.05 || u > 0.95 || v < 0.07 || v > 0.93) { Q.alb = 0.1; return; }
    const su = (u - 0.05) / 0.9, sv = (v - 0.07) / 0.86;
    ramp = R.glow; Q.alb = 0.02;
    const t = time + seed * 0.37;
    switch (type) {
      case 1: { // TV: static + news ticker
        if (sv > 0.78) {
          const res = Font.sample('BREAKING - CITY GRID AT 99% - RAIN ALL WEEK - ', false, su * 41 / 277, (sv - 0.78) / 0.22, (time * 12) | 0);
          if (res === 1) { emit(3, 1.6); gOv = LETTER[Font.lastChar]; } else emit(8, 0.15);
        } else {
          const n = hash3(Math.floor(su * 30), Math.floor(sv * 20), (time * 15) | 0);
          Q.emM += 0.2 + 0.6 * n; gOv = NOISE[(n * NOISE.length) | 0];
        }
        break;
      }
      case 2: { // kiosk UI
        if (sv < 0.3) {
          const res = Font.sample('INFO', false, su, sv / 0.3, 0);
          if (res === 1) { emit(2, 1.6); gOv = LETTER[Font.lastChar]; } else emit(2, 0.1);
        } else {
          const line = Math.floor((sv - 0.3) * 10);
          const len = hash2(line, Math.floor(seed)) * 0.9;
          if (su < len && hash2(Math.floor(su * 20), line) > 0.3) { emit(2, 0.9); gOv = G('-'); }
          else if (line === ((time * 2) | 0) % 7 && su < 0.08 && (time * 3 | 0) & 1) { emit(2, 1.5); gOv = G('_'); }
          else emit(2, 0.06);
        }
        break;
      }
      case 3: { // invaders
        const ox = Math.sin(t * 0.8) * 0.12, oy = ((t * 0.05) % 0.3);
        const gx = (su - 0.15 - ox) * 6, gy = (sv - 0.1 - oy) * 8;
        if (gx >= 0 && gx < 4.5 && gy >= 0 && gy < 3 && (gx % 1) < 0.7 && (gy % 1) < 0.6) { emit(5, 1.5); gOv = G((t * 2 | 0) & 1 ? 'M' : 'W'); }
        else if (sv > 0.88 && Math.abs(su - 0.5 - Math.sin(t) * 0.3) < 0.06) { emit(2, 1.5); gOv = G('^'); }
        else if (Math.abs(su - 0.5 - Math.sin(t - 0.4) * 0.3) < 0.015 && Math.abs(sv - (0.9 - (t * 1.5 % 0.8))) < 0.03) { emit(7, 1.8); gOv = G('|'); }
        else emit(6, 0.04);
        break;
      }
      case 4: { // pong
        const bx = 0.5 + 0.42 * Math.sin(t * 1.7), by = 0.5 + 0.4 * Math.sin(t * 2.3);
        if (Math.abs(su - bx) < 0.04 && Math.abs(sv - by) < 0.06) { emit(7, 2); gOv = G('O'); }
        else if ((su < 0.06 && Math.abs(sv - by) < 0.15) || (su > 0.94 && Math.abs(sv - (0.5 + 0.35 * Math.sin(t * 2.3 - 0.3))) < 0.15)) { emit(7, 1.4); gOv = G('|'); }
        else if (Math.abs(su - 0.5) < 0.015 && (sv * 10 | 0) & 1) { emit(7, 0.7); gOv = G(':'); }
        else emit(2, 0.04);
        break;
      }
      case 5: { // falling blocks
        const gx = Math.floor(su * 8), gy = Math.floor(sv * 12);
        const fall = Math.floor(t * 3) % 12;
        const px = Math.floor(hash2(Math.floor(t * 3 / 12), 1) * 6);
        const filled = gy > 8 && hash2(gx, gy + Math.floor(t / 8)) < 0.7;
        const piece = (gy === fall || gy === fall - 1) && (gx === px || gx === px + 1);
        if (filled || piece) { emit([1, 2, 3, 5, 6][(gx + gy) % 5], 1.3); gOv = G((su * 16 | 0) & 1 ? ']' : '['); }
        else emit(8, 0.04);
        break;
      }
      case 6: { // racer
        const hor = 0.35;
        if (sv < hor) { emit(6, 0.12 + 0.2 * (1 - sv / hor)); gOv = sv > hor - 0.05 ? G('_') : -1; }
        else {
          const k = (sv - hor) / (1 - hor);
          const edgeL = 0.5 - k * 0.45, edgeR = 0.5 + k * 0.45;
          const stripe = ((1 / (k + 0.05)) * 2 + t * 6) % 2 < 1;
          if (Math.abs(su - edgeL) < 0.03) { emit(1, 1.4); gOv = G('/'); }
          else if (Math.abs(su - edgeR) < 0.03) { emit(1, 1.4); gOv = G('\\'); }
          else if (Math.abs(su - 0.5) < 0.012 && stripe) { emit(7, 1.2); gOv = G('|'); }
          else if (su > edgeL && su < edgeR) emit(0, 0.1);
          else emit(5, 0.08);
          if (k > 0.8 && Math.abs(su - 0.5 - Math.sin(t) * 0.15) < 0.06) { emit(3, 1.6); gOv = G('A'); }
        }
        break;
      }
      default: { // oscilloscope
        const w = 0.5 + 0.3 * Math.sin(su * 12 + t * 4) * Math.sin(t * 0.7);
        if (Math.abs(sv - w) < 0.05) { emit(5, 1.6); gOv = G('~'); }
        else if ((su * 10) % 1 < 0.05 || (sv * 8) % 1 < 0.06) { emit(5, 0.2); gOv = G('.'); }
        else emit(5, 0.03);
      }
    }
  }

  function vendingMat(o, col, A) {
    const face = H.face;
    const front = A === 1 ? face === 2 || face === 3 : face === 1;
    ramp = R.panel;
    if (!front) { tint = col; Q.alb = 0.32; Q.spec = 0.4; return; }
    const across = A === 1 ? H.u : H.v, hgt = H.w;
    const width = A === 1 ? 2 * prims[o + 5] : 2 * prims[o + 6];
    const zh = prims[o + 4] - prims[o + 3];
    Q.alb = 0.05; ramp = R.glow;
    if (A === 1) {
      // bar shelf with glowing bottles
      const row = Math.floor(hgt / 0.33), fu = across * 7 - Math.floor(across * 7);
      if ((hgt % 0.33) < 0.04) { Q.alb = 0.3; gOv = G('_'); }
      else if (fu > 0.3 && fu < 0.7 && (hgt % 0.33) < 0.25) { emit([3, 1, 5, 2][(Math.floor(across * 7) + row) & 3], 0.9); gOv = G('8'); }
      return;
    }
    if (hgt > zh - 0.22) { emit(col, 1.5); gOv = G('='); return; }
    if (hgt > 0.95 && hgt < zh - 0.28 && across > 0.08 && across < width * 0.74) {
      const gx = (across - 0.08) / (width * 0.66) * 5, gy = (hgt - 0.95) / (zh - 1.23) * 4;
      const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
      if (fx > 0.18 && fx < 0.82 && fy > 0.12 && fy < 0.78) {
        const p = hash2(Math.floor(gx) + (prims[o + 15] | 0), Math.floor(gy));
        emit([1, 2, 3, 5, 9, 7][(p * 6) | 0], 1.1); gOv = G(p < 0.3 ? 'o' : p < 0.6 ? '0' : '8');
      } else emit(0, 0.25);
      return;
    }
    if (across >= width * 0.78 && across < width * 0.93 && hgt > 0.9 && hgt < 1.5) {
      if ((hgt * 12) % 1 < 0.5) { emit(col, 1.3); gOv = G('*'); }
      return;
    }
    if (hgt > 0.22 && hgt < 0.5 && across > 0.15 && across < width * 0.7) { Q.alb = 0.02; gOv = G('_'); return; }
    tint = col; Q.alb = 0.3;
  }

  function signalMat(o, axis) {
    Q.alb = 0.1; ramp = R.metal;
    if (H.face !== 1) return;
    const st = env.signal[axis];
    const across = H.v, hgt = H.w;
    for (let k = 0; k < 3; k++) {
      const cz = 1.0 - k * 0.4;
      const ddx = across - 0.2, ddz = hgt - cz;
      if (ddx * ddx + ddz * ddz < 0.022) {
        const on = (k === 0 && st === 2) || (k === 1 && st === 1) || (k === 2 && st === 0);
        const c = k === 0 ? 4 : k === 1 ? 3 : 5;
        if (on) { emit(c, 2.6); gOv = G('@'); } else { emit(c, 0.06); gOv = G('o'); }
        ramp = R.glow;
        return;
      }
    }
  }

  function doorMat(o, col) {
    const face = H.face;
    ramp = R.panel; Q.alb = 0.28;
    if (face !== 2 && face !== 3) { Q.alb = 0.3; return; }
    const u = H.u, w = H.w;
    const enterable = prims[o + 11] === 1;
    if (u < 0.05 || u > 0.93 || w > 2.5) { Q.alb = 0.45; ramp = R.metal; return; }
    if (u > 0.78 && u < 0.86 && w > 1.0 && w < 1.35) { emit(col, 1.9); gOv = G('|'); ramp = R.glow; return; }
    if (enterable && u > 0.2 && u < 0.68 && w > 1.25 && w < 2.1) { Q.alb = 0.04; Q.emM += 0.55; gOv = G('#'); ramp = R.window; return; }
    if ((w * 3.3) % 1 < 0.12) { Q.alb = 0.16; gOv = G('-'); }
  }

  return { init, beginFrame, shade, stats };
})();
