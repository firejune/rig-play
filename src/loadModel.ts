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
  /**
   * URL of the attachment-sets sidecar (`sets.json`, spec `spine-parts-sets/1`
   * or `rig-parts-sets/1`). When omitted, `loadModel` probes `sets.json` in
   * the model document's directory and treats a 404 as "no sets". Pass `null`
   * to skip the probe, or a string URL to require a `sets.json` at that path.
   */
  setsUrl?: string | null;
}

/** `LoadModelOptions.regions`: how, or whether, the regions are cut. */
export type RegionLoading = 'blob' | 'data' | 'none';

/**
 * One attachment set read from `sets.json` (`spine-parts-sets/1` or
 * `rig-parts-sets/1`): the slots it replaces (`slots`, slot name → attachment
 * name) and the slots it clears (`hides`).
 */
export interface RigSet {
  readonly name: string;
  /** Map from slot name to the attachment name the set puts on that slot. */
  readonly slots: Readonly<Record<string, string>>;
  /** Slots the set hides (`null` attachment while the set is active). */
  readonly hides: readonly string[];
}

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
   * Every attachment set read from `sets.json` (`spine-parts-sets/1` or
   * `rig-parts-sets/1`), in declaration order; empty when the build has no
   * `sets.json`.
   */
  readonly sets: readonly RigSet[];
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

const SETS_SPECS = ['spine-parts-sets/1', 'rig-parts-sets/1'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates a `sets.json` sidecar (`spine-parts-sets/1` or
 * `rig-parts-sets/1`) against `doc`'s slots and skin attachments.
 *
 * @internal Shared with the loader below; not part of the package API.
 */
export function readSetsText(text: string, where: string, doc: CompiledDocument): readonly RigSet[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}: not JSON — ${(error as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new Error(`${where}: sets document must be a JSON object`);
  }
  if (raw.spec !== SETS_SPECS[0] && raw.spec !== SETS_SPECS[1]) {
    throw new Error(
      `${where}: spec is ${JSON.stringify(raw.spec)}, not "${SETS_SPECS[0]}" or "${SETS_SPECS[1]}"`,
    );
  }
  if (!isRecord(raw.sets) && !Array.isArray(raw.sets)) {
    throw new Error(`${where}: "sets" must be an object or an array`);
  }
  const knownSlots = new Set(doc.slots.map((slot) => slot.name));
  const attachmentsBySlot = new Map<string, Set<string>>();
  for (const skin of doc.skins) {
    for (const [slotName, table] of Object.entries(skin.attachments)) {
      let set = attachmentsBySlot.get(slotName);
      if (!set) {
        set = new Set<string>();
        attachmentsBySlot.set(slotName, set);
      }
      for (const attName of Object.keys(table)) set.add(attName);
    }
  }

  const entries: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(raw.sets)) {
    for (let i = 0; i < raw.sets.length; i++) {
      const item = raw.sets[i];
      if (!isRecord(item) || typeof item.name !== 'string' || item.name.length === 0) {
        throw new Error(`${where}: sets[${i}] must be an object with a non-empty "name"`);
      }
      entries.push([item.name, item]);
    }
  } else {
    for (const [name, item] of Object.entries(raw.sets)) {
      if (name.length === 0 || !isRecord(item)) {
        throw new Error(`${where}: set "${name}" must be an object`);
      }
      entries.push([name, item]);
    }
  }

  const out: RigSet[] = [];
  const seenNames = new Set<string>();
  for (const [name, item] of entries) {
    if (seenNames.has(name)) {
      throw new Error(`${where}: duplicate set "${name}"`);
    }
    seenNames.add(name);
    if (!isRecord(item.slots)) {
      throw new Error(`${where}: set "${name}" must have a "slots" object`);
    }
    const slots: Record<string, string> = {};
    for (const [slotName, attName] of Object.entries(item.slots)) {
      if (!knownSlots.has(slotName)) {
        throw new Error(`${where}: set "${name}" names unknown slot "${slotName}"`);
      }
      if (typeof attName !== 'string' || attName.length === 0) {
        throw new Error(`${where}: set "${name}" slot "${slotName}" attachment must be a non-empty string`);
      }
      if (!attachmentsBySlot.get(slotName)?.has(attName)) {
        throw new Error(`${where}: set "${name}" maps slot "${slotName}" to unknown attachment "${attName}"`);
      }
      slots[slotName] = attName;
    }
    const hides: string[] = [];
    if (item.hides !== undefined) {
      if (!Array.isArray(item.hides)) {
        throw new Error(`${where}: set "${name}" "hides" must be an array of slot names`);
      }
      for (const hidden of item.hides) {
        if (typeof hidden !== 'string' || hidden.length === 0) {
          throw new Error(`${where}: set "${name}" "hides" entries must be non-empty strings`);
        }
        if (!knownSlots.has(hidden)) {
          throw new Error(`${where}: set "${name}" hides unknown slot "${hidden}"`);
        }
        if (Object.prototype.hasOwnProperty.call(slots, hidden)) {
          throw new Error(`${where}: set "${name}" both replaces and hides slot "${hidden}"`);
        }
        if (!hides.includes(hidden)) hides.push(hidden);
      }
    }
    out.push(
      Object.freeze({
        name,
        slots: Object.freeze(slots),
        hides: Object.freeze(hides),
      }),
    );
  }
  return Object.freeze(out);
}

async function loadSets(
  fetchImpl: typeof globalThis.fetch,
  modelUrl: string,
  setsUrlOption: string | null | undefined,
  doc: CompiledDocument,
): Promise<readonly RigSet[]> {
  if (setsUrlOption === null) return Object.freeze([]);
  if (typeof setsUrlOption === 'string') {
    const text = await fetchText(fetchImpl, setsUrlOption);
    return readSetsText(text, setsUrlOption, doc);
  }
  const url = resolveAgainstModel('sets.json', modelUrl);
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch {
    return Object.freeze([]);
  }
  if (!response.ok) return Object.freeze([]);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) return Object.freeze([]);
  const text = await response.text();
  const trimmed = text.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith('<')) return Object.freeze([]);
  // When an unconfigured fetch double echoes the model document back for every URL,
  // ignore it rather than mistaking the model document for sets.json.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && typeof parsed.spec === 'string' && parsed.spec.startsWith('rigc-compiled/')) {
      return Object.freeze([]);
    }
  } catch {
    // Let readSetsText report malformed JSON in a real sets.json.
  }
  return readSetsText(text, url, doc);
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

  const sets = await loadSets(fetchImpl, modelUrl, options.setsUrl, read.doc);
  const regionImages = regions === 'none' ? new Map<string, RegionImage>() : await unpackRegions(pages, pageImages, { encoding: regions });

  let disposed = false;
  return {
    spec: read.spec,
    animations: read.doc.animations.map((a) => ({ name: a.name, duration: a.timelines.duration })),
    skins: read.doc.skins.map((s) => s.name),
    sets,
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
