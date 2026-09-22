// Node micro-benchmark of the raycaster + shader without a browser.
// Usage: node tools/bench-raycast.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mods = ['util.js', 'font.js', 'world-data.js', 'models.js', 'worldgen.js', 'environment.js', 'entities.js', 'ai.js', 'physics.js', 'player.js', 'raycaster.js', 'shading.js'];
let code = mods.map((m) => fs.readFileSync(path.join(__dirname, '..', 'src', m), 'utf8')).join('\n');
// minimal glyph table (the renderer module needs a DOM)
code += `
AC.Glyphs = (function(){ let C=''; for (let c=32;c<127;c++) C+=String.fromCharCode(c); C+='¯·█▓▒░▀▄─│┌┐└┘═║╔╗╚╝■▌▐';
  const map=new Int16Array(0x2600); const list=Array.from(C); list.forEach((ch,i)=>{map[ch.charCodeAt(0)]=i;});
  return { list, count: list.length, index: (ch)=>map[ch.charCodeAt(0)] }; })();
globalThis.AC = AC;`;
vm.runInThisContext(code);
const AC = globalThis.AC;
const W = AC.WorldGen.generate(2089);
const env = AC.Environment.create();
AC.Physics.init(W); AC.Raycaster.init(W);
const ents = new AC.Entities.System(W, 2089 ^ 0x1234);
const cols = 160, rows = 50, n = cols * rows;
const scr = { cols, rows, CW: 10, CH: 18, glyph: new Uint8Array(n), fr: new Uint8ClampedArray(n), fg: new Uint8ClampedArray(n), fb: new Uint8ClampedArray(n), gT: new Float32Array(n), gKey: new Int32Array(n), gLum: new Float32Array(n) };
AC.Shading.init(W, env, scr);
AC.Environment.update(env, 0.016, 1, 1);
AC.Environment.signals(env, 1);
AC.AI.animate(W, env, 1);
const views = [
  { name: 'spawn', x: 14.4, y: 31.5, yaw: -1.69, pitch: 0 },
  { name: 'avenue', x: 8, y: 40, yaw: 1.5708, pitch: 0 },
  { name: 'cross', x: 8, y: 8, yaw: 0.05, pitch: 0 },
  { name: 'noodle', x: 18.5, y: 21.5, yaw: 0, pitch: 0 },
];
const noop = () => {};
let grand = 0, grandS = 0;
for (const v of views) {
  const cam = { x: v.x, y: v.y, z: 1.77, yaw: v.yaw, pitch: v.pitch, roll: 0, tanH: Math.tan(44 * Math.PI / 180) };
  ents.emit(1, env, cam);
  AC.Shading.beginFrame(1, 1, cam, 105);
  const N = 20;
  // warm up
  for (let k = 0; k < 5; k++) AC.Raycaster.castFrame(cam, scr, 1, rows - 1, 105, AC.Shading.shade);
  let t0 = performance.now();
  for (let k = 0; k < N; k++) AC.Raycaster.castFrame(cam, scr, 1, rows - 1, 105, noop);
  const castOnly = (performance.now() - t0) / N;

  t0 = performance.now();
  for (let k = 0; k < N; k++) AC.Raycaster.castFrame(cam, scr, 1, rows - 1, 105, AC.Shading.shade);
  const full = (performance.now() - t0) / N;
  AC.Shading.stats.refl = 0; AC.Raycaster.castFrame(cam, scr, 1, rows - 1, 105, AC.Shading.shade);
  const reflRays = AC.Shading.stats.refl;
  env.reflections = false;
  t0 = performance.now();
  for (let k = 0; k < N; k++) AC.Raycaster.castFrame(cam, scr, 1, rows - 1, 105, AC.Shading.shade);
  const noRefl = (performance.now() - t0) / N;
  env.reflections = true;
  console.log('   reflection rays', reflRays, ' total without reflections', noRefl.toFixed(2), 'ms');
  grand += full; grandS += castOnly;
  console.log(v.name.padEnd(8), 'cast', castOnly.toFixed(2), 'ms  cast+shade', full.toFixed(2), 'ms  steps', AC.Raycaster.stats.steps);
}
console.log('avg cast', (grandS / views.length).toFixed(2), 'ms, avg total', (grand / views.length).toFixed(2), 'ms');
