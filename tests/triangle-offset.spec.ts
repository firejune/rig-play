import { expect, test } from '@playwright/test';
import { offsetTriangle } from '../src/DomRenderer.js';

/**
 * The canvas2d mesh path clips each triangle to a slightly larger copy of
 * itself so that neighbouring triangles' antialiased edges overlap (#104).
 * What matters is how far each *edge* moves: an edge moved by a fraction of a
 * pixel leaves the background showing along the shared edge as a hairline. The
 * picture-level measurement is in the pull request that made this change; this
 * pins the geometry, node-side, no browser.
 */

type Tri = [number, number, number, number, number, number];

/** Signed distance of point p from the line a→b, positive on the side away from c. */
function outwardDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): number {
  const len = Math.hypot(bx - ax, by - ay);
  const side = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / len;
  return side > 0 ? -d : d;
}

function edgeShifts(tri: Tri, amount: number): number[] {
  const o = Array.from(offsetTriangle(...tri, amount));
  const [x0, y0, x1, y1, x2, y2] = tri;
  const edges: Array<[number, number, number, number, number, number, number, number]> = [
    [x0, y0, x1, y1, x2, y2, 0, 2],
    [x1, y1, x2, y2, x0, y0, 2, 4],
    [x2, y2, x0, y0, x1, y1, 4, 0],
  ];
  const shifts: number[] = [];
  for (const [ax, ay, bx, by, cx, cy, i, j] of edges) {
    shifts.push(outwardDistance(ax, ay, bx, by, cx, cy, o[i], o[i + 1]));
    shifts.push(outwardDistance(ax, ay, bx, by, cx, cy, o[j], o[j + 1]));
  }
  return shifts;
}

test('every edge moves outward by the full amount, whichever way the triangle winds', () => {
  const ccw: Tri = [0, 0, 20, 0, 10, 8];
  const cw: Tri = [0, 0, 10, 8, 20, 0];
  for (const tri of [ccw, cw]) {
    for (const shift of edgeShifts(tri, 0.5)) expect(shift).toBeCloseTo(0.5, 9);
  }
});

test('pushing the corners away from the centroid moved the long edge a quarter as far', () => {
  // The rule this replaced, written out: the long edge of this triangle moved
  // 0.13 px for an expansion of 0.5. Kept so the difference is a number.
  const [x0, y0, x1, y1, x2, y2] = [0, 0, 20, 0, 10, 8];
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  const len = Math.hypot(x0 - cx, y0 - cy);
  const radialShift = (0.5 * (cy - y0)) / len;
  expect(radialShift).toBeLessThan(0.15);
  expect(Math.min(...edgeShifts([x0, y0, x1, y1, x2, y2], 0.5))).toBeCloseTo(0.5, 9);
});

test('a needle corner moves at most four times the amount, and the triangle still covers itself', () => {
  const needle: Tri = [0, 0, 100, 0, 50, 2];
  const o = Array.from(offsetTriangle(...needle, 0.5));
  for (let i = 0; i < 6; i += 2) {
    expect(Math.hypot(o[i] - needle[i], o[i + 1] - needle[i + 1])).toBeLessThanOrEqual(2 + 1e-9);
  }
  for (const shift of edgeShifts(needle, 0.5)) expect(shift).toBeGreaterThan(0);
});

test('an amount of 0 and a degenerate triangle are left as they are', () => {
  expect(Array.from(offsetTriangle(0, 0, 20, 0, 10, 8, 0))).toEqual([0, 0, 20, 0, 10, 8]);
  expect(Array.from(offsetTriangle(0, 0, 10, 0, 20, 0, 0.5))).toEqual([0, 0, 10, 0, 20, 0]);
});
