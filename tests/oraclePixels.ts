import type { Page } from '@playwright/test';

/** Auxiliary checks of the actual screenshots; neither path redraws a rig. */
export async function oraclePixels(page: Page, reference: Buffer, actual: Buffer) {
  return page.evaluate(async ({ a, b }) => {
    const decode = async (src: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${src}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('oracle alpha canvas unavailable');
      ctx.drawImage(image, 0, 0);
      return { image, canvas, ctx, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [ra, rb] = await Promise.all([decode(a), decode(b)]);
    if (ra.canvas.width !== rb.canvas.width || ra.canvas.height !== rb.canvas.height) throw new Error('oracle alpha dimensions differ');
    let countA = 0, countB = 0, sumA = 0, sumB = 0, rawBad = 0, maxDelta = 0;
    for (let i = 3; i < ra.pixels.length; i += 4) {
      const aa = ra.pixels[i], ab = rb.pixels[i];
      if (aa) countA++; if (ab) countB++;
      sumA += aa; sumB += ab;
      const delta = Math.abs(aa - ab); maxDelta = Math.max(maxDelta, delta);
      if (delta) rawBad++;
    }
    const composites = [0, 255].map(value => {
      const draw = (decoded: typeof ra) => {
        decoded.ctx.fillStyle = `rgb(${value},${value},${value})`;
        decoded.ctx.fillRect(0, 0, decoded.canvas.width, decoded.canvas.height);
        decoded.ctx.drawImage(decoded.image, 0, 0);
        return decoded.canvas.toDataURL('image/png').split(',')[1];
      };
      return { background: value, reference: draw(ra), actual: draw(rb) };
    });
    return { alpha: { countA, countB, sumA, sumB, rawBad, maxDelta }, composites };
  }, { a: reference.toString('base64'), b: actual.toString('base64') });
}
