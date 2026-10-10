import type { PageLayout, PageRegion } from '../src/DomTexture';

/**
 * The hand-written atlases the region specs cut from, read into the page
 * layout `unpackRegions` takes — the shape a model document's `pages` section
 * has (`ModelPage` in rig-c).
 *
 * Only what those atlases say: a page line, `size:`, `pma:`, and per region
 * `bounds:` and `rotate:`. `bounds: x, y, w, h` gives `w × h` in the artwork's
 * own orientation, the same two numbers `PageRegion.width/height` hold, so the
 * read is a transcription — the rotation is never applied here, and nothing
 * here knows which way a turned rect is unpacked (that is the cut's, held
 * against the UVs elsewhere). Anything else in the text is refused by name, so
 * a fixture cannot say something this reader silently drops.
 */
export function parseAtlas(text: string): PageLayout[] {
  const pages: Array<{ name: string; width: number; height: number; pma: boolean; regions: PageRegion[] }> = [];
  let page: (typeof pages)[number] | null = null;
  let region: PageRegion | null = null;
  let expectPage = true;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      expectPage = true;
      region = null;
      continue;
    }
    const entry = /^([a-z]+)\s*:\s*(.*)$/.exec(line);
    if (!entry) {
      if (expectPage) {
        page = { name: line, width: 0, height: 0, pma: false, regions: [] };
        pages.push(page);
        expectPage = false;
      } else {
        if (!page) throw new Error(`atlas: region "${line}" before any page`);
        region = { name: line, x: 0, y: 0, width: 0, height: 0, degrees: 0 };
        page.regions.push(region);
      }
      continue;
    }
    const [, key, value] = entry;
    const numbers = value.split(',').map((v) => Number(v.trim()));
    if (region === null) {
      if (!page) throw new Error(`atlas: "${line}" before any page`);
      if (key === 'size') [page.width, page.height] = numbers;
      else if (key === 'pma') page.pma = value.trim() === 'true';
      else if (key === 'filter') continue;
      else throw new Error(`atlas: page key "${key}" is not read here`);
    } else if (key === 'bounds') {
      [region.x, region.y, region.width, region.height] = numbers;
    } else if (key === 'rotate') {
      const v = value.trim();
      region.degrees = v === 'true' ? 90 : v === 'false' ? 0 : Number(v);
    } else {
      throw new Error(`atlas: region key "${key}" is not read here`);
    }
  }
  return pages;
}

/** Every region of a layout, in layout order. */
export function layoutRegions(layout: readonly PageLayout[]): PageRegion[] {
  return layout.flatMap((page) => [...page.regions]);
}

/** The same layout with every page declared premultiplied. */
export function withPma(layout: readonly PageLayout[]): PageLayout[] {
  return layout.map((page) => ({ ...page, pma: true }));
}
