'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/main/dock');

// 3440x1440 ultrawide with a 48 px taskbar at the bottom
const WA = { x: 0, y: 0, width: 3440, height: 1392 };
const SIZE = { width: 380, height: 160 };
const at = (x, y) => ({ x, y, ...SIZE });

test('dock: default anchor is the bottom-right corner, MARGIN from the edges', () => {
  const b = D.boundsFor(D.defaultAnchor(1), WA, SIZE);
  assert.deepEqual(b, { x: 3440 - 380 - D.MARGIN, y: 1392 - 160 - D.MARGIN, ...SIZE });
});

test('dock: dragging near an edge snaps to it (magnet), elsewhere stays put', () => {
  const nearLeft = D.anchorFromBounds(at(20, 600), WA, 1);
  assert.equal(nearLeft.h, 'left');
  assert.equal(nearLeft.v, 'free');
  assert.equal(D.boundsFor(nearLeft, WA, SIZE).x, D.MARGIN);
  assert.equal(D.boundsFor(nearLeft, WA, SIZE).y, 600);

  const middle = D.anchorFromBounds(at(1500, 600), WA, 1);
  assert.equal(middle.h, 'free');
  assert.equal(middle.v, 'free');
  assert.deepEqual(D.boundsFor(middle, WA, SIZE), at(1500, 600));
});

test('dock: pin glues to the nearest edge, and to the corner when close to one', () => {
  // middle of the right side -> right edge only
  const right = D.anchorFromBounds(at(2900, 600), WA, 1, { pin: true });
  assert.equal(right.h, 'right');
  assert.equal(right.v, 'free');
  // near top-left -> corner
  const corner = D.anchorFromBounds(at(60, 80), WA, 1, { pin: true });
  assert.deepEqual([corner.h, corner.v], ['left', 'top']);
  assert.deepEqual(D.boundsFor(corner, WA, SIZE), at(D.MARGIN, D.MARGIN));
  // dead centre still pins to something
  const centre = D.anchorFromBounds(at(1530, 616), WA, 1, { pin: true });
  assert.ok(centre.h !== 'free' || centre.v !== 'free');
});

test('dock: an edge-glued player stays glued when a game changes the resolution', () => {
  const a = D.anchorFromBounds(at(3440 - 380 - 12, 1392 - 160 - 12), WA, 1, { pin: true });
  const fullHd = { x: 0, y: 0, width: 1920, height: 1032 };
  assert.deepEqual(D.boundsFor(a, fullHd, SIZE), at(1920 - 380 - D.MARGIN, 1032 - 160 - D.MARGIN));
  // a free position scales proportionally and stays on screen
  const free = D.anchorFromBounds(at(1500, 600), WA, 1);
  const b = D.boundsFor(free, fullHd, SIZE);
  assert.ok(b.x >= 0 && b.x + 380 <= 1920 && b.y >= 0 && b.y + 160 <= 1032);
});

test('dock: works on a second monitor to the left (negative coordinates)', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  const a = D.anchorFromBounds(at(-1920 + 15, 1040 - 160 - 20), left, 2, { pin: true });
  assert.deepEqual([a.h, a.v, a.displayId], ['left', 'bottom', '2']);
  assert.deepEqual(D.boundsFor(a, left, SIZE), at(-1920 + D.MARGIN, 1040 - 160 - D.MARGIN));
});

test('dock: settings.json garbage is rejected, missing display falls back to primary', () => {
  assert.equal(D.validAnchor(null), null);
  assert.equal(D.validAnchor({ h: 'middle', v: 'top' }), null);
  assert.deepEqual(D.validAnchor({ displayId: 5, h: 'free', v: 'top', fx: 7, fy: 'x' }),
    { displayId: '5', h: 'free', v: 'top', fx: 1, fy: 1 });
  const primary = { id: 1 };
  assert.equal(D.displayFor({ displayId: '9' }, [primary, { id: 2 }], primary), primary);
  assert.equal(D.displayFor({ displayId: '2' }, [primary, { id: 2 }], primary).id, 2);
});
