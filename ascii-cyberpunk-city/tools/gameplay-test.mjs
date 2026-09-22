// Scripted gameplay checks run against the real page in headless Chromium.
// Usage: node tools/gameplay-test.mjs
import { createRequire } from 'module';
import path from 'path';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('file://' + path.resolve('index.html'));
await page.waitForTimeout(1500);
await page.evaluate(() => { __AC.setCharH(24); __AC.opts.forceLocked = true; });

let pass = 0, fail = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); ok ? pass++ : fail++; };
const pose = (x, y, yaw) => page.evaluate(([x, y, yaw]) => __AC.setPose(x, y, yaw, 0), [x, y, yaw]);
const state = () => page.evaluate(() => ({ x: __AC.player.x, y: __AC.player.y, z: __AC.player.zFeet, loc: AC.HUD.location(__AC.W, __AC.player).place }));
// drive the game loop deterministically: N frames of 1/60 s with keys held
async function hold(keys, frames) {
  await page.evaluate(([keys, frames]) => {
    for (const k of keys) window.dispatchEvent(new KeyboardEvent('keydown', { code: k }));
    for (let i = 0; i < frames; i++) __AC.frame(1 / 60);
    for (const k of keys) window.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
  }, [keys, frames]);
}
async function press(key) { await hold([key], 1); }

// 1. walking forward moves the player
await pose(14.4, 40, -Math.PI / 2);
await hold(['KeyW'], 60);
let s = await state();
check('walk forward ~3.4 m/s', s.y < 37.2 && s.y > 36 && Math.abs(s.x - 14.4) < 0.05, JSON.stringify(s));
// sprint is faster
await pose(14.4, 60, -Math.PI / 2);
await hold(['KeyW', 'ShiftLeft'], 60);
s = await state();
check('sprint ~7 m/s', s.y < 54.5, JSON.stringify(s));
// strafe
await pose(14.4, 40, -Math.PI / 2);
await hold(['KeyD'], 30);
s = await state();
check('strafe right moves west when facing south', s.x < 13.4, JSON.stringify(s));

// 2. collision with a building wall (block west face at x=16)
await pose(14.4, 38, 0);
await hold(['KeyW'], 120);
s = await state();
check('blocked by building wall', s.x <= 16 - 0.27 && s.x > 15.3, JSON.stringify(s));

// 3. kerb step: road (z=0) -> sidewalk (z=0.15)
await pose(9.5, 44.5, 0);
let z0 = (await state()).z;
await hold(['KeyW'], 110);
s = await state();
check('steps up the kerb onto the sidewalk', z0 < 0.01 && Math.abs(s.z - 0.15) < 0.02 && s.x > 13, JSON.stringify(s));

// 4. enterable door: open with E and walk inside
const door = await page.evaluate(() => { const d = __AC.W.doors.find((d) => d.kind === 'noodle'); d.open = 0; d.target = 0; d.hold = 0; d.playerOpen = false; return { cx: d.cx, cy: d.cy }; });
await pose(door.cx - 1.3, door.cy + 0.5, 0);
// keep walkers from opening the door during this check
await page.evaluate(() => { for (const p of __AC.ents.peds) { if (p.state === 'inside') p.timer = 1e6; else if (Math.hypot(p.x - 16, p.y - 21) < 8) { p.visible = false; p.state = 'inside'; p.timer = 1e6; } } });
await hold(['KeyW'], 40);
s = await state();
check('closed door blocks entry (recess is walkable)', s.x < door.cx + 0.55, JSON.stringify(s));
const prompt = await page.evaluate(() => __AC.prompt());
check('interaction prompt shown', /ENTER NEON NOODLE/.test(prompt || ''), prompt);
await press('KeyE');
await hold([], 40);
const open = await page.evaluate(() => __AC.W.doors.find((d) => d.kind === 'noodle').open);
check('E opens the door', open > 0.95, 'open=' + open.toFixed(2));
await hold(['KeyW'], 90);
s = await state();
check('walked into the noodle bar', s.x > door.cx + 1.5 && s.loc === 'NEON NOODLE', JSON.stringify(s));
check('interior floor height', Math.abs(s.z - 0.17) < 0.02, 'z=' + s.z);

// 5. locked door denies access
const ld = await page.evaluate(() => { const d = __AC.W.doors.find((d) => d.locked && d.face === 'W'); return { cx: d.cx, cy: d.cy }; });
await pose(ld.cx - 1.2, ld.cy + 0.5, 0);
await press('KeyE');
await hold(['KeyW'], 60);
s = await state();
check('locked door stays shut', s.x < ld.cx + 0.55, JSON.stringify(s));

// 6. glass shop front is solid
await pose(door.cx - 1.3, door.cy + 3.5, 0);
await hold(['KeyW'], 60);
s = await state();
check('glass shop front blocks', s.x < door.cx - 0.2, JSON.stringify(s));

// 7. traffic: cars move, obey red lights, never overlap
const traffic = await page.evaluate(() => {
  const E = __AC.ents, S = 80;
  __AC.setPose(40, 40, 0, 0); // stand inside the block, out of the way (in a building is fine for AI)
  let minGap = 1e9, moved = 0, redRunners = 0, turns = 0;
  const start = E.cars.map((c) => [c.x, c.y]);
  const wasTurning = new Set();
  for (let step = 0; step < 120 * 60; step++) {
    __AC.advance(1 / 120);
    for (const c of E.cars) {
      if (c.turn && !wasTurning.has(c)) { turns++; wasTurning.add(c); }
      if (!c.turn) wasTurning.delete(c);
    }
    if (step % 12 === 0) {
      for (let i = 0; i < E.cars.length; i++) for (let j = i + 1; j < E.cars.length; j++) {
        const a = E.cars[i], b = E.cars[j];
        let dx = Math.abs(a.x - b.x); dx = Math.min(dx, S - dx);
        let dy = Math.abs(a.y - b.y); dy = Math.min(dy, S - dy);
        const d = Math.hypot(dx, dy);
        if (d < minGap) minGap = d;
      }
      // a car inside the intersection box whose axis has red for >2 s is a red runner
      const env = __AC.env;
      for (const c of E.cars) {
        if (c.turn) continue;
        const L = __AC.W.lanes[c.lane];
        const s = L.axis === 1 ? c.y : c.x;
        if (s > 4 && s < 12 && env.signal[L.sig] === 2 && ((env.signalT % 29) > (L.sig === 0 ? 17 : 3)) && ((env.signalT % 29) < (L.sig === 0 ? 27 : 10))) redRunners++;
      }
    }
  }
  E.cars.forEach((c, i) => { if (Math.hypot(c.x - start[i][0], c.y - start[i][1]) > 1) moved++; });
  return { minGap, moved, n: E.cars.length, redRunners, turns };
});
check('cars move', traffic.moved >= traffic.n - 1, JSON.stringify(traffic));
check('cars keep distance (no overlaps)', traffic.minGap > 2.2, 'minGap=' + traffic.minGap.toFixed(2));
check('cars respect red lights', traffic.redRunners === 0, 'redRunners=' + traffic.redRunners);
check('cars take right turns', traffic.turns > 0, 'turns=' + traffic.turns);

// 8. pedestrians walk, cross, and use doors
const peds = await page.evaluate(() => {
  const E = __AC.ents;
  const start = E.peds.map((p) => [p.x, p.y]);
  let crossings = 0, inside = 0, waiting = 0;
  const prevState = E.peds.map((p) => p.state);
  for (let step = 0; step < 120 * 90; step++) {
    __AC.advance(1 / 120);
    E.peds.forEach((p, i) => {
      if (p.state !== prevState[i]) {
        if (p.state === 'inside') inside++;
        if (prevState[i] === 'wait' && p.state === 'walk') crossings++;
        if (p.state === 'wait') waiting++;
        prevState[i] = p.state;
      }
    });
  }
  let moved = 0;
  E.peds.forEach((p, i) => { if (Math.hypot(p.x - start[i][0], p.y - start[i][1]) > 2) moved++; });
  // anybody stuck inside a building cell?
  let stuck = 0;
  for (const p of E.peds) if (p.visible && AC.Physics.blocksBody(__AC.W.idx(p.x, p.y), 0.15)) stuck++;
  return { moved, n: E.peds.length, crossings, inside, waiting, stuck };
});
check('pedestrians move', peds.moved >= peds.n * 0.7, JSON.stringify(peds));
check('pedestrians cross at signals', peds.crossings > 0 && peds.waiting > 0);
check('pedestrians enter buildings', peds.inside > 0);
check('no pedestrian inside walls', peds.stuck === 0, 'stuck=' + peds.stuck);

// 9. time of day
await page.evaluate(() => { __AC.setHour(12.5); __AC.frame(1 / 60); });
const day = await page.evaluate(() => ({ d: __AC.env.daylight, lamps: __AC.env.lampsOn }));
check('daytime lighting', day.d > 0.8 && day.lamps === 0, JSON.stringify(day));

check('no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
