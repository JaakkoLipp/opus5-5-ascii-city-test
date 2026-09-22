// ============================================================================
// input.js — keyboard, mouse look (pointer lock, with drag-to-look fallback)
// ============================================================================
AC.Input = (function () {
  'use strict';
  const keys = new Set();
  const pressed = [];
  let mdx = 0, mdy = 0, locked = false, dragging = false, el = null;
  const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);

  function init(element) {
    el = element;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { if (GAME_KEYS.has(e.code)) e.preventDefault(); return; }
      keys.add(e.code);
      pressed.push(e.code);
      if (GAME_KEYS.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());
    el.addEventListener('mousedown', (e) => {
      if (!locked && el.requestPointerLock) {
        try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* ignore */ }
      }
      dragging = true;
      pressed.push('Click');
      e.preventDefault();
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (locked || dragging) { mdx += e.movementX || 0; mdy += e.movementY || 0; }
    });
    document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === el; if (!locked) keys.clear(); });
  }

  return {
    init,
    key: (code) => keys.has(code),
    get locked() { return locked; },
    get mdx() { return mdx; },
    get mdy() { return mdy; },
    // call once per frame after the player consumed the deltas
    endFrame() { mdx = 0; mdy = 0; pressed.length = 0; },
    pressed: () => pressed,
    release() { if (document.exitPointerLock) document.exitPointerLock(); },
  };
})();
