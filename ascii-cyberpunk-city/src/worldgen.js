// ============================================================================
// worldgen.js — deterministic procedural generation of the city tile
// ----------------------------------------------------------------------------
// Layout of one S x S tile (the world wraps around, so the tile repeats):
//
//   x: 0..16  N-S street  (3m sidewalk | 2m park | 3m lane v | 3m lane ^ | 2m park | 3m sidewalk)
//   y: 0..16  E-W street  (same cross-section, rotated)
//   [16..80]^2  one city block, subdivided into lots by alleys
//
// Because the tile wraps, the block is surrounded by sidewalks on all four
// sides and the two streets cross at a single intersection, but walking in
// any direction feels like an endless city.
//
// Every building, prop, sign and light is generated from a seeded RNG, so the
// same seed always yields the same city. All geometry is emitted as data
// (cell spans + primitive objects), never as drawing code.
// ============================================================================
AC.WorldGen = (function () {
  'use strict';
  const { RNG } = AC.util;
  const M = AC.MAT, World = AC.World, F = World.F, LT = World.L;
  const Models = AC.Models;

  const S = 80;         // tile size in metres (= cells)
  const ST = 16;        // street corridor width
  const R0 = 3, R1 = 13; // road extent inside the corridor
  const SIDE_Y = 0.15;  // sidewalk height
  const INT_Z = 0.17;   // interior floor height
  const CEIL_Z = 3.8;   // interior ceiling height
  const DOOR_H = 2.6;

  const SIGN_WORDS = ['HOTEL', 'BAR', 'CLINIC', 'PAWN', '24H', 'SUSHI', 'CYBER', 'DATA', 'KARAOKE', 'TATTOO',
    'OPEN', 'LIQUOR', 'IMPLANTS', 'REPAIR', 'NET CAFE', 'LOVE', 'MOTEL', 'DOJO', 'LOANS', 'SAKE', 'CLUB',
    'NOODLE', 'ROBOTS', 'PHARMACY', 'MASSAGE', 'BIOLAB', 'SYNTH', 'VOID', 'HOLO', 'RAMEN', 'KAIJU', 'GENE'];
  const BLADE_WORDS = ['HOTEL', 'BAR', 'OPEN', 'CLUB', 'SAKE', 'NEON', 'ROBO', 'LOVE', '24H', 'VOID', 'GENE', 'DRINK', 'CHIPS'];
  const BILLBOARD_TEXT = ['DRINK SYNTH-COLA', 'NEUROLINK 9 - THINK FASTER', 'YOU ARE BEING WATCHED', 'ARASAKA-FREE ZONE', 'BUY MORE LIVE MORE', 'KABUKI-7 NEVER SLEEPS'];
  const BUILDING_NAMES = ['KANJI TOWER', 'OMNI HAB 7', 'SPRAWL BLOCK C', 'NEXUS ARCOLOGY', 'LOTUS HOUSING', 'FERRO TOWER', 'MIRAI PLAZA', 'CHROME HEIGHTS', 'DELTA STACK', 'ORBITAL HOUSE'];
  const ACCENTS = [1, 2, 3, 6, 1, 2, 4, 5, 9];

  function generate(seed) {
    const W = new World(S);
    W.seed = seed;
    W.tile = { S, ST, R0, R1 };
    const rng = new RNG(seed);

    layoutStreets(W);
    const plan = subdivide(rng.fork(1));
    W.alleys = { ax: plan.ax, ay: plan.ay };
    const blds = plan.lots.map((lot, i) => makeBuilding(W, rng.fork(100 + i), lot, i));
    W.buildings = blds;

    // choose the enterable buildings: one facing the N-S street (west face),
    // one facing the E-W street (south face)
    const west = blds.filter((b) => b.x0 === ST).sort((a, b) => a.y0 - b.y0);
    const noodle = west[0];
    const south = blds.filter((b) => b.y0 === ST && b !== noodle).sort((a, b) => a.x0 - b.x0);
    const arcade = south[0] || blds.find((b) => b !== noodle);

    const signRng = rng.fork(5);
    for (const b of blds) {
      b.faces = streetFaces(b);
      if (b === noodle) makeShop(W, b, faceById(b, 'W'), 'noodle', signRng);
      else if (b === arcade) makeShop(W, b, b.faces.find((f) => f.id === 'S') || b.faces[0], 'arcade', signRng);
      else if (b.faces.length) lockedDoor(W, b, b.faces[Math.floor(signRng.next() * b.faces.length)], signRng);
    }
    for (const b of blds) decorateFacades(W, b, signRng);
    billboards(W, blds, rng.fork(9));
    rooftops(W, blds, rng.fork(11));
    streetProps(W, rng.fork(13));
    alleyProps(W, rng.fork(17), plan);
    buildNav(W, plan);
    buildLanes(W);

    // spawn on the far sidewalk, across the avenue from the noodle bar, looking
    // at its neon front; pick the first candidate with clearance from props
    const nd = W.doors.find((d) => d.kind === 'noodle');
    const tx = nd.cx + 0.5, ty = nd.cy + 0.5;
    const clear = (x, y) => W.colliders.every((c) => Math.hypot(c.x - x, c.y - y) > (c.t === 'c' ? c.r : Math.hypot(c.hx, c.hy)) + 1.0);
    const cands = [[1.4, ty + 6.5], [1.4, ty + 5], [1.4, ty + 8], [1.4, ty + 3.5], [1.4, ty + 9.5], [1.4, ty + 11]];
    const [sx, sy] = cands.find(([x, y]) => clear(x, y)) || cands[0];
    W.spawn = { x: sx, y: sy, yaw: Math.atan2(ty - sy, tx - sx) };

    W.finalizeStatic();
    return W;
  }

  // ------------------------------------------------------------------ streets
  function layoutStreets(W) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const ci = y * S + x;
      const inNS = x < ST, inEW = y < ST;
      if (inNS || inEW) {
        const road = (inNS && x >= R0 && x < R1) || (inEW && y >= R0 && y < R1);
        if (road) { W.floorH[ci] = 0; W.floorMat[ci] = M.ASPHALT; W.flags[ci] = F.ROAD; }
        else { W.floorH[ci] = SIDE_Y; W.floorMat[ci] = M.SIDEWALK; W.sideMat[ci] = M.CURB; W.flags[ci] = F.SIDEWALK; }
      } else {
        W.floorH[ci] = SIDE_Y; W.floorMat[ci] = M.ALLEY; W.sideMat[ci] = M.CURB; W.flags[ci] = F.ALLEY;
      }
    }
  }

  // ------------------------------------------------------------------- lots
  function subdivide(r) {
    const x0 = ST, y0 = ST, x1 = S, y1 = S;
    const ax = x0 + r.int(27, 31), ay = y0 + r.int(27, 31);
    const quads = [[x0, y0, ax, ay], [ax + 3, y0, x1, ay], [x0, ay + 3, ax, y1], [ax + 3, ay + 3, x1, y1]];
    const lots = [];
    const subAlleys = [];
    quads.forEach((q, qi) => {
      const w = q[2] - q[0], h = q[3] - q[1];
      if (qi === 0 || r.chance(0.6)) {
        const gap = qi === 0 ? 0 : r.chance(0.5) ? 0 : 2;
        if (qi === 0 ? true : w >= h) {
          // split along y (south lot / north lot) for the SW quad so both halves face the west street
          if (qi === 0) {
            const m = q[1] + Math.round(h * r.range(0.42, 0.55));
            lots.push([q[0], q[1], q[2], m], [q[0], m + gap, q[2], q[3]]);
            if (gap) subAlleys.push([q[0], m, q[2], m + gap]);
          } else {
            const m = q[0] + Math.round(w * r.range(0.4, 0.6));
            lots.push([q[0], q[1], m, q[3]], [m + gap, q[1], q[2], q[3]]);
            if (gap) subAlleys.push([m, q[1], m + gap, q[3]]);
          }
        } else {
          const m = q[1] + Math.round(h * r.range(0.4, 0.6));
          lots.push([q[0], q[1], q[2], m], [q[0], m + gap, q[2], q[3]]);
          if (gap) subAlleys.push([q[0], m, q[2], m + gap]);
        }
      } else lots.push(q);
    });
    return { lots, ax, ay, subAlleys };
  }

  // -------------------------------------------------------------- buildings
  const STYLES = [M.CONCRETE, M.PANEL, M.BRICK, M.GLASSWALL, M.INDUSTRIAL];
  function makeBuilding(W, r, lot, id) {
    const [x0, y0, x1, y1] = lot;
    const w = x1 - x0, d = y1 - y0;
    const style = STYLES[r.int(0, STYLES.length - 1)];
    let h = Math.round(r.range(15, 44));
    const b = {
      id, x0, y0, x1, y1, h, style, seed: r.int(1, 1 << 30),
      name: BUILDING_NAMES[id % BUILDING_NAMES.length],
      floorH: r.range(3.1, 3.7), groundH: 4.2,
      winSp: r.range(1.7, 3.0), winFrac: r.range(0.42, 0.72),
      winV0: r.range(0.22, 0.32), winV1: r.range(0.78, 0.88),
      lit: r.range(0.12, 0.38), accentWin: r.chance(0.45) ? r.range(0.04, 0.15) : 0,
      winAccent: ACCENTS[r.int(0, ACCENTS.length - 1)],
      shade: r.range(0.75, 1.15), tower: null, enterable: false, faces: [],
    };
    if (style === M.GLASSWALL) { b.winSp = r.range(1.3, 1.8); b.winFrac = 0.9; h += 10; }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const ci = y * S + x;
      W.spanLo[ci] = 0; W.spanHi[ci] = h; W.wallMat[ci] = style; W.flags[ci] = F.BUILDING; W.bld[ci] = id;
      W.floorH[ci] = SIDE_Y; W.floorMat[ci] = M.SIDEWALK; W.sideMat[ci] = M.CURB;
    }
    // podium + tower setback for big lots, stepped block otherwise
    if (w >= 15 && d >= 15 && r.chance(0.75)) {
      const inset = r.int(3, 5);
      const th = Math.round(r.range(44, 70));
      b.tower = { x0: x0 + inset, y0: y0 + inset, x1: x1 - inset, y1: y1 - inset, h: th };
      h = Math.min(h, Math.round(r.range(10, 18)));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const inT = x >= b.tower.x0 && x < b.tower.x1 && y >= b.tower.y0 && y < b.tower.y1;
        W.spanHi[y * S + x] = inT ? th : h;
      }
      b.h = h;
    } else if (r.chance(0.5)) {
      const sx0 = x0 + r.int(0, Math.max(0, w - 6)), sy0 = y0 + r.int(0, Math.max(0, d - 6));
      const sx1 = Math.min(x1, sx0 + r.int(5, Math.max(5, w))), sy1 = Math.min(y1, sy0 + r.int(5, Math.max(5, d)));
      const extra = Math.round(r.range(6, 16));
      b.step = { x0: sx0, y0: sy0, x1: sx1, y1: sy1, h: h + extra };
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) W.spanHi[y * S + x] = h + extra;
    }
    return b;
  }

  // Street faces of a building: outward normal, the tangent along the face,
  // the facade line coordinate and the extent along it.
  function streetFaces(b) {
    const f = [];
    if (b.x0 === ST) f.push({ id: 'W', nx: -1, ny: 0, line: b.x0, a0: b.y0, a1: b.y1 });
    if (b.y0 === ST) f.push({ id: 'S', nx: 0, ny: -1, line: b.y0, a0: b.x0, a1: b.x1 });
    if (b.x1 === S) f.push({ id: 'E', nx: 1, ny: 0, line: b.x1, a0: b.y0, a1: b.y1 });
    if (b.y1 === S) f.push({ id: 'N', nx: 0, ny: 1, line: b.y1, a0: b.x0, a1: b.x1 });
    return f;
  }
  function faceById(b, id) { return b.faces.find((f) => f.id === id) || b.faces[0]; }

  // Cell (inside the building) on face f at along-coordinate a (integer)
  function faceCell(f, a) {
    if (f.nx === -1) return [f.line, a];
    if (f.nx === 1) return [f.line - 1, a];
    if (f.ny === -1) return [a, f.line];
    return [a, f.line - 1];
  }
  // world point on the facade plane at along a (float), offset outward by `out`
  function facePoint(f, a, out) {
    if (f.nx !== 0) return [f.line + f.nx * out, a];
    return [a, f.line + f.ny * out];
  }
  function faceYaw(f) { return Math.atan2(f.ny, f.nx); }         // outward
  function alongYaw(f) { return Math.atan2(f.nx !== 0 ? 1 : 0, f.nx !== 0 ? 0 : 1); } // +a direction

  // --------------------------------------------------------------- doors
  function addDoor(W, b, f, a, kind, locked) {
    const [cx, cy] = faceCell(f, a);
    const ci = cy * S + cx;
    W.spanLo[ci] = DOOR_H;
    W.floorH[ci] = INT_Z; W.floorMat[ci] = M.INT_FLOOR;
    W.flags[ci] = (W.flags[ci] | F.DOOR) & ~0;
    const tx = f.nx !== 0 ? 0 : 1, ty = f.nx !== 0 ? 1 : 0;
    // panel sits in the inner half of the doorway cell (a recessed entrance)
    const px = cx + 0.5 - f.nx * 0.32, py = cy + 0.5 - f.ny * 0.32;
    const d = {
      id: W.doors.length, kind, bld: b.id, cx, cy, nx: f.nx, ny: f.ny, tx, ty, px, py,
      yaw: Math.atan2(ty, tx), h: DOOR_H, open: 0, target: 0, locked, enterable: !locked,
      seed: b.seed + a, timer: 0,
      // point on the sidewalk just in front of the door
      fx: cx + 0.5 + f.nx * 1.3, fy: cy + 0.5 + f.ny * 1.3, a, face: f.id,
    };
    W.doors.push(d);
    W.interactables.push({ type: 'door', door: d, x: cx + 0.5 + f.nx * 0.5, y: cy + 0.5 + f.ny * 0.5 });
    // small light over the door
    const [lx, ly] = facePoint(f, a + 0.5, 0.4);
    W.addLight(lx, ly, 2.9, locked ? 1 : 0.3, locked ? 0.25 : 1, locked ? 0.2 : 0.4, 3.2, 0.55, LT.STEADY, 0, 0);
    return d;
  }

  function lockedDoor(W, b, f, r) {
    const a = Math.floor(f.a0 + 2 + r.next() * (f.a1 - f.a0 - 5));
    const d = addDoor(W, b, f, a, 'locked', true);
    b.door = d;
  }

  // ------------------------------------------------------------ shops / interiors
  function makeShop(W, b, f, kind, r) {
    b.enterable = true;
    b.shop = kind;
    const len = f.a1 - f.a0;
    const a = Math.floor(f.a0 + Math.min(len - 6, Math.max(5, len * 0.45)));
    const d = addDoor(W, b, f, a, kind, false);
    b.door = d;
    const inX = -f.nx, inY = -f.ny;           // into the building
    const tX = d.tx, tY = d.ty;               // along the face
    const depth = Math.min(10, (f.nx !== 0 ? b.x1 - b.x0 : b.y1 - b.y0) - 3);
    const aMin = Math.max(f.a0 + 1, a - 6), aMax = Math.min(f.a1 - 2, a + 6); // inclusive
    // carve the interior
    for (let k = 1; k <= depth; k++) for (let aa = aMin; aa <= aMax; aa++) {
      const cx = d.cx + inX * k + (f.nx !== 0 ? 0 : aa - a), cy = d.cy + inY * k + (f.nx !== 0 ? aa - a : 0);
      const ci = cy * S + cx;
      W.floorH[ci] = INT_Z; W.floorMat[ci] = kind === 'arcade' ? M.CARPET : M.INT_FLOOR;
      W.spanLo[ci] = CEIL_Z; W.flags[ci] = F.BUILDING | F.INTERIOR;
    }
    // glass shop front on both sides of the door (one solid pillar each side)
    for (const off of [-4, -3, -2, 2, 3, 4]) {
      const aa = a + off;
      if (aa < aMin || aa > aMax) continue;
      const [cx, cy] = faceCell(f, aa);
      const ci = cy * S + cx;
      W.floorH[ci] = 0.7; W.floorMat[ci] = M.SILL; W.sideMat[ci] = M.SILL;
      W.spanLo[ci] = 3.3; W.flags[ci] |= F.GLASS;
    }
    b.interior = { depth, aMin, aMax, kind };
    // local frame helper: along offset `u`, depth `v` (v=0 is the door cell centre)
    const P = (u, v) => [d.cx + 0.5 + tX * u + inX * v, d.cy + 0.5 + tY * u + inY * v];
    const yIn = Math.atan2(inY, inX), yAlong = Math.atan2(tY, tX);
    const u0 = aMin - a, u1 = aMax - a;         // along extent (cell centres)
    // ceiling lights on a 3 m grid (the CEILING material draws the panels)
    b.ceil = { ox: d.cx + 0.5, oy: d.cy + 0.5, sp: 3 };
    b.ceilLights = [];
    for (let v = 2; v <= depth - 0.5; v += 3) for (let u = Math.ceil(u0 / 3) * 3; u <= u1; u += 3) {
      const [lx, ly] = P(u, v);
      if (kind === 'arcade') {
        const ci = (u / 3 + v) & 1 ? 1 : 2, c = AC.ACCENT[ci];
        W.addLight(lx, ly, 3.5, c[0], c[1], c[2], 7, 0.8, LT.PULSE, u * 0.7 + v, 0);
        b.ceilLights.push([lx, ly, ci]);
      } else {
        W.addLight(lx, ly, 3.5, 1, 0.9, 0.75, 6.5, 0.62, LT.STEADY, 0, 1);
        b.ceilLights.push([lx, ly, 0]);
      }
    }
    // light spilling out through the door
    { const [lx, ly] = P(0, 1.2); W.addLight(lx, ly, 2.8, 1, 0.9, 0.8, 6, 0.6, LT.STEADY, 0, 1); }

    const back = depth + 0.5;                   // back wall plane (local v)
    if (kind === 'noodle') {
      // counter parallel to the back wall, stools on the customer side
      const cv = back - 2.4, cu0 = u0 + 1.2, cu1 = u1 - 0.8;
      const cu = (cu0 + cu1) / 2, chl = (cu1 - cu0) / 2;
      let [x, y] = P(cu, cv);
      W.beginObject();
      W.box(x, y, 0, 1.02, chl, 0.38, yAlong, M.COUNTER, 1, 0, 0);
      W.box(x, y, 1.02, 1.1, chl + 0.05, 0.46, yAlong, M.WOOD, 0);
      W.endObject(11);
      W.colliders.push({ t: 'b', x, y, hx: chl + 0.05, hy: 0.46, c: Math.cos(yAlong), s: Math.sin(yAlong), z1: 1.1 });
      for (let u = cu0 + 0.4; u <= cu1 - 0.3; u += 1.15) {
        [x, y] = P(u, cv - 0.95);
        W.beginObject();
        W.cyl(x, y, 0, 0.66, 0.05, M.POLE, 0);
        W.cyl(x, y, 0.66, 0.76, 0.21, M.STOOL, 4);
        W.endObject(11);
        W.colliders.push({ t: 'c', x, y, r: 0.22, z1: 0.76 });
      }
      // kitchen: stove + pot, shelves on the back wall
      [x, y] = P(cu + 1.5, back - 0.9);
      W.beginObject(); W.box(x, y, 0, 0.95, 0.9, 0.35, yAlong, M.METAL, 0); W.cyl(x, y, 0.95, 1.35, 0.28, M.METAL, 0, 1); W.endObject(11);
      W.emitters.push({ x, y, z: 1.4, rate: 14, kind: 'steam', spread: 0.25, life: 2.2, rise: 0.7 });
      [x, y] = P(cu - 2.2, back - 0.25);
      W.beginObject(); W.box(x, y, 1.3, 2.4, 1.6, 0.18, yAlong, M.VENDING, 3, 1, 0, b.seed); W.endObject(11);
      // big neon sign on the back wall + lanterns over the counter
      [x, y] = P(cu, back - 0.05);
      const si = addSign(W, 'RAMEN', 1, false, 'flicker', r);
      Models.sign(W, x, y, 2.55, 3.45, (5 * 6 + 1) * 0.1 / 2, 0.04, yAlong, si);
      for (let u = cu0 + 1; u <= cu1 - 0.5; u += 2.6) {
        [x, y] = P(u, cv);
        W.beginObject(); W.cyl(x, y, 2.95, CEIL_Z, 0.01, M.POLE, 0); W.sph(x, y, 2.75, 0.24, 0.3, M.LANTERN, 4, 0, 0, u * 7); W.endObject(12);
        W.addLight(x, y, 2.6, 1, 0.25, 0.12, 3.5, 0.6, LT.PULSE, u, 0);
      }
      // tables by the window
      for (const u of [u0 + 1.2, u1 - 1.0]) {
        [x, y] = P(u, 1.8);
        W.beginObject(); W.cyl(x, y, 0, 0.72, 0.06, M.POLE, 0); W.cyl(x, y, 0.72, 0.78, 0.45, M.WOOD, 0); W.endObject(11);
        W.colliders.push({ t: 'c', x, y, r: 0.45, z1: 0.78 });
      }
      // TV in the corner showing static
      [x, y] = P(u1 + 0.42, 2.5);
      W.beginObject(); W.box(x, y, 2.4, 3.1, 0.5, 0.05, yIn, M.SCREEN, 2, 1, b.seed); W.endObject(11);
      // NPCs: cook behind the counter, customers on stools
      W.npcs.push({ pos: P(cu + 0.3, back - 1.35), yaw: yIn + Math.PI, sit: 0, coat: 0, shade: 0.8, hat: 1, anim: 'cook' });
      W.npcs.push({ pos: P(cu0 + 0.4 + 1.15, cv - 0.95), yaw: yIn, sit: 1, coat: 6, shade: 0.35, anim: 'eat' });
      W.npcs.push({ pos: P(cu0 + 0.4 + 3.45, cv - 0.95), yaw: yIn, sit: 1, coat: 0, shade: 0.25, visor: 2, anim: 'eat' });
      W.npcs.push({ pos: P(u1 - 1.0 + 0.7, 1.8), yaw: yAlong + Math.PI, sit: 1, coat: 2, shade: 0.3, umbrella: 0, anim: 'eat' });
      // exterior sign
      addShopSign(W, f, a, 'NOODLES', 1, 'steady', r, true);
      b.displayName = 'NEON NOODLE';
    } else {
      // arcade: two rows of cabinets facing each other
      const rows = [u0 + 1.0, u1 - 1.0];
      rows.forEach((u, ri) => {
        const face = ri === 0 ? yAlong : yAlong + Math.PI;
        for (let v = 2.2; v <= back - 1.6; v += 1.35) {
          let [x, y] = P(u, v);
          const sc = 1 + ((v * 3 + ri) | 0) % 6;
          W.beginObject();
          W.box(x, y, 0, 1.85, 0.4, 0.36, face, M.CABINET, [1, 2, 6, 3][((v * 2) | 0 + ri) & 3], 0, 0, (v * 13 + ri * 7) | 0);
          const ox = Math.cos(face) * 0.41, oy = Math.sin(face) * 0.41;
          W.box(x + ox, y + oy, 1.05, 1.6, 0.012, 0.3, face, M.SCREEN, 0, sc, (v * 31 + ri * 17) | 0);
          W.box(x + ox * 0.9, y + oy * 0.9, 1.65, 1.85, 0.03, 0.34, face, M.NEON, [1, 2, 6, 3][(ri + (v | 0)) & 3], 1, 0);
          W.endObject(13);
          W.colliders.push({ t: 'b', x, y, hx: 0.42, hy: 0.4, c: Math.cos(face), s: Math.sin(face), z1: 1.85 });
          W.interactables.push({ type: 'arcade', x, y });
        }
      });
      // players at some cabinets
      W.npcs.push({ pos: P(rows[0] + 0.85, 2.2), yaw: yAlong + Math.PI, sit: 0, coat: 1, shade: 0.3, visor: 2, anim: 'play' });
      W.npcs.push({ pos: P(rows[1] - 0.85, 4.9), yaw: yAlong, sit: 0, coat: 0, shade: 0.45, anim: 'play' });
      W.npcs.push({ pos: P(rows[0] + 0.85, 6.25), yaw: yAlong + Math.PI, sit: 0, coat: 5, shade: 0.3, hat: 1, anim: 'play' });
      // neon strips on the ceiling
      for (const u of [-1.2, 1.2]) {
        const [x, y] = P((u0 + u1) / 2 + u, back / 2 + 0.2);
        W.beginObject(); W.box(x, y, CEIL_Z - 0.08, CEIL_Z - 0.02, (back - 1.5) / 2, 0.05, yIn, M.NEON, u < 0 ? 1 : 2, 1, 0); W.endObject(12);
      }
      const [x, y] = P((u0 + u1) / 2, back - 0.05);
      const si = addSign(W, 'GAME OVER', 2, false, 'chase', r);
      Models.sign(W, x, y, 2.3, 3.2, (9 * 6 + 1) * 0.1 / 2, 0.04, yAlong, si);
      addShopSign(W, f, a, 'ARCADE', 2, 'chase', r, true);
      b.displayName = 'PIXEL PALACE ARCADE';
    }
  }

  // ----------------------------------------------------------------- signs
  function addSign(W, text, col, vertical, anim, r) {
    W.signs.push({ text, col, vertical, anim, speed: r.range(0.6, 1.6), phase: r.range(0, 100), cur: 1, scroll: 0, colCur: col, chase: 99, broken: -1, brokenOn: 1 });
    return W.signs.length - 1;
  }

  // Horizontal sign above a shop front, centred at along-coordinate a+0.5
  function addShopSign(W, f, a, text, col, anim, r, withLight) {
    const si = addSign(W, text, col, false, anim, r);
    const px = 0.16, len = (text.length * 6 + 1) * px;
    const [x, y] = facePoint(f, a + 0.5, 0.14);
    Models.sign(W, x, y, 3.3, 3.3 + 9 * px, len / 2, 0.12, alongYaw(f), si);
    if (withLight !== false) {
      const c = AC.ACCENT[col];
      const [lx, ly] = facePoint(f, a + 0.5, 1.6);
      W.addLight(lx, ly, 3.2, c[0], c[1], c[2], 8.5, 1.0, LT.SIGN, si, 0);
    }
    return si;
  }

  function decorateFacades(W, b, r) {
    for (const f of b.faces) {
      const len = f.a1 - f.a0;
      const skip = new Set();
      if (b.door && b.door.face === f.id) for (let k = -5; k <= 5; k++) skip.add(b.door.a + k);
      // horizontal shop signs along the ground floor
      if (!b.enterable || !b.door || b.door.face !== f.id) {
        let a = f.a0 + 2 + r.int(0, 3);
        while (a < f.a1 - 5) {
          const word = r.pick(SIGN_WORDS);
          const need = Math.ceil(((word.length * 6 + 1) * 0.16)) + 1;
          if (a + need >= f.a1 - 1) break;
          let clash = false;
          for (let k = 0; k < need; k++) if (skip.has(a + k)) clash = true;
          if (!clash && r.chance(0.7)) {
            const col = r.pick(ACCENTS);
            const si = addSign(W, word, col, false, r.pick(['steady', 'steady', 'flicker', 'blink', 'pulse', 'cycle']), r);
            const len = (word.length * 6 + 1) * 0.16;
            const [x, y] = facePoint(f, a + len / 2, 0.14);
            Models.sign(W, x, y, 3.3, 3.3 + 9 * 0.16, len / 2, 0.12, alongYaw(f), si);
            const c = AC.ACCENT[col];
            const [lx, ly] = facePoint(f, a + len / 2, 2.4);
            W.addLight(lx, ly, 3.2, c[0], c[1], c[2], 7, 0.8, LT.SIGN, si, 0);
            // neon tube under the sign
            if (r.chance(0.4)) {
              const [tx, ty] = facePoint(f, a + len / 2, 0.08);
              W.beginObject(); W.box(tx, ty, 3.2, 3.26, len / 2, 0.03, alongYaw(f), M.NEON, col, 1, 0); W.endObject(12);
            }
            for (let k = 0; k < need; k++) skip.add(a + k);
            a += need + r.int(2, 5);
          } else a += r.int(3, 6);
        }
      }
      // awnings over plain shop fronts
      for (let a = f.a0 + 1; a < f.a1 - 3; a += r.int(4, 9)) {
        if (skip.has(a) || skip.has(a + 2) || !r.chance(0.35)) continue;
        const [x, y] = facePoint(f, a + 1.5, 0.7);
        W.beginObject(); W.box(x, y, 2.85, 2.95, 1.45, 0.7, alongYaw(f), M.AWNING, r.pick(ACCENTS), 0, 0, a); W.endObject(4);
      }
      // vertical blade signs sticking out of the facade (1-2 per face)
      const nBlades = len > 20 ? 2 : 1;
      for (let k = 0; k < nBlades; k++) {
        if (!r.chance(0.8)) continue;
        const word = r.pick(BLADE_WORDS);
        const a = f.a0 + 1.5 + (len - 3) * (k + r.range(0.2, 0.8)) / nBlades;
        const col = r.pick(ACCENTS);
        const si = addSign(W, word, col, true, r.pick(['steady', 'flicker', 'chase', 'blink', 'steady', 'cycle']), r);
        const px = 0.21, hgt = (word.length * 8 + 1) * px, half = 3.5 * px;
        const z0 = Math.min(b.h - hgt - 0.5, r.range(5.0, 6.5));
        if (z0 < 4.6) continue;
        const [x, y] = facePoint(f, a, 0.12 + half);
        Models.sign(W, x, y, z0, z0 + hgt, half, 0.1, faceYaw(f), si);
        const c = AC.ACCENT[col];
        const [lx, ly] = facePoint(f, a, 2.6);
        W.addLight(lx, ly, z0 + hgt * 0.3, c[0], c[1], c[2], 7.5, 0.75, LT.SIGN, si, 0);
        // bracket
        const [bx, by] = facePoint(f, a, 0.1);
        W.beginObject(); W.box(bx, by, z0 + hgt - 0.1, z0 + hgt + 0.05, 0.12, 0.04, faceYaw(f), M.METAL, 0); W.endObject(4);
      }
      // AC units scattered over the upper floors
      const nAc = Math.floor(len / 5);
      for (let k = 0; k < nAc; k++) {
        if (!r.chance(0.55)) continue;
        const a = f.a0 + 1 + r.next() * (len - 2);
        const fl = r.int(1, Math.max(1, Math.floor((b.h - 5) / b.floorH)));
        const z = b.groundH + (fl - 1) * b.floorH + 0.3;
        if (z > b.h - 1.5) continue;
        const [x, y] = facePoint(f, a, 0.3);
        W.beginObject(); W.box(x, y, z, z + 0.55, 0.3, 0.42, faceYaw(f), M.AC_UNIT, 0, 0, 0, k); W.endObject(4);
      }
      // vending machine against the facade
      if (r.chance(0.6)) {
        for (let tries = 0; tries < 6; tries++) {
          const a = f.a0 + 2 + r.int(0, len - 5);
          if (skip.has(a) || skip.has(a + 1)) continue;
          const [x, y] = facePoint(f, a + 0.5, 0.42);
          Models.vending(W, x, y, faceYaw(f), r.pick([2, 1, 3, 5]), r.int(1, 999));
          const [lx, ly] = facePoint(f, a + 0.5, 1.3);
          const c = AC.ACCENT[2];
          W.addLight(lx, ly, 1.3, c[0], c[1], c[2], 3.2, 0.6, LT.STEADY, 0, 0);
          W.interactables.push({ type: 'vending', x, y });
          b.vending = (b.vending || []).concat([{ face: f.id, a: a + 0.5 }]);
          skip.add(a); skip.add(a + 1);
          break;
        }
      }
    }
  }

  function billboards(W, blds, r) {
    // the tallest building facing a street gets a big animated billboard
    const sorted = blds.filter((b) => b.faces.length).sort((a, b) => (b.tower ? b.tower.h : b.h + (b.step ? 10 : 0)) - (a.tower ? a.tower.h : a.h + (a.step ? 10 : 0)));
    let placed = 0;
    for (const b of sorted) {
      if (placed >= 2) break;
      const f = b.faces[placed === 0 ? 0 : b.faces.length - 1];
      const len = f.a1 - f.a0;
      const bw = Math.min(12, len - 3), bh = bw * 0.55;
      const zTop = (b.tower && !b.step) ? b.h : b.h;
      const z0 = Math.max(9, zTop - bh - 2);
      if (z0 + bh > zTop + 0.01) continue;
      const text = BILLBOARD_TEXT[r.int(0, BILLBOARD_TEXT.length - 1)];
      const col = placed === 0 ? 1 : 2;
      const si = addSign(W, text, col, false, 'billboard', r);
      W.signs[si].mode = placed;
      const [x, y] = facePoint(f, f.a0 + len / 2, 0.2);
      W.beginObject();
      W.box(x, y, z0, z0 + bh, bw / 2, 0.15, alongYaw(f), M.BILLBOARD, col, si, placed);
      W.endObject(10);
      const c = AC.ACCENT[col];
      const [lx, ly] = facePoint(f, f.a0 + len / 2, 5);
      W.addLight(lx, ly, z0 + bh * 0.3, c[0], c[1], c[2], 22, 1.2, LT.SIGN, si, 0);
      placed++;
    }
  }

  function rooftops(W, blds, r) {
    for (const b of blds) {
      const rects = [];
      if (b.tower) rects.push([b.tower.x0, b.tower.y0, b.tower.x1, b.tower.y1, b.tower.h]);
      else if (b.step) rects.push([b.step.x0, b.step.y0, b.step.x1, b.step.y1, b.step.h]);
      rects.push([b.x0, b.y0, b.x1, b.y1, b.h]);
      const [x0, y0, x1, y1, h] = rects[0];
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      // antenna with a blinking aviation light
      if (r.chance(0.8)) {
        const ax = x0 + 1.5 + r.next() * (x1 - x0 - 3), ay = y0 + 1.5 + r.next() * (y1 - y0 - 3);
        const ah = r.range(6, 14);
        W.beginObject();
        W.cyl(ax, ay, h, h + ah, 0.07, M.POLE, 0);
        W.box(ax, ay, h + ah * 0.6, h + ah * 0.6 + 0.08, 0.6, 0.04, r.next() * 3, M.POLE, 0);
        W.sph(ax, ay, h + ah + 0.15, 0.2, 0.2, M.BULB, 4, 2, r.next());
        W.endObject(14);
      }
      // water tank
      if (r.chance(0.6) && x1 - x0 > 6) {
        const tx = x0 + 2 + r.next() * (x1 - x0 - 4), ty = y0 + 2 + r.next() * (y1 - y0 - 4);
        if (Math.hypot(tx - cx, ty - cy) > 1) {
          W.beginObject(); W.cyl(tx, ty, h, h + 1.2, 0.08, M.POLE, 0); W.cyl(tx, ty, h + 1.2, h + 4.2, 1.3, M.TANK, 0); W.endObject(14);
        }
      }
      // rooftop AC boxes
      const n = r.int(1, 4);
      for (let k = 0; k < n; k++) {
        const ux = x0 + 1 + r.next() * (x1 - x0 - 2), uy = y0 + 1 + r.next() * (y1 - y0 - 2);
        W.beginObject(); W.box(ux, uy, h, h + r.range(0.8, 1.6), r.range(0.5, 1.2), r.range(0.5, 1.0), 0, M.AC_UNIT, 0, 0, 0, k); W.endObject(14);
      }
      // rooftop sign on podiums facing a street
      if (b.tower && b.faces.length && r.chance(0.7)) {
        const f = b.faces[0];
        const word = r.pick(['SYNTH', 'KIROSHI', 'OMNI', 'ZAIBATSU', 'NEXUS', 'TOKAMAK']);
        const col = r.pick(ACCENTS);
        const si = addSign(W, word, col, false, r.pick(['steady', 'pulse', 'flicker']), r);
        const px = 0.28, len = (word.length * 6 + 1) * px;
        const mid = (f.a0 + f.a1) / 2;
        const [x, y] = facePoint(f, mid, -1.2);
        W.beginObject();
        W.box(x, y, b.h + 0.6, b.h + 0.6 + 9 * px, len / 2, 0.1, alongYaw(f), M.SIGN, 0, si, 0);
        const [x2, y2] = facePoint(f, mid, -1.5);
        W.box(x2, y2, b.h, b.h + 0.65, len / 2, 0.05, alongYaw(f), M.METAL, 0);
        W.endObject(10);
        const c = AC.ACCENT[col];
        const [lx, ly] = facePoint(f, mid, 3);
        W.addLight(lx, ly, b.h + 1.5, c[0], c[1], c[2], 12, 1.0, LT.SIGN, si, 0);
      }
    }
  }

  // ------------------------------------------------------------ street props
  // The four block sides: along-axis, curb-side prop line, facade line,
  // arm direction of lamps (towards the road) and whether the facade is at +a.
  function blockSides() {
    return [
      { id: 'W', ax: 'y', prop: 13.55, fac: 16, dx: -1, dy: 0 },   // west side of block (x=16)
      { id: 'S', ax: 'x', prop: 13.55, fac: 16, dx: 0, dy: -1 },   // south side (y=16)
      { id: 'E', ax: 'y', prop: 2.45, fac: 0, dx: 1, dy: 0 },      // east side (x=80==0)
      { id: 'N', ax: 'x', prop: 2.45, fac: 0, dx: 0, dy: 1 },      // north side (y=80==0)
    ];
  }
  function sidePos(side, a, line) { return side.ax === 'y' ? [line, a] : [a, line]; }

  function facadeCellAt(W, side, a) {
    // cell just inside the block at along-coordinate a
    let x, y;
    if (side.id === 'W') { x = 16; y = a; } else if (side.id === 'S') { x = a; y = 16; }
    else if (side.id === 'E') { x = 79; y = a; } else { x = a; y = 79; }
    return W.idx(x, y);
  }

  function streetProps(W, r) {
    const sides = blockSides();
    const doorAt = (side, a) => W.doors.some((d) => d.face === side.id && Math.abs(d.a + 0.5 - a) < 2.2);
    sides.forEach((side, si) => {
      const off = si >= 2 ? 8 : 0;
      const used = [];
      const free = (a, rad) => used.every((u) => Math.abs(u - a) > rad);
      // street lamps every 16 m, arm over the road
      for (let a = 22 + off; a < 80; a += 16) {
        const [x, y] = sidePos(side, a, side.prop);
        const head = Models.streetLamp(W, x, y, side.dx, side.dy, a * 3 + si);
        const broken = r.chance(0.18);
        const li = W.addLight(head.x, head.y, head.z, 1, 1, 1, 14, 1.25, broken ? LT.FLICKER : LT.LAMP, a * 7 + si, 1, 0.42);
        W.prims[head.prim + World.P.A] = li + 1;   // lamp head glows with its light
        W.lampHeads = (W.lampHeads || []).concat([head]);
        used.push(a);
      }
      // trees between lamps
      for (let a = 30 + off; a < 78; a += 16) {
        if (!r.chance(0.75) || doorAt(side, a)) continue;
        const aa = a + r.range(-1.5, 1.5);
        const [x, y] = sidePos(side, aa, side.prop + (side.dx + side.dy < 0 ? 0.05 : -0.05));
        Models.tree(W, x, y, r.range(0.85, 1.15), (a * 13 + si) | 0);
        used.push(aa);
      }
      // hydrant near the corner, bins next to lamps
      { const a = 18.5 + r.range(0, 2); const [x, y] = sidePos(side, a, side.prop); Models.hydrant(W, x, y); used.push(a); }
      for (let a = 24 + off; a < 80; a += 32) {
        if (!free(a + 1.2, 0.8)) continue;
        const [x, y] = sidePos(side, a + 1.2, side.prop);
        Models.bin(W, x, y); used.push(a + 1.2);
      }
      // parking-meter style bollards with glowing caps near the corner
      for (let k = 0; k < 3; k++) {
        const a = 16.6 + k * 0.001;
        const [x, y] = side.ax === 'y' ? [side.prop + (side.dx < 0 ? 0 : 0), 16.6 + k * 1.1] : [16.6 + k * 1.1, side.prop];
        if (k === 0 && a) Models.bollard(W, x, y, 2);
        else Models.bollard(W, x, y, 2);
      }
      // benches & kiosks against the facade (skipping doors/glass/alleys)
      const facLine = side.fac === 16 ? 15.35 : 0.65;
      for (let a = 26 + off + r.int(0, 6); a < 76; a += r.int(10, 18)) {
        const ci = facadeCellAt(W, side, a);
        if (!(W.flags[ci] & F.BUILDING) || (W.flags[ci] & (F.GLASS | F.DOOR)) || doorAt(side, a)) continue;
        const ci2 = facadeCellAt(W, side, a + 1), ci3 = facadeCellAt(W, side, a - 1);
        if (!(W.flags[ci2] & F.BUILDING) || !(W.flags[ci3] & F.BUILDING)) continue;
        if ((W.flags[ci2] | W.flags[ci3]) & (F.GLASS | F.DOOR)) continue;
        const [x, y] = sidePos(side, a + 0.5, facLine);
        const yaw = Math.atan2(side.dy, side.dx);
        if (r.chance(0.3)) { Models.kiosk(W, x, y, yaw, a * 5 + si); W.interactables.push({ type: 'kiosk', x, y }); }
        else Models.bench(W, x, y, yaw);
      }
    });

    // traffic signals at the four intersection corners
    const TL = [
      { x: 13.5, y: 2.5, ax: -1, ay: 0, len: 4.0, face: -Math.PI / 2, axis: 0 },  // over northbound lane, faces south
      { x: 2.5, y: 13.5, ax: 1, ay: 0, len: 4.0, face: Math.PI / 2, axis: 0 },    // over southbound lane, faces north
      { x: 2.5, y: 2.5, ax: 0, ay: 1, len: 4.0, face: Math.PI, axis: 1 },         // over eastbound lane, faces west
      { x: 13.5, y: 13.5, ax: 0, ay: -1, len: 4.0, face: 0, axis: 1 },            // over westbound lane, faces east
    ];
    W.signalHeads = [];
    for (const t of TL) {
      const h = Models.trafficLight(W, t.x, t.y, t.ax, t.ay, t.len, t.face, t.axis);
      const lx = h.x + Math.cos(t.face) * 0.9, ly = h.y + Math.sin(t.face) * 0.9;
      const li = W.addLight(lx, ly, 5.0, 1, 0, 0, 7, 0.9, LT.SIGNAL, t.axis, 0);
      W.signalHeads.push({ x: h.x, y: h.y, axis: t.axis, light: li });
    }

    // parked cars in the parking lanes
    const parkRng = r.fork(3);
    const lanes = [
      { ax: 'y', c: 4.0, yaw: -Math.PI / 2 }, { ax: 'y', c: 12.0, yaw: Math.PI / 2 },
      { ax: 'x', c: 4.0, yaw: 0 }, { ax: 'x', c: 12.0, yaw: Math.PI },
    ];
    for (const pl of lanes) {
      for (let a = 21; a < 76; a += parkRng.range(5.6, 14)) {
        if (!parkRng.chance(0.55)) continue;
        const [x, y] = pl.ax === 'y' ? [pl.c, a] : [a, pl.c];
        const yaw = pl.yaw + parkRng.range(-0.03, 0.03);
        const type = parkRng.chance(0.12) ? 'van' : parkRng.chance(0.15) ? 'taxi' : 'sedan';
        const opt = {
          paint: parkRng.chance(0.25) ? parkRng.pick([1, 2, 3, 6, 4]) : 0, shade: parkRng.range(0.2, 0.75),
          lights: 0, type, seed: parkRng.int(1, 9999), blink: parkRng.chance(0.1) ? 2 : 0,
          signIdx: type === 'taxi' ? taxiSign(W) : 0,
        };
        Models.car(W, x, y, yaw, opt);
        const L = type === 'van' ? 2.5 : 2.3;
        W.colliders.push({ t: 'b', x, y, hx: L, hy: 1.0, c: Math.cos(yaw), s: Math.sin(yaw), z1: 1.5 });
        a += L * 2;
      }
    }

    // manholes with steam
    const mh = [[8.0, 30.5], [6.2, 58], [44, 8.2], [66, 9.8], [8.5, 8.5]];
    for (const [x, y] of mh) {
      W.manholes.push({ x, y });
      if (r.chance(0.8)) W.emitters.push({ x, y, z: 0.05, rate: 9, kind: 'steam', spread: 0.35, life: 2.8, rise: 0.9 });
    }
  }

  let _taxiSign = -1;
  function taxiSign(W) {
    if (_taxiSign < 0 || !W.signs[_taxiSign] || W.signs[_taxiSign].text !== 'TAXI') {
      W.signs.push({ text: 'TAXI', col: 3, vertical: false, anim: 'steady', speed: 1, phase: 0, cur: 1, scroll: 0, colCur: 3, chase: 99, broken: -1, brokenOn: 1 });
      _taxiSign = W.signs.length - 1;
    }
    return _taxiSign;
  }

  function alleyProps(W, r, plan) {
    const { ax, ay } = plan;
    // along the N-S alley (x in [ax, ax+3))
    for (let y = 20; y < 78; y += r.int(5, 9)) {
      const ci = W.idx(ax + 1, y);
      if (!(W.flags[ci] & F.ALLEY)) continue;
      if (Math.abs(y - (ay + 1.5)) < 3) continue;
      const side = r.chance(0.5) ? 0.55 : 2.45;
      const roll = r.next();
      if (roll < 0.35) Models.dumpster(W, ax + (side < 1 ? 0.62 : 2.38), y + 0.5, Math.PI / 2);
      else if (roll < 0.65) Models.crates(W, ax + side, y + 0.5, y * 7);
    }
    for (let x = 20; x < 78; x += r.int(6, 10)) {
      const ci = W.idx(x, ay + 1);
      if (!(W.flags[ci] & F.ALLEY)) continue;
      if (Math.abs(x - (ax + 1.5)) < 3) continue;
      if (r.chance(0.45)) Models.crates(W, x + 0.5, ay + (r.chance(0.5) ? 0.55 : 2.45), x * 3);
    }
    // strings of paper lanterns across the alleys
    const lanternCols = [4, 9, 1, 3];
    for (let y = 22; y < 78; y += 7) {
      if (Math.abs(y - (ay + 1.5)) < 2) continue;
      const z = 4.2 + (y % 3) * 0.4;
      W.beginObject();
      W.box(ax + 1.5, y, z + 0.28, z + 0.3, 1.5, 0.01, 0, M.POLE, 0);
      for (let k = 0; k < 3; k++) W.sph(ax + 0.6 + k * 0.9, y, z, 0.2, 0.26, M.LANTERN, lanternCols[(y + k) % 4], 0, 0, y * 3 + k);
      W.endObject(12);
      const c = AC.ACCENT[lanternCols[y % 4]];
      W.addLight(ax + 1.5, y, z - 0.3, c[0], c[1], c[2], 4.5, 0.5, LT.PULSE, y, 0);
    }
    // neon strips on alley walls, a flickering service light, graffiti
    for (let y = 26; y < 76; y += 13) {
      const col = r.pick([1, 2, 6]);
      W.beginObject(); W.box(ax + 0.04, y, 3.0, 3.06, 1.8, 0.03, Math.PI / 2, M.NEON, col, 1, 0); W.endObject(12);
      const c = AC.ACCENT[col];
      W.addLight(ax + 0.8, y, 2.9, c[0], c[1], c[2], 5, 0.5, LT.FLICKER, y * 5, 0);
    }
    const tags = ['NO FUTURE', 'WAKE UP', 'DATA IS FREE', 'SYSTEM FAILURE', 'KILL ROOT', 'HACK THE PLANET', 'ZERO COOL'];
    for (let k = 0; k < 6; k++) {
      const vertical = k % 2 === 0;
      const y = 22 + k * 9 + r.int(0, 3);
      if (Math.abs(y - (ay + 1.5)) < 4) continue;
      const text = tags[k % tags.length];
      const si = addSign(W, text, r.pick([1, 2, 5, 3, 6]), false, 'paint', r);
      const len = (text.length * 6 + 1) * 0.12;
      const xw = vertical ? ax + 0.02 : ax + 2.98;
      W.beginObject();
      W.box(xw, y + len / 2, 0.9, 0.9 + 9 * 0.12, len / 2, 0.01, vertical ? Math.PI / 2 : -Math.PI / 2, M.GRAFFITI, 0, si, 0);
      W.endObject(10);
    }
    // pipes on alley walls
    for (let y = 19; y < 79; y += r.int(4, 8)) {
      const ci = W.idx(ax - 1, y);
      if (!(W.flags[ci] & F.BUILDING) || W.spanLo[ci] > 0) continue;
      const h = Math.min(W.spanHi[ci] - 0.5, r.range(6, 14));
      W.beginObject(); W.cyl(ax + 0.12, y + 0.5, 0, h, 0.09, M.PIPE, 0); W.endObject(4);
      W.colliders.push({ t: 'c', x: ax + 0.12, y: y + 0.5, r: 0.12, z1: h });
    }
    W.emitters.push({ x: ax + 2.4, y: ay + 5.5, z: 0.2, rate: 7, kind: 'steam', spread: 0.2, life: 2.4, rise: 0.8 });
    // sub-alleys: a lamp each
    for (const sa of plan.subAlleys) {
      const x = (sa[0] + sa[2]) / 2, y = (sa[1] + sa[3]) / 2;
      W.addLight(x, y, 4, 1, 1, 1, 6, 0.6, LT.FLICKER, x * y, 1);
    }
  }

  // ------------------------------------------------------ pedestrian network
  function buildNav(W, plan) {
    const nodes = [], edges = [];
    const node = (x, y, type, extra) => { nodes.push(Object.assign({ x: AC.util.wrap(x, S), y: AC.util.wrap(y, S), type, adj: [] }, extra || {})); return nodes.length - 1; };
    const link = (a, b, type, extra) => {
      const e = Object.assign({ a, b, type }, extra || {});
      edges.push(e);
      nodes[a].adj.push({ to: b, e }); nodes[b].adj.push({ to: a, e });
    };
    const LO = 14.8, HI = S + 1.2; // walking lines (unwrapped)
    const C = [node(LO, LO, 'corner'), node(HI, LO, 'corner'), node(HI, HI, 'corner'), node(LO, HI, 'corner')];
    // sides of the ring in order with their key points
    const sides = [
      { from: C[0], to: C[1], ax: 'x', line: LO, a0: LO, a1: HI, id: 'S' },
      { from: C[1], to: C[2], ax: 'y', line: HI, a0: LO, a1: HI, id: 'E' },
      { from: C[2], to: C[3], ax: 'x', line: HI, a0: HI, a1: LO, id: 'N' },
      { from: C[3], to: C[0], ax: 'y', line: LO, a0: HI, a1: LO, id: 'W' },
    ];
    const mouths = {};
    for (const sd of sides) {
      const pts = [];
      // doors on this side
      for (const d of W.doors) if (d.face === sd.id) pts.push({ a: (sd.ax === 'x' ? d.cx : d.cy) + 0.5, kind: 'door', door: d });
      // alley mouths
      if (sd.id === 'S' || sd.id === 'N') pts.push({ a: plan.ax + 1.5, kind: 'alley' });
      else pts.push({ a: plan.ay + 1.5, kind: 'alley' });
      // vending machines
      for (const b of W.buildings) for (const v of b.vending || []) if (v.face === sd.id) pts.push({ a: v.a, kind: 'vending' });
      // regular spacing so edges stay short
      for (let a = 24; a < S; a += 9) pts.push({ a, kind: 'walk' });
      const dir = sd.a1 > sd.a0 ? 1 : -1;
      pts.forEach((p) => { if (sd.id === 'E' || sd.id === 'N') { /* east/north faces sit at 80+; along coords are raw */ } });
      pts.sort((p, q) => (p.a - q.a) * dir);
      let prev = sd.from;
      for (const p of pts) {
        if ((p.a - sd.a0) * dir < 1.5 || (sd.a1 - p.a) * dir < 1.5) continue;
        const [x, y] = sd.ax === 'x' ? [p.a, sd.line] : [sd.line, p.a];
        const n = node(x, y, p.kind);
        link(prev, n, 'walk');
        prev = n;
        if (p.kind === 'door') {
          const d = p.door;
          const dn = node(d.cx + 0.5 + d.nx * 0.1, d.cy + 0.5 + d.ny * 0.1, 'doorway', { door: d.id });
          link(n, dn, 'door', { door: d.id });
        } else if (p.kind === 'alley') mouths[sd.id] = n;
        else if (p.kind === 'vending') nodes[n].face = { x: sd.ax === 'x' ? 0 : sd.id === 'W' ? 1 : -1, y: sd.ax === 'x' ? (sd.id === 'S' ? 1 : -1) : 0 };
      }
      link(prev, sd.to, 'walk');
    }
    // crosswalks (need the right signal phase); axis = road being crossed
    link(C[0], C[1], 'cross', { road: 0 });   // across N-S road at y=14.8
    link(C[3], C[2], 'cross', { road: 0 });   // across N-S road at y=1.2
    link(C[0], C[3], 'cross', { road: 1 });   // across E-W road at x=14.8
    link(C[1], C[2], 'cross', { road: 1 });   // across E-W road at x=1.2
    // alleys through the block
    const X = node(plan.ax + 1.5, plan.ay + 1.5, 'alleyx');
    for (const id of ['S', 'N', 'W', 'E']) if (mouths[id] !== undefined) {
      // split long alley runs so every edge stays < S/2
      const m = nodes[mouths[id]];
      const mid = node((m.x + (plan.ax + 1.5)) / 2 + (id === 'N' ? 0 : 0), 0, 'alley');
      // place mid-point along the straight alley line (handle wrap for N/E mouths)
      const mx = id === 'E' ? S + 1.2 : id === 'W' ? LO : plan.ax + 1.5;
      const my = id === 'N' ? S + 1.2 : id === 'S' ? LO : plan.ay + 1.5;
      nodes[mid].x = AC.util.wrap((mx + plan.ax + 1.5) / 2, S);
      nodes[mid].y = AC.util.wrap((my + plan.ay + 1.5) / 2, S);
      link(mouths[id], mid, 'alley');
      link(mid, X, 'alley');
    }
    W.nav = { nodes, edges };
  }

  // ------------------------------------------------------------ car lanes
  function buildLanes(W) {
    // axis 1 = along y, 0 = along x. sig = which signal controls it.
    W.lanes = [
      { id: 0, axis: 1, dir: 1, c: 9.5, sig: 0, turn: { start: 3, cx: 13, cy: 3, to: 2, endS: 13 }, stop: S - 2.9 },
      { id: 1, axis: 1, dir: -1, c: 6.5, sig: 0, turn: { start: 13, cx: 3, cy: 13, to: 3, endS: 3 }, stop: 18.9 },
      { id: 2, axis: 0, dir: 1, c: 6.5, sig: 1, turn: { start: 3, cx: 3, cy: 3, to: 1, endS: 3 }, stop: S - 2.9 },
      { id: 3, axis: 0, dir: -1, c: 9.5, sig: 1, turn: { start: 13, cx: 13, cy: 13, to: 0, endS: 13 }, stop: 18.9 },
    ];
    // hover-car sky lanes
    W.skyLanes = [
      { axis: 1, dir: 1, c: 9.0, z: 24 }, { axis: 1, dir: -1, c: 7.0, z: 29 },
      { axis: 0, dir: 1, c: 7.0, z: 21 }, { axis: 0, dir: -1, c: 9.0, z: 33 },
    ];
  }

  return { generate, S, ST, R0, R1, SIDE_Y, INT_Z, CEIL_Z };
})();
