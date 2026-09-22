// Dev harness: CPU-profiles the running game for a few seconds and prints the
// hottest functions by self time. Usage: node tools/profile.mjs [x y yaw]
import { createRequire } from 'module';
import path from 'path';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const [x, y, yaw] = process.argv.slice(2).map(Number);
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('file://' + path.resolve('index.html'));
await page.waitForTimeout(2500);
await page.evaluate(([x, y, yaw]) => { __AC.setCharH(18); __AC.opts.forceLocked = true; if (!isNaN(x)) __AC.setPose(x, y, yaw, 0); }, [x, y, yaw]);
await page.waitForTimeout(500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.waitForTimeout(4000);
const { profile } = await cdp.send('Profiler.stop');
const self = new Map();
const dt = (profile.endTime - profile.startTime) / profile.samples.length;
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (const s of profile.samples) {
  const n = byId.get(s); const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'} :${cf.lineNumber}`;
  self.set(key, (self.get(key) || 0) + dt);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log('total ms', (total / 1000).toFixed(0));
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log((v / total * 100).toFixed(1).padStart(5) + '%  ' + k));
console.log(JSON.stringify(await page.evaluate(() => __AC.stats)));
await browser.close();
