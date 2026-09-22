// ============================================================================
// ai.js — behaviour: traffic, pedestrians, hover cars, doors, animated signs
// ----------------------------------------------------------------------------
// Runs on a fixed time step (deterministic for a given seed + input stream).
//
// Cars      : lane following with an Intelligent-Driver-Model longitudinal
//             controller. Leaders are other cars in the lane, the stop line
//             when the signal is red/yellow, and anything (player, walkers)
//             standing in the car's path. At the intersection some cars take
//             a right turn along a quarter-circle arc into the crossing lane.
// Walkers   : follow a navigation graph (sidewalk ring, crosswalks, alleys,
//             doors, vending machines). They keep right, separate from each
//             other, sidestep the player, wait for the WALK signal, sometimes
//             stop at machines or disappear through doors for a while.
// Hover cars: fly straight along sky lanes above the streets.
// ============================================================================
AC.AI = (function () {
  'use strict';
  const { wrap, wrapDelta, hash1 } = AC.util;
  const LT = AC.World.L;

  // ---------------------------------------------------------------- traffic
  function aheadDist(L, from, to, S) {
    let d = ((to - from) * L.dir) % S;
    if (d < 0) d += S;
    return d;
  }

  function obstacleAhead(car, x, y, range, halfW, S) {
    const hx = Math.cos(car.yaw), hy = Math.sin(car.yaw);
    const dx = wrapDelta(x - car.x, S), dy = wrapDelta(y - car.y, S);
    const along = dx * hx + dy * hy;
    if (along <= 0 || along > range) return 1e9;
    const lat = Math.abs(-dx * hy + dy * hx);
    return lat < halfW ? along : 1e9;
  }

  function updateCars(E, env, player, dt) {
    const W = E.W, S = E.S, lanes = W.lanes, cars = E.cars, r = E.rng;
    for (const car of cars) {
      // obstacles in the car's path (player, pedestrians)
      let obst = obstacleAhead(car, player.x, player.y, 13, 1.5, S);
      for (const p of E.peds) {
        if (!p.visible) continue;
        const d = obstacleAhead(car, p.x, p.y, 11, 1.45, S);
        if (d < obst) obst = d;
      }
      const obstGap = obst - car.len - 0.9;
      if (obst < 8 && player && obstacleAhead(car, player.x, player.y, 8, 1.5, S) < 8) car.honk += dt; else car.honk = 0;

      if (car.turn) {
        let v0 = 5.5;
        let gap = obstGap;
        const acc = idm(car.v, v0, gap, 0);
        car.v = Math.max(0, car.v + acc * dt);
        car.theta += (car.v * dt) / car.turn.R;
        if (car.theta >= Math.PI / 2) {
          car.lane = car.turn.to;
          car.s = car.turn.endS;
          car.turn = null; car.theta = 0;
          car.wantTurn = r.chance(0.3);
        }
        car.brake = acc < -1 ? 1 : Math.max(0, car.brake - dt * 3);
        car.blink = car.turn ? 1 : 0;
        E.placeCar(car);
        continue;
      }
      const L = lanes[car.lane];
      let gap = 1e9, vLead = 0;
      for (const o of cars) {
        if (o === car) continue;
        let d = 1e9;
        if (!o.turn && o.lane === car.lane) d = aheadDist(L, car.s, o.s, S) - car.len - o.len;
        else if (o.turn && o.turn.to === car.lane && o.theta > 0.4) d = aheadDist(L, car.s, o.turn.endS, S) - car.len - o.len;
        else if (o.turn && o.lane === car.lane) d = aheadDist(L, car.s, L.turn.start, S) - car.len - o.len;
        if (d < gap && d > -car.len * 2) { gap = d; vLead = o.v; }
      }
      // traffic signal
      const st = env.signal[L.sig];
      if (st !== 0) {
        const dStop = aheadDist(L, car.s, L.stop, S);
        if (dStop < 45 && dStop > -0.5) {
          const canStop = st === 2 || dStop > (car.v * car.v) / (2 * 4.0) + 1.5;
          if (canStop && dStop < gap) { gap = dStop; vLead = 0; }
        }
      }
      if (obstGap < gap) { gap = obstGap; vLead = 0; }
      const acc = idm(car.v, car.v0, gap, car.v - vLead);
      car.v = Math.max(0, car.v + acc * dt);
      car.brake = acc < -1 ? 1 : Math.max(0, car.brake - dt * 3);
      const prev = car.s, moved = car.v * dt;
      car.s = wrap(car.s + L.dir * moved, S);
      // start a right turn when crossing the turn point
      if (car.wantTurn && aheadDist(L, prev, L.turn.start, S) <= moved) {
        if (laneClear(E, L.turn.to, L.turn.endS)) {
          const T = L.turn;
          const sx = L.axis === 1 ? L.c : T.start, sy = L.axis === 1 ? T.start : L.c;
          car.turn = { R: 3.5, cx: T.cx, cy: T.cy, phi0: Math.atan2(sy - T.cy, sx - T.cx), to: T.to, endS: T.endS };
          car.theta = 0;
        } else car.wantTurn = false;
      }
      // decide the next turn well before the intersection
      if (aheadDist(L, prev, 45, S) <= moved) car.wantTurn = r.chance(0.35);
      car.blink = car.wantTurn && aheadDist(L, car.s, L.turn.start, S) < 30 ? 1 : 0;
      E.placeCar(car);
    }
  }

  function idm(v, v0, gap, dv) {
    const a = 2.0, b = 3.2, s0 = 1.6, T = 1.1;
    const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
    const g = Math.max(gap, 0.05);
    const acc = a * (1 - Math.pow(v / v0, 4) - (sStar / g) * (sStar / g));
    return Math.max(-9, acc);
  }

  function laneClear(E, lane, s) {
    const L = E.W.lanes[lane];
    for (const o of E.cars) {
      if (o.turn || o.lane !== lane) continue;
      const d = aheadDist(L, o.s, s, E.S); // how far behind the merge point o is
      if (d < 12 || d > E.S - 7) return false;
    }
    return true;
  }

  // ------------------------------------------------------------- hover cars
  function updateHovers(E, dt, t) {
    const S = E.S;
    for (const h of E.hovers) {
      const L = E.W.skyLanes[h.lane];
      h.s = wrap(h.s + L.dir * h.v * dt, S);
      if (L.axis === 1) { h.x = L.c + Math.sin(t * 0.3 + h.seed) * 0.6; h.y = h.s; h.yaw = L.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
      else { h.x = h.s; h.y = L.c + Math.sin(t * 0.3 + h.seed) * 0.6; h.yaw = L.dir > 0 ? 0 : Math.PI; }
      h.z = L.z + Math.sin(t * 0.8 + h.seed) * 0.5;
    }
  }

  // ------------------------------------------------------------ pedestrians
  function updatePeds(E, env, player, dt) {
    const W = E.W, S = E.S, nav = W.nav, N = nav.nodes, peds = E.peds, r = E.rng;
    for (const p of peds) {
      if (p.state === 'inside') {
        p.timer -= dt;
        if (p.timer <= 0) {
          const dn = N[p.node];
          p.visible = true; p.x = dn.x; p.y = dn.y;
          const back = dn.adj[0];
          p.prev = p.node; p.target = back.to; p.edgeType = 'door'; p.state = 'walk';
          openDoorFor(W, dn.door);
        }
        continue;
      }
      if (p.state === 'idle') {
        p.timer -= dt; p.speed *= 0.8;
        if (p.timer <= 0) pickNext(p, N, r);
        continue;
      }
      if (p.state === 'wait') {
        p.speed *= 0.8;
        const tn = N[p.target];
        p.yaw = Math.atan2(wrapDelta(tn.y - p.y, S), wrapDelta(tn.x - p.x, S));
        if (env.pedWalk[p.crossRoad]) { p.state = 'walk'; }
        continue;
      }
      // --- walking
      const tn = N[p.target], fn = N[p.node];
      let ex = wrapDelta(tn.x - fn.x, S), ey = wrapDelta(tn.y - fn.y, S);
      const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
      const off = p.edgeType === 'walk' || p.edgeType === 'cross' ? p.off : p.edgeType === 'alley' ? p.off * 0.5 : 0;
      const tx = tn.x + ey * off, ty = tn.y - ex * off;   // keep right
      const dx = wrapDelta(tx - p.x, S), dy = wrapDelta(ty - p.y, S);
      const d = Math.hypot(dx, dy);
      if (d < 0.4) { arrive(E, p, p.target, N, r); continue; }
      let wx = (dx / d) * p.vmax, wy = (dy / d) * p.vmax;
      // separation from other walkers
      for (const q of peds) {
        if (q === p || !q.visible) continue;
        const sx = wrapDelta(p.x - q.x, S), sy = wrapDelta(p.y - q.y, S);
        const s2 = sx * sx + sy * sy;
        if (s2 < 0.81 && s2 > 1e-6) { const s = Math.sqrt(s2), k = (0.9 - s) / s * 2.2; wx += sx * k; wy += sy * k; }
      }
      // sidestep the player
      if (player) {
        const sx = wrapDelta(p.x - player.x, S), sy = wrapDelta(p.y - player.y, S);
        const s2 = sx * sx + sy * sy;
        if (s2 < 2.2 && s2 > 1e-6) {
          const s = Math.sqrt(s2), k = (1.5 - s) / s * 1.8;
          wx += sx * k + (-dy / d) * 0.6; wy += sy * k + (dx / d) * 0.6;
        }
      }
      const kk = Math.min(1, dt * 5);
      p.vx += (wx - p.vx) * kk; p.vy += (wy - p.vy) * kk;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > p.vmax * 1.3) { p.vx *= p.vmax * 1.3 / sp; p.vy *= p.vmax * 1.3 / sp; }
      const pos = { x: p.x + p.vx * dt, y: p.y + p.vy * dt };
      AC.Physics.collide(pos, 0.24, 0.15, null, true);
      p.x = wrap(pos.x, S); p.y = wrap(pos.y, S);
      p.speed = Math.hypot(p.vx, p.vy);
      if (p.speed > 0.1) {
        const ty2 = Math.atan2(p.vy, p.vx);
        let da = ty2 - p.yaw; da = Math.atan2(Math.sin(da), Math.cos(da));
        p.yaw += da * Math.min(1, dt * 8);
      }
      p.phase += p.speed * dt * 4.6;
      // doors open for walkers stepping through them
      if (p.edgeType === 'door') {
        const dn = N[p.target].type === 'doorway' ? N[p.target] : N[p.node];
        if (dn.door !== undefined && d < 2.5) openDoorFor(W, dn.door);
      }
    }
  }

  function openDoorFor(W, id) {
    const dr = W.doors[id];
    if (!dr) return;
    dr.target = 1; dr.hold = Math.max(dr.hold || 0, 1.6);
  }

  function arrive(E, p, n, N, r) {
    p.prev = p.node; p.node = n;
    const node = N[n];
    if (node.type === 'doorway') {
      p.state = 'inside'; p.visible = false; p.timer = r.range(6, 28);
      openDoorFor(E.W, node.door);
      return;
    }
    if (node.type === 'vending' && r.chance(0.4)) {
      p.state = 'idle'; p.timer = r.range(2.5, 6);
      if (node.face) p.yaw = Math.atan2(node.face.y, node.face.x);
      p._idleNode = true;
      return;
    }
    if ((node.type === 'walk' || node.type === 'corner') && r.chance(0.04)) {
      p.state = 'idle'; p.timer = r.range(2, 5); p._idleNode = true; return;
    }
    pickNext(p, N, r);
  }

  function pickNext(p, N, r) {
    const node = N[p.node];
    const opts = node.adj.filter((a) => a.to !== p.prev);
    const list = opts.length ? opts : node.adj;
    let total = 0;
    const wts = list.map((a) => { const w = a.e.type === 'walk' ? 1 : a.e.type === 'cross' ? 1.1 : a.e.type === 'alley' ? 0.4 : 0.22; total += w; return w; });
    let x = r.next() * total, pick = list[0];
    for (let k = 0; k < list.length; k++) { x -= wts[k]; if (x <= 0) { pick = list[k]; break; } }
    p.target = pick.to; p.edgeType = pick.e.type;
    if (pick.e.type === 'cross') { p.state = 'wait'; p.crossRoad = pick.e.road; }
    else p.state = 'walk';
  }

  // ------------------------------------------------------------------ NPCs
  function updateNpcs(E, dt, t) {
    for (const n of E.npcs) {
      if (n.anim === 'cook') {
        const side = Math.sin(t * 0.35 + n.phase) * 1.1;
        const px = Math.cos(n.yaw + Math.PI / 2), py = Math.sin(n.yaw + Math.PI / 2);
        const nx = n.bx + px * side, ny = n.by + py * side;
        const moving = Math.abs(Math.cos(t * 0.35 + n.phase)) > 0.25;
        n.stride = moving ? 0.6 : 0.1;
        n.phase += dt * (moving ? 3 : 1);
        n.x = nx; n.y = ny;
      } else if (n.anim === 'play') {
        n.stride = 0.15; n.phase += dt * 6;
      } else {
        n.stride = 0.1; n.phase += dt * 2.2;
      }
    }
  }

  // ----------------------------------------------------------------- doors
  function updateDoors(W, player, dt) {
    for (const d of W.doors) {
      if (d.hold > 0) { d.hold -= dt; if (d.hold <= 0 && !d.playerOpen) d.target = 0; }
      if (d.playerOpen) {
        const dx = wrapDelta(player.x - (d.cx + 0.5), W.S), dy = wrapDelta(player.y - (d.cy + 0.5), W.S);
        if (dx * dx + dy * dy > 16) { d.away = (d.away || 0) + dt; if (d.away > 5) { d.playerOpen = false; d.target = 0; } }
        else d.away = 0;
      }
      const sp = 2.2 * dt;
      if (d.open < d.target) d.open = Math.min(d.target, d.open + sp);
      else if (d.open > d.target) {
        // don't close on the player
        const dx = wrapDelta(player.x - (d.cx + 0.5), W.S), dy = wrapDelta(player.y - (d.cy + 0.5), W.S);
        if (dx * dx + dy * dy > 0.8) d.open = Math.max(d.target, d.open - sp);
      }
    }
  }

  // ---------------------------------------------------- animated signs/lights
  function animate(W, env, t) {
    for (const sg of W.signs) {
      const ph = sg.phase;
      switch (sg.anim) {
        case 'flicker': {
          const bad = hash1(Math.floor(t * 0.45 + ph)) < 0.35;
          sg.cur = bad && hash1(Math.floor(t * 17 + ph * 7)) < 0.45 ? 0.07 : 1;
          sg.broken = Math.floor(ph * 7) % sg.text.length;
          sg.brokenOn = hash1(Math.floor(t * 9 + ph * 3)) < 0.5 ? 0.08 : 1;
          break;
        }
        case 'blink': sg.cur = Math.floor(t * sg.speed * 1.1 + ph) & 1 ? 1 : 0.1; break;
        case 'pulse': sg.cur = 0.55 + 0.45 * Math.sin(t * sg.speed * 2.2 + ph); break;
        case 'chase': {
          const n = sg.text.length;
          const c = (t * sg.speed * 3 + ph) % (n + 6);
          sg.chase = c;
          sg.cur = c > n + 2 ? ((c * 4) | 0) & 1 ? 1 : 0.15 : 1;
          break;
        }
        case 'cycle': sg.colCur = [1, 2, 6, 3][Math.floor(t * 0.5 * sg.speed + ph) & 3]; sg.cur = 1; break;
        case 'billboard': sg.scroll = Math.floor(t * sg.speed * 9 + ph); sg.cur = 1; break;
        default: sg.cur = 0.95 + 0.05 * Math.sin(t * 47 + ph);
      }
    }
    // lights follow their sources
    const n = W.nLights, cur = W.lcur, base = W.lbase, anim = W.lanim, prm = W.lparam, mono = W.lmono;
    for (let k = 0; k < n; k++) {
      const b = base[k];
      switch (anim[k]) {
        case LT.STEADY: cur[k] = b; break;
        case LT.FLICKER: {
          const p = prm[k];
          const bad = hash1(Math.floor(t * 0.35 + p)) < 0.45;
          const f = bad && hash1(Math.floor(t * 16 + p * 3)) < 0.5 ? 0.04 : 1;
          cur[k] = b * f * (mono[k] ? env.lampLevel : 1);
          break;
        }
        case LT.SIGN: { const sg = W.signs[prm[k]]; cur[k] = b * (sg ? sg.cur : 1); if (sg && sg.anim === 'cycle') { const c = AC.ACCENT[sg.colCur]; W.lr[k] = c[0]; W.lg[k] = c[1]; W.lb[k] = c[2]; } break; }
        case LT.SIGNAL: {
          const s = env.signal[prm[k] | 0];
          if (s === 0) { W.lr[k] = 0.2; W.lg[k] = 1; W.lb[k] = 0.3; }
          else if (s === 1) { W.lr[k] = 1; W.lg[k] = 0.7; W.lb[k] = 0.1; }
          else { W.lr[k] = 1; W.lg[k] = 0.1; W.lb[k] = 0.08; }
          cur[k] = b;
          break;
        }
        case LT.PULSE: cur[k] = b * (0.8 + 0.2 * Math.sin(t * 2 + prm[k])); break;
        case LT.LAMP: {
          // lamps switch on one by one at dusk
          const on = env.lampLevel > hash1(prm[k] | 0) * 0.85 + 0.05;
          cur[k] = on ? b : 0;
          break;
        }
        default: cur[k] = b;
      }
    }
  }

  function step(E, env, player, dt, t) {
    AC.Environment.signals(env, t);   // signal phase is part of the fixed-step simulation
    updateCars(E, env, player, dt);
    updateHovers(E, dt, t);
    updatePeds(E, env, player, dt);
    updateNpcs(E, dt, t);
    updateDoors(E.W, player, dt);
  }

  return { step, animate, openDoorFor };
})();
