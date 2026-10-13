import { expect, test } from '@playwright/test';
import { defaultMeshSourceRect } from '../src/DomRenderer.js';

/**
 * Which source rect a canvas2d mesh triangle is drawn from by default (#25):
 * the sub-rect on Linux WebKit, the one engine that garbles a whole-page draw,
 * and the whole page everywhere else, where the sub-rect only costs. Node-side,
 * no browser: the rule is a user-agent test, so it is tested on user agents.
 */

const cases: Array<[string, string, 'triangle' | 'page']> = [
  ['Linux WebKit (Playwright)', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15', 'triangle'],
  ['Epiphany (WebKitGTK)', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Epiphany/605.1.15', 'triangle'],
  ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15', 'page'],
  ['iOS Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1', 'page'],
  ['Linux Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'page'],
  ['Android Chrome', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'page'],
  ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'page'],
  ['no user agent', '', 'page'],
];

for (const [name, ua, expected] of cases) {
  test(`default source rect: ${name} → ${expected}`, () => {
    expect(defaultMeshSourceRect(ua)).toBe(expected);
  });
}
