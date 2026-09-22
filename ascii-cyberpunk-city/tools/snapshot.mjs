// Dev harness: loads index.html in headless Chromium, positions the camera,
// captures screenshots and prints timing stats.
// Usage: node tools/snapshot.mjs [outDir] [--poses=json] [--w=1600 --h=900]
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) || 'shots';
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const W = +(opt.w || 1600), H = +(opt.h || 900);
fs.mkdirSync(outDir, { recursive: true });

const file = 'file://' + path.resolve(opt.file || 'index.html');
const browser = await playwright.chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
await page.goto(file);
await page.waitForTimeout(3800);

const poses = opt.poses ? JSON.parse(fs.readFileSync(opt.poses, 'utf8')) : [{ name: 'spawn' }];
for (const p of poses) {
  await page.evaluate((p) => {
    const A = window.__AC;
    if (p.charH) A.setCharH(p.charH);
    if (p.hour !== undefined) A.setHour(p.hour);
    if (p.rain !== undefined) A.setRain(p.rain);
    if (p.x !== undefined) A.setPose(p.x, p.y, p.yaw, p.pitch || 0);
    if (p.advance) A.advance(p.advance);
    if (p.map === false) A.opts.mapOn = false;
    if (p.interact) A.interact();
    A.opts.forceLocked = true;
    if (p.set) for (const k in p.set) A.set(k, p.set[k]);
  }, p);
  await page.waitForTimeout(p.wait || 700);
  await page.screenshot({ path: path.join(outDir, (p.name || 'shot') + '.png') });
  const st = await page.evaluate(() => { const s = window.__AC.stats; const sc = window.__AC.opts; return { ...s, charH: sc.charH, pos: [window.__AC.player.x.toFixed(1), window.__AC.player.y.toFixed(1)] }; });
  console.log(p.name, JSON.stringify(st, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
  if (opt.text) fs.writeFileSync(path.join(outDir, (p.name || 'shot') + '.txt'), await page.evaluate(() => window.__AC.text()));
}
if (errors.length) console.log('ERRORS:\n' + errors.slice(0, 20).join('\n'));
await browser.close();
