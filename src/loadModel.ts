import { type CompiledDocument, CORE_DOCUMENT_SPECS, CoreInputError, readModel } from 'rig-c/core';
import { type RegionImage, revokeRegions, unpackRegions } from './DomTexture.js';

/**
 * Loads a rig built by `rigc build`: the compiled model document
 * (`skeleton.model.json`, spec `rigc-compiled/3`) and the page images its
 * `pages` section names, cut into region bitmaps once.
 *
 * The document states everything the player reads — the skeleton, the
 * animations, and where every region sits on its page — so the `.atlas` and
 * `skeleton.json` the build writes beside it are not fetched. A Spine export
 * (`.json`, `.skel`) is refused by name: this package poses the compiled model
 * through `rig-c/core` and reads nothing else.
 */

export interface LoadModelOptions {
  /** URL of the compiled model document (`skeleton.model.json`). */
  modelUrl: string;
  /**
   * Maps a page name from the document's `pages` section to the URL its image
   * lives at. Defaults to resolving the name against the model URL's
   * directory: a build writes page names as paths relative to its own
   * directory, which is where the document sits.
   */
  resolvePage?: (pageName: string, modelUrl: string) => string;
  /**
   * crossOrigin attribute for the page images. Needed when the images come
   * from another origin: the region cut reads them into a canvas, and a
   * tainted canvas cannot be exported (SecurityError from toBlob).
   */
  crossOrigin?: string;
  /** fetch implementation, for custom headers or a test double. */
  fetch?: typeof globalThis.fetch;
  /**
   * What the region cut produces — the rigid tier's per-region bitmaps, which
   * only the DOM mode draws. `'blob'` (the default): `blob:` URLs the load
   * owns and `dispose` frees. `'data'`: `data:` URLs, for a content policy or
   * a snapshot that does not carry `blob:`; nothing to free. `'none'`: no cut
   * at all, for a load that only ever draws in the canvas mode — the pages
   * are loaded, `regionImages` is empty, and a DOM-mode player opened on the
   * assets is refused by name.
   */
  regions?: RegionLoading;
}

/** `LoadModelOptions.regions`: how, or whether, the regions are cut. */
export type RegionLoading = 'blob' | 'data' | 'none';

/**
 * What `new RigPlayer(root, assets)` draws from. The caller owns it: one load
 * can back any number of players, and nothing a player does disposes it.
 */
export interface ModelAssets {
  /** The document's spec, e.g. `rigc-compiled/3`. */
  readonly spec: string;
  /** Every animation the document carries, in its order, with the runtime's duration. */
  readonly animations: ReadonlyArray<{ readonly name: string; readonly duration: number }>;
  /** Every skin the document declares, in its order. */
  readonly skins: readonly string[];
  /**
   * The document's `stage` section, in world units (Y up): the stage the
   * build declared — the rig's own framing, for laying out a stage — or null
   * where the document has none. Where its value comes from is rigc's rule,
   * not this package's (rigc `docs/AUTHORING.md`, *Where the rebuild's stage
   * comes from*): a source that states a stage is written as stated, and a
   * source that states none gets the setup pose's bounding box in its place.
   * So one rig's `stage` is a declared frame and another's is a box, and the
   * field does not say which. For the box of what a pose draws, read
   * `player.bounds()`.
   */
  readonly stage: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  /** How the regions were cut (`LoadModelOptions.regions`): `'none'` means `regionImages` is empty and only the canvas mode can draw. */
  readonly regions: RegionLoading;
  /** Unpacked per-region bitmaps, keyed by region name — the rigid tier's. Empty on a `regions: 'none'` load. */
  readonly regionImages: Map<string, RegionImage>;
  /** Page images, keyed by the document's page names — the mesh tier's. */
  readonly pageImages: Map<string, HTMLImageElement>;
  /**
   * The document as `rig-c/core` read it. Opaque to callers: the player poses
   * it, and its shape is rig-c's, not this package's.
   */
  readonly document: ModelDocument;
  /**
   * Frees the blob URLs this load created (see revokeRegions). Idempotent.
   * Call it after the players drawing from these assets are disposed — a live
   * <img> would be left pointing at a dead URL.
   */
  dispose(): void;
}

/** The read document, held for the player. Deliberately opaque. */
export interface ModelDocument {
  readonly spec: string;
}

/** @internal What the player reads off `ModelAssets.document`. */
export interface ReadDocument extends ModelDocument {
  readonly doc: CompiledDocument;
  /** The document's parsed JSON — the sequences' `start`/`digits`, which `readModel` does not keep, are read off it. */
  readonly parsed: unknown;
}

function stageOf(doc: CompiledDocument): ModelAssets['stage'] {
  const stage = doc.stated?.stage;
  return stage ? { x: stage.x, y: stage.y, width: stage.width, height: stage.height } : null;
}

function resolveAgainstModel(pageName: string, modelUrl: string): string {
  return new URL(pageName, new URL(modelUrl, document.baseURI)).href;
}

async function fetchText(fetchImpl: typeof globalThis.fetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

function loadImage(url: string, crossOrigin?: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin !== undefined) image.crossOrigin = crossOrigin;
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load page image: ${url}`));
    image.src = url;
  });
}

/** The URL's path without its query or fragment, lower-cased — what the export check reads. */
function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0].toLowerCase();
}

/**
 * Reads a model document's text, refusing by name what this package does not
 * read: a Spine export, a document whose spec `rig-c/core` does not read, and a
 * document without a `pages` section (`rigc-compiled/1`).
 *
 * @internal Shared with the loader below; not part of the package API.
 */
export function readModelText(text: string, where: string): ReadDocument {
  let doc: CompiledDocument;
  try {
    doc = readModel(text, where);
  } catch (error) {
    if (error instanceof CoreInputError) {
      throw new CoreInputError(`${error.message} — build it with \`rigc build\``);
    }
    throw error;
  }
  if (doc.pages === null) {
    throw new CoreInputError(
      `${where}: a ${doc.spec} document does not state where each region sits on its page — build it with \`rigc build\``,
    );
  }
  return { spec: doc.spec, doc, parsed: JSON.parse(text) as unknown };
}

/**
 * Loads a rig built by `rigc build`.
 *
 * ```ts
 * const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
 * const player = new RigPlayer(root, assets);
 * player.play('walk');
 * // each frame: player.frame(dt)
 * // …later: player.dispose(); assets.dispose();
 * ```
 *
 * Page images load in parallel. If anything fails part-way, no blob URL is
 * left behind.
 */
export async function loadModel(options: LoadModelOptions): Promise<ModelAssets> {
  const { modelUrl, crossOrigin } = options;
  const path = pathOf(modelUrl);
  if (path.endsWith('.skel') || (path.endsWith('.json') && !path.endsWith('.model.json'))) {
    throw new CoreInputError(
      `${modelUrl} is a Spine export; this player reads a compiled model document (${CORE_DOCUMENT_SPECS[0]}, skeleton.model.json) — build it with \`rigc build\``,
    );
  }
  const regions = options.regions ?? 'blob';
  if (regions !== 'blob' && regions !== 'data' && regions !== 'none') {
    throw new Error(`regions must be 'blob', 'data' or 'none', got ${String(options.regions)}`);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const resolvePage = options.resolvePage ?? resolveAgainstModel;

  const read = readModelText(await fetchText(fetchImpl, modelUrl), modelUrl);
  const pages = read.doc.pages ?? [];
  const pageImages = new Map<string, HTMLImageElement>();
  await Promise.all(
    pages.map(async (page) => {
      pageImages.set(page.name, await loadImage(resolvePage(page.name, modelUrl), crossOrigin));
    }),
  );

  const regionImages = regions === 'none' ? new Map<string, RegionImage>() : await unpackRegions(pages, pageImages, { encoding: regions });

  let disposed = false;
  return {
    spec: read.spec,
    animations: read.doc.animations.map((a) => ({ name: a.name, duration: a.timelines.duration })),
    skins: read.doc.skins.map((s) => s.name),
    stage: stageOf(read.doc),
    regions,
    regionImages,
    pageImages,
    document: read,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revokeRegions(regionImages);
    },
  };
}
