/** Original packed artwork, encoded as PMA before either reader sees it. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlate } from 'rig-c/plate';

const [sourceRig, packedBuild, output] = process.argv.slice(2);
if (!sourceRig || !packedBuild || !output) throw new Error('usage: make_oracle_pma.ts <figure source> <packed build> <input dir>');
const model = JSON.parse(readFileSync(join(packedBuild, 'skeleton.model.json'), 'utf8')) as { pages: Array<{ name: string; pma: boolean }> };
if (model.pages.length !== 1 || model.pages[0].name !== 'skeleton.png' || model.pages[0].pma)
  throw new Error('oracle PMA fixture requires the one straight skeleton.png page of figure-packed');
mkdirSync(output, { recursive: true });
for (const file of ['rig.json', 'motion.json', 'parts']) cpSync(join(sourceRig, file), join(output, file), { recursive: true });
mkdirSync(join(output, 'art'), { recursive: true });
const plate = readPlate(join(packedBuild, 'skeleton.png'));
for (let i = 0; i < plate.data.length; i += 4) {
  const alpha = plate.data[i + 3];
  for (let c = 0; c < 3; c++) plate.data[i + c] = Math.round(plate.data[i + c] * alpha / 255);
}
// rig-c/plate writes byte-exact RGBA PNGs without a browser's 2D-alpha storage.
plate.writePng(join(output, 'art/pma-page.png'));
const atlas = readFileSync(join(packedBuild, 'skeleton.atlas'), 'utf8');
if (!atlas.startsWith('skeleton.png\n') || atlas.split('pma: false').length !== 2)
  throw new Error('oracle PMA source atlas must declare exactly one straight page');
writeFileSync(join(output, 'art/pma.atlas'), atlas.replace(/^skeleton.png/, 'pma-page.png').replace('pma: false', 'pma: true'));
