import { expect, type Page, test } from '@playwright/test';

/**
 * The wind page (#124): `wind.html` plays the rig `?model=` names (the `cloth`
 * test rig by default) under a wind slider and a gravity slider, and a drag
 * on the stage moves the rig. What it asserts, written before the first run:
 * - it loads calm: the readout says wind [0, 0] and gravity [0, 1];
 * - the wind slider at −1 moves the links' centre more than 10 px left of
 *   calm within 1.5 s, and at +1 more than 10 px right;
 * - under wind +1, the gravity slider at 3 leaves the links nearer the
 *   centre than at 1;
 * - a 60 px drag moves the rig's root 60 px;
 * - `?model=` loads another rig (the `look` gallery build).
 */

const linksX = (page: Page) =>
  page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLElement>('#stage img')).filter((el) => el.style.display !== 'none');
    const xs = imgs.map((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
    return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  });

const slide = (page: Page, id: string, value: number) =>
  page.evaluate(([i, v]) => {
    const input = document.getElementById(i as string) as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input'));
  }, [id, value] as const);

test('the wind page: sliders push and pull the chain, a drag moves it', async ({ page }) => {
  await page.goto('/wind.html');
  await expect(page.locator('#readout')).toHaveText('wind [0, 0] · gravity [0, 1]');
  await expect(page.locator('#stage img').first()).toBeAttached();
  await page.waitForTimeout(1500);
  const calm = await linksX(page);

  await slide(page, 'wind', -1);
  await page.waitForTimeout(1500);
  expect(await linksX(page)).toBeLessThan(calm - 10);

  await slide(page, 'wind', 1);
  await page.waitForTimeout(1500);
  const right = await linksX(page);
  expect(right).toBeGreaterThan(calm + 10);

  await slide(page, 'gravity', 3);
  await page.waitForTimeout(1500);
  const heavy = await linksX(page);
  expect(heavy).toBeLessThan(right);
  expect(heavy).toBeGreaterThan(calm);
  await expect(page.locator('#readout')).toHaveText('wind [1, 0] · gravity [0, 3]');

  const rootLeft = () => page.evaluate(() => parseFloat((document.getElementById('rig-root') as HTMLElement).style.left));
  const before = await rootLeft();
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('no stage box');
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + 50 + i * 10, box.y + 50);
  await page.mouse.up();
  expect((await rootLeft()) - before).toBeCloseTo(60, 6);
});

test('the wind page plays the rig ?model= names', async ({ page }) => {
  await page.goto('/wind.html?model=rigs/look/skeleton.model.json');
  await expect(page.locator('#readout')).toHaveText('wind [0, 0] · gravity [0, 1]');
  await expect(page.locator('#stage img, #stage canvas').first()).toBeAttached();
});
