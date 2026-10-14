/**
 * #39 healthy macOS and Linux Chromium/WebKit floors. macOS was measured
 * locally before the PMA mutant; Linux is CI run 38609727542 at head 1559f5fb.
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
type EngineFloors = Record<'chromium' | 'webkit', Record<string, Record<OracleMode, OracleFloor>>>;
const DARWIN_FLOORS: EngineFloors = {
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

// Retained official-oracle-evidence: https://github.com/rig-c/play/actions/runs/38609727542
const LINUX_FLOORS: EngineFloors = {
  chromium: {
    "additive glow": {
      "canvas": {"black": [0, 0, 6, 0], "white": [0, 0, 10, 0], "alpha": [0, 1833, 483, 9]},
      "dom-canvas2d": {"black": [221, 69, 104, 95], "white": [227, 50, 85, 199], "alpha": [0, 11573, 4294, 89]},
      "dom-webgl": {"black": [171, 60, 107, 78], "white": [118, 44, 65, 87], "alpha": [5, 4481, 4121, 64]},
    },
    "draw initial": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "draw reordered": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "figure PMA": {
      "canvas": {"black": [0, 0, 6, 0], "white": [0, 0, 10, 0], "alpha": [33, 1019, 834, 12]},
      "dom-canvas2d": {"black": [438, 49, 50, 281], "white": [764, 190, 60, 331], "alpha": [729, 1209, 5333, 73]},
      "dom-webgl": {"black": [432, 47, 50, 276], "white": [773, 208, 60, 354], "alpha": [636, 1398, 4428, 73]},
    },
    "figure clip": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [590, 90, 58, 307], "white": [890, 270, 68, 383], "alpha": [549, 788, 3965, 59]},
      "dom-webgl": {"black": [547, 96, 58, 272], "white": [698, 203, 69, 354], "alpha": [397, 1408, 2623, 65]},
    },
    "figure geometry": {
      "canvas": {"black": [0, 0, 6, 0], "white": [0, 0, 10, 0], "alpha": [33, 1019, 834, 12]},
      "dom-canvas2d": {"black": [561, 62, 54, 374], "white": [1001, 281, 60, 440], "alpha": [639, 1626, 5390, 73]},
      "dom-webgl": {"black": [422, 48, 50, 268], "white": [759, 206, 60, 350], "alpha": [633, 1328, 4389, 73]},
    },
    "figure tinted walk": {
      "canvas": {"black": [0, 0, 5, 0], "white": [0, 0, 11, 0], "alpha": [33, 1019, 834, 12]},
      "dom-canvas2d": {"black": [655, 56, 52, 444], "white": [1227, 336, 63, 563], "alpha": [721, 136, 5737, 69]},
      "dom-webgl": {"black": [522, 55, 49, 339], "white": [902, 217, 63, 451], "alpha": [607, 1243, 4465, 69]},
    },
    "named region mesh": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [619, 513, 137, 22], "white": [629, 524, 133, 596], "alpha": [929, 49309, 1829, 137]},
      "dom-webgl": {"black": [340, 276, 137, 22], "white": [345, 278, 133, 312], "alpha": [455, 24359, 950, 137]},
    },
    "turned region": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
      "dom-webgl": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
    },
  },
  webkit: {
    "additive glow": {
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [221, 73, 101, 99], "white": [227, 55, 77, 206], "alpha": [127, 10975, 5564, 81]},
      "dom-webgl": {"black": [178, 65, 106, 80], "white": [120, 46, 63, 91], "alpha": [128, 4156, 5452, 63]},
    },
    "draw initial": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "draw reordered": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-webgl": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
    },
    "figure PMA": {
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [12, 1, 34, 12], "white": [179, 75, 48, 96], "alpha": [442, 1285, 1925, 45]},
      "dom-webgl": {"black": [7, 0, 34, 7], "white": [132, 58, 41, 49], "alpha": [162, 950, 1072, 32]},
    },
    "figure clip": {
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [99, 23, 46, 52], "white": [246, 101, 67, 119], "alpha": [351, 1923, 1961, 60]},
      "dom-webgl": {"black": [98, 22, 46, 50], "white": [230, 97, 67, 105], "alpha": [168, 1152, 1234, 58]},
    },
    "figure geometry": {
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [11, 3, 33, 10], "white": [152, 64, 48, 68], "alpha": [339, 42, 1735, 45]},
      "dom-webgl": {"black": [7, 0, 33, 7], "white": [131, 58, 41, 47], "alpha": [159, 942, 1063, 32]},
    },
    "figure tinted walk": {
      "canvas": {"black": [0, 0, 1, 0], "white": [0, 0, 1, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [14, 7, 29, 1], "white": [177, 68, 43, 53], "alpha": [540, 1825, 3016, 41]},
      "dom-webgl": {"black": [15, 7, 29, 0], "white": [156, 57, 43, 34], "alpha": [331, 333, 2120, 33]},
    },
    "named region mesh": {
      "canvas": {"black": [0, 0, 2, 0], "white": [0, 0, 1, 0], "alpha": [0, 1, 5, 1]},
      "dom-canvas2d": {"black": [631, 501, 128, 77], "white": [637, 507, 128, 567], "alpha": [896, 40474, 1447, 128]},
      "dom-webgl": {"black": [352, 267, 128, 77], "white": [349, 266, 128, 279], "alpha": [426, 15315, 964, 128]},
    },
    "turned region": {
      "canvas": {"black": [0, 0, 0, 0], "white": [0, 0, 0, 0], "alpha": [0, 0, 0, 0]},
      "dom-canvas2d": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
      "dom-webgl": {"black": [0, 0, 12, 0], "white": [0, 0, 12, 0], "alpha": [0, 0, 0, 0]},
    },
  },
};

export const ORACLE_FLOORS = { darwin: DARWIN_FLOORS, linux: LINUX_FLOORS };
interface PmaRawLimit { tolerance: 0 | 24; rawBad: number; bad?: number; maxDelta: number }
// Additional raw checks retain exact observed caps. Linux WebKit differs at
// 15 opaque RGB pixels by one byte, with identical alpha (macOS: six pixels).
const PMA_RAW_LIMITS: Record<'darwin' | 'linux', Record<'chromium' | 'webkit', PmaRawLimit>> = {
  darwin: { chromium: { tolerance: 24, rawBad: 2, bad: 0, maxDelta: 26 }, webkit: { tolerance: 0, rawBad: 6, maxDelta: 1 } },
  linux: { chromium: { tolerance: 24, rawBad: 2, bad: 0, maxDelta: 26 }, webkit: { tolerance: 0, rawBad: 15, maxDelta: 1 } },
};

export function oracleCalibration(platform: string, engine: string) {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`uncalibrated official oracle platform: ${platform}`);
  if (engine !== 'chromium' && engine !== 'webkit') throw new Error(`uncalibrated official oracle engine: ${engine}`);
  return { floors: ORACLE_FLOORS[platform][engine], pmaRaw: PMA_RAW_LIMITS[platform][engine] };
}

export const countBudget = (floor: number): number => floor === 0 ? 0 : Math.ceil(floor * 1.1) + 2;
export const byteBudget = (floor: number): number => floor === 0 ? 0 : floor + 1;
