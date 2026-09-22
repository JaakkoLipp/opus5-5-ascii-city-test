#!/usr/bin/env node
// Bundles src/*.js into a single self-contained index.html (no dependencies).
// Usage: node build.js
'use strict';
const fs = require('fs');
const path = require('path');

// Module order matters: each file only references modules listed before it
// at load time.
const MODULES = [
  'util.js', 'font.js', 'world-data.js', 'models.js', 'worldgen.js',
  'environment.js', 'entities.js', 'ai.js', 'physics.js', 'player.js',
  'raycaster.js', 'shading.js', 'ascii-renderer.js', 'particles.js',
  'hud.js', 'input.js', 'audio.js', 'main.js',
];

const src = path.join(__dirname, 'src');
const template = fs.readFileSync(path.join(src, 'template.html'), 'utf8');
const body = MODULES.map((m) => {
  const code = fs.readFileSync(path.join(src, m), 'utf8');
  if (code.includes('</script')) throw new Error(m + ' contains a closing script tag');
  return `// ---- ${m} ${'-'.repeat(Math.max(0, 70 - m.length))}\n${code}`;
}).join('\n');
const html = template.replace('<!--SCRIPTS-->', () => `<script>\n${body}\n</script>`);
fs.writeFileSync(path.join(__dirname, 'index.html'), html);

// dev page loading the modules individually (handy for debugging)
const dev = template.replace('<!--SCRIPTS-->', () => MODULES.map((m) => `<script src="${m}"></script>`).join('\n'));
fs.writeFileSync(path.join(src, 'dev.html'), dev);
console.log(`index.html: ${(html.length / 1024).toFixed(1)} KB from ${MODULES.length} modules`);
