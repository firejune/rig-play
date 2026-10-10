import {
  AtlasAttachmentLoader,
  type Skeleton,
  type SkeletonData,
  SkeletonJson,
  Texture,
  TextureAtlas,
  type TextureFilter,
  type TextureWrap,
} from '@esotericsoftware/spine-core';

import { DomRenderer } from '../src/DomRenderer';
import { type PageLayout, type RegionImage, revokeRegions, unpackRegions } from '../src/DomTexture';
import type { PosedSlot } from '../src/posedFrame';
import { frameOfSkeleton } from './skeletonFrame';

/**
 * Drawing spine-core skeletons through the package's renderer, for the specs
 * that test the renderer on Spine exports and hand-made atlases (see
 * `tests/skeletonFrame.ts` for why those exist and what the frame they draw
 * is read from).
 */

/** A spine-core texture handle over a DOM image — filtering and wrapping are GPU concepts, no-ops here. */
export class DomTexture extends Texture {
  setFilters(_minFilter: TextureFilter, _magFilter: TextureFilter): void {}
  setWraps(_uWrap: TextureWrap, _vWrap: TextureWrap): void {}
  dispose(): void {}
}

/** A parsed atlas as the page layout `unpackRegions` reads — pages in order, each page's regions in atlas order. */
export function atlasPages(atlas: TextureAtlas): PageLayout[] {
  return atlas.pages.map((page) => ({
    name: page.name,
    width: page.width,
    height: page.height,
    pma: page.pma,
    regions: atlas.regions.filter((region) => region.page === page),
  }));
}

/** `unpackRegions` over a parsed atlas. */
export function unpackAtlas(
  atlas: TextureAtlas,
  pageImages: ReadonlyMap<string, HTMLImageElement>,
): Promise<Map<string, RegionImage>> {
  return unpackRegions(atlasPages(atlas), pageImages);
}

/**
 * A `DomRenderer` that draws a spine-core skeleton: `renderSkeleton` reads the
 * frame (`frameOfSkeleton`), registers the pages it names, and renders it.
 */
export class SkeletonRenderer extends DomRenderer {
  private readonly pageMap: Map<string, HTMLImageElement>;
  /** `SkeletonFrame.clipsIgnored` of the last frame drawn. */
  clipsIgnored = 0;
  /**
   * Slots appended to every frame after the skeleton's own. The clipping
   * probes use one that draws nothing (its region has no bitmap) and that no
   * clip covers: the renderer takes the whole-skeleton root path only for a
   * clip that covers every slot of the frame, and this keeps a clip that
   * covers every *drawn* slot on the per-element path those probes measure.
   */
  trailing: PosedSlot[] = [];

  constructor(root: HTMLElement, regionImages: ReadonlyMap<string, RegionImage>) {
    const pages = new Map<string, HTMLImageElement>();
    super(root, regionImages, pages);
    this.pageMap = pages;
  }

  renderSkeleton(skeleton: Skeleton): void {
    const read = frameOfSkeleton(skeleton);
    for (const [name, image] of read.pages) this.pageMap.set(name, image);
    this.clipsIgnored = read.clipsIgnored;
    this.render(this.trailing.length ? { order: [...read.frame.order, ...this.trailing] } : read.frame);
  }
}

// --- a Spine export's loader, for the specs that draw spineboy ---------------

export interface SpineAssetsOptions {
  atlasUrl: string;
  /** Maps a page name to its image URL; defaults to resolving it against the atlas URL. */
  resolvePage?: (pageName: string, atlasUrl: string) => string;
  skeletonUrl?: string;
  scale?: number;
}

export interface SpineAssets {
  atlas: TextureAtlas;
  data: SkeletonData;
  regionImages: Map<string, RegionImage>;
  pageImages: Map<string, HTMLImageElement>;
  dispose(): void;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = url;
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

/** Reads a skeleton JSON export against a parsed atlas whose pages carry their textures. */
export async function loadSkeletonJson(atlas: TextureAtlas, url: string, scale?: number): Promise<SkeletonData> {
  const json = new SkeletonJson(new AtlasAttachmentLoader(atlas));
  if (scale !== undefined) json.scale = scale;
  return json.readSkeletonData(await fetchText(url));
}

/** Fetches an atlas export, attaches its page images, unpacks its regions, and reads a skeleton against it. */
export async function loadSpineAssets(options: SpineAssetsOptions): Promise<SpineAssets> {
  const atlas = new TextureAtlas(await fetchText(options.atlasUrl));
  const pageImages = new Map<string, HTMLImageElement>();
  await Promise.all(
    atlas.pages.map(async (page) => {
      const url = options.resolvePage
        ? options.resolvePage(page.name, options.atlasUrl)
        : new URL(page.name, new URL(options.atlasUrl, document.baseURI)).href;
      const image = await loadImage(url);
      page.setTexture(new DomTexture(image));
      pageImages.set(page.name, image);
    }),
  );
  const regionImages = await unpackAtlas(atlas, pageImages);
  const data = options.skeletonUrl
    ? await loadSkeletonJson(atlas, options.skeletonUrl, options.scale)
    : (null as unknown as SkeletonData);
  return {
    atlas,
    data,
    regionImages,
    pageImages,
    dispose: () => revokeRegions(regionImages),
  };
}
