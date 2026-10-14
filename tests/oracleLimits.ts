/**
 * #39 healthy macOS Chromium/WebKit floors, measured before the PMA mutant.
 * Each tuple is black/white [rawBad, shiftBad, maxByte, darkerCount] or alpha
 * [coverageCountDelta, alphaSumDelta, unequalPixels, maxByte]. RGB comparison
 * uses channel 24; alpha is read separately from the same transparent PNGs.
 * No acceptance figure is derived from the image currently under test.
 * Zero floors stay exact. Nonzero counts get 10% + two pixels/alpha units;
 * nonzero byte maxima get one byte. Other platforms must be measured, never
 * silently admitted by regenerating this table during a test.
 * Named covers native-scale UV/rotation; half-scale checker minification has
 * additional CSS/GL sampling residue and is outside this case's claim.
 */
import type { OracleMode } from './oracle';
export interface OracleFloor {
  black: [number, number, number, number];
  white: [number, number, number, number];
  alpha: [number, number, number, number];
}
export const ORACLE_FLOORS: Record<'chromium' | 'webkit', Record<string, Record<OracleMode, OracleFloor>>> = {
  chromium: {
    "figure geometry": {
      "dom-webgl": {"black": [434, 51, 51, 287], "white": [773, 212, 60, 368], "alpha": [621, 2036, 4428, 73]},
      "dom-canvas2d": {"black": [576, 66, 53, 399], "white": [1029, 282, 60, 469], "alpha": [619, 3212, 5445, 73]},
      "canvas": {"black": [0, 0, 6, 0], "white": [0, 0, 10, 0], "alpha": [33, 1019, 834, 12]},
    },
    "figure tinted walk": {
      "dom-webgl": {"black": [527, 54, 49, 341], "white": [901, 215, 63, 456], "alpha": [604, 1329, 4496, 69]},
      "dom-canvas2d": {"black": [662, 56, 51, 446], "white": [1234, 329, 63, 570], "alpha": [663, 754, 5752, 69]},
      "canvas": {"black": [0, 0, 5, 0], "white": [0, 0, 11, 0], "alpha": [33, 1019, 834, 12]},
    },
    "figure PMA": {
      "dom-webgl": {"black": [446, 50, 51, 300], "white": [784, 214, 60, 377], "alpha": [623, 2120, 4467, 73]},
      "dom-canvas2d": {"black": [454, 50, 51, 306], "white": [773, 188, 60, 345], "alpha": [717, 2554, 5422, 73]},
      "canvas": {"black": [0, 0, 6, 0], "white": [0, 0, 10, 0], "alpha": [33, 1019, 834, 12]},
    },
    "figure clip": {
      "dom-webgl": {"black": [541, 91, 60, 296], "white": [692, 200, 69, 375], "alpha": [388, 881, 2631, 65]},
      "dom-canvas2d": {"black": [599, 87, 60, 347], "white": [909, 254, 69, 431], "alpha": [502, 1696, 3969, 62]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "draw initial": {
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "draw reordered": {
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "turned region": {
      "dom-webgl": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "named region mesh": {
      "dom-webgl": {"black": [339, 277, 137, 22], "white": [346, 279, 133, 313], "alpha": [455, 24359, 950, 137]},
      "dom-canvas2d": {"black": [629, 525, 139, 22], "white": [629, 525, 133, 596], "alpha": [901, 48442, 1976, 139]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "additive glow": {
      "dom-webgl": {"black": [171, 60, 107, 78], "white": [119, 43, 65, 90], "alpha": [73, 404, 4696, 64]},
      "dom-canvas2d": {"black": [220, 69, 105, 99], "white": [221, 54, 83, 192], "alpha": [68, 6461, 4848, 86]},
      "canvas": {"black": [0, 0, 6, 0], "white": [0, 0, 10, 0], "alpha": [0, 1833, 483, 9]},
    },
  },
  webkit: {
    "figure geometry": {
      "dom-webgl": {"black": [440, 56, 86, 391], "white": [725, 188, 87, 301], "alpha": [194, 35670, 2878, 105]},
      "dom-canvas2d": {"black": [444, 56, 86, 395], "white": [748, 200, 87, 322], "alpha": [384, 34851, 3577, 105]},
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
    },
    "figure tinted walk": {
      "dom-webgl": {"black": [0, 0, 23, 0], "white": [123, 39, 41, 31], "alpha": [232, 2636, 2711, 33]},
      "dom-canvas2d": {"black": [1, 0, 25, 1], "white": [144, 50, 44, 51], "alpha": [421, 1418, 4215, 42]},
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 1, 1, 1]},
    },
    "figure PMA": {
      "dom-webgl": {"black": [449, 56, 88, 401], "white": [733, 188, 87, 306], "alpha": [197, 36192, 2925, 105]},
      "dom-canvas2d": {"black": [452, 59, 88, 403], "white": [767, 209, 87, 339], "alpha": [470, 34184, 3802, 105]},
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 1, 1, 1]},
    },
    "figure clip": {
      "dom-webgl": {"black": [405, 58, 86, 324], "white": [473, 111, 67, 273], "alpha": [167, 10159, 1885, 70]},
      "dom-canvas2d": {"black": [405, 59, 86, 323], "white": [483, 116, 67, 282], "alpha": [325, 9796, 2659, 70]},
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 1, 1, 1]},
    },
    "draw initial": {
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "draw reordered": {
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "turned region": {
      "dom-webgl": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "named region mesh": {
      "dom-webgl": {"black": [719, 287, 127, 181], "white": [726, 289, 127, 545], "alpha": [520, 30371, 1004, 127]},
      "dom-canvas2d": {"black": [999, 526, 127, 181], "white": [1013, 532, 127, 832], "alpha": [990, 55425, 1675, 127]},
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 1, 1, 1]},
    },
    "additive glow": {
      "dom-webgl": {"black": [220, 70, 106, 123], "white": [319, 49, 66, 122], "alpha": [67, 20744, 5412, 64]},
      "dom-canvas2d": {"black": [261, 73, 103, 135], "white": [419, 58, 77, 226], "alpha": [68, 14017, 5530, 81]},
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
    },
  },
};

export const countBudget = (floor: number): number => floor === 0 ? 0 : Math.ceil(floor * 1.1) + 2;
export const byteBudget = (floor: number): number => floor === 0 ? 0 : floor + 1;
