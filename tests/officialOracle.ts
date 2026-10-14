/** Development-only official raster adapter. Never imported by src/index.ts. */
import {
  AnimationState, AnimationStateData, AtlasAttachmentLoader, GLTexture,
  ManagedWebGLRenderingContext, Physics, SceneRenderer, Skeleton, SkeletonJson,
  TextureAtlas, type SkeletonData,
} from '@esotericsoftware/spine-webgl';
import { physicsClockStep } from 'rig-c/core';

export interface OracleViewport {
  width: number;
  height: number;
  originX: number;
  originY: number;
  scale: number;
  pixelRatio?: number;
}

export interface OfficialAssets {
  data: SkeletonData;
  generation: string;
  jsonSha256: string;
  pages: Array<{ name: string; pma: boolean; width: number; height: number }>;
}

export interface OfficialPoseOptions {
  animation: string;
  loop: boolean;
  skin?: string;
  color?: [number, number, number, number];
}

export class OfficialInstance {
  readonly skeleton: Skeleton;
  readonly state: AnimationState;

  constructor(assets: OfficialAssets, options: OfficialPoseOptions) {
    this.skeleton = new Skeleton(assets.data);
    if (options.skin !== undefined) this.skeleton.setSkin(options.skin);
    this.skeleton.setupPose();
    if (options.color) this.skeleton.color.set(...options.color);
    this.state = new AnimationState(new AnimationStateData(assets.data));
    this.state.setAnimation(0, options.animation, options.loop);
    this.state.apply(this.skeleton);
    this.skeleton.update(0);
    this.skeleton.updateWorldTransform(Physics.reset);
  }

  advance(dt: number, physicsDt = physicsClockStep(dt)): void {
    this.state.update(dt);
    this.state.apply(this.skeleton);
    this.skeleton.update(physicsDt);
    this.skeleton.updateWorldTransform(Physics.update);
  }
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`official oracle ${url}: HTTP ${response.status}`);
  return response.text();
}

/** One context/batcher for a grid; independent-player benches create one per cell. */
export class OfficialOracle {
  readonly context: ManagedWebGLRenderingContext;
  readonly renderer: SceneRenderer;
  private readonly assets = new Map<string, Promise<OfficialAssets>>();
  private readonly textures: GLTexture[] = [];
  private triangles = 0;

  constructor(readonly canvas: HTMLCanvasElement, viewport: OracleViewport,
    options: { preserveDrawingBuffer?: boolean } = {}) {
    this.context = new ManagedWebGLRenderingContext(canvas, {
      alpha: true, premultipliedAlpha: true, antialias: false,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
    });
    this.renderer = new SceneRenderer(canvas, this.context, true);
    // Transparent captures retain additive coverage instead of folding its
    // RGB into a zero-alpha normal batch. This is the official supported knob.
    this.renderer.skeletonRenderer.pmaAdditiveBatching = false;
    const draw = this.renderer.batcher.draw.bind(this.renderer.batcher);
    this.renderer.batcher.draw = (texture, vertices, indices) => {
      this.triangles += indices.length / 3;
      draw(texture, vertices, indices);
    };
    this.setViewport(viewport);
  }

  setViewport(viewport: OracleViewport): void {
    const { width, height, originX, originY, scale, pixelRatio = 1 } = viewport;
    if (![width, height, originX, originY, scale, pixelRatio].every(Number.isFinite)
      || width <= 0 || height <= 0 || scale <= 0 || pixelRatio <= 0) throw new Error('invalid official oracle viewport');
    this.canvas.width = Math.round(width * pixelRatio);
    this.canvas.height = Math.round(height * pixelRatio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.renderer.camera.setViewport(width / scale, height / scale);
    this.renderer.camera.position.set((width / 2 - originX) / scale, (originY - height / 2) / scale, 0);
    this.context.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  load(pair: { jsonUrl: string; atlasUrl: string; pageUrls?: Record<string, string> }): Promise<OfficialAssets> {
    const key = JSON.stringify(pair);
    const existing = this.assets.get(key);
    if (existing) return existing;
    const loaded = (async (): Promise<OfficialAssets> => {
      const [jsonText, atlasText] = await Promise.all([fetchText(pair.jsonUrl), fetchText(pair.atlasUrl)]);
      const json = JSON.parse(jsonText) as { skeleton?: { spine?: string } };
      const generation = json.skeleton?.spine;
      if (generation !== '4.3.13') throw new Error(`official oracle requires Spine 4.3.13, found ${String(generation)}`);
      const atlas = new TextureAtlas(atlasText);
      for (const page of atlas.pages) {
        const image = new Image();
        image.src = pair.pageUrls?.[page.name] ?? new URL(page.name, new URL(pair.atlasUrl, location.href)).href;
        await image.decode();
        if (page.width <= 0 || page.height <= 0
          || page.width !== image.naturalWidth || page.height !== image.naturalHeight) {
          throw new Error(`official oracle page ${page.name}: declared ${page.width}x${page.height}, decoded ${image.naturalWidth}x${image.naturalHeight}`);
        }
        // Independently decode original PNGs and use the original atlas pma
        // flag. GLTexture 4.3 uploads with UNPACK_PREMULTIPLY_ALPHA = !pma.
        const texture = new GLTexture(this.context, image, page.pma);
        texture.setFilters(page.minFilter, page.magFilter);
        texture.setWraps(page.uWrap, page.vWrap);
        page.setTexture(texture);
        this.textures.push(texture);
      }
      const reader = new SkeletonJson(new AtlasAttachmentLoader(atlas));
      const data = reader.readSkeletonData(json);
      return {
        data, generation, jsonSha256: await sha256(jsonText),
        pages: atlas.pages.map(({ name, pma, width, height }) => ({ name, pma, width, height })),
      };
    })();
    this.assets.set(key, loaded);
    return loaded;
  }

  createInstance(assets: OfficialAssets, options: OfficialPoseOptions): OfficialInstance {
    return new OfficialInstance(assets, options);
  }

  draw(entries: Array<{ instance: OfficialInstance; offsetX?: number; offsetY?: number }>): { drawCalls: number; triangles: number; skeletons: number } {
    const gl = this.context.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.triangles = 0;
    this.renderer.begin();
    for (const { instance, offsetX = 0, offsetY = 0 } of entries) {
      this.renderer.drawSkeleton(instance.skeleton, -1, -1, offsetX || offsetY ? (vertices, count, stride) => {
        for (let i = 0; i < count; i += stride) {
          vertices[i] += offsetX;
          vertices[i + 1] += offsetY;
        }
      } : null);
    }
    this.renderer.end();
    return { drawCalls: this.renderer.batcher.getDrawCalls(), triangles: this.triangles, skeletons: entries.length };
  }

  dispose(): void {
    this.renderer.dispose();
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.assets.clear();
    this.context.dispose();
  }
}
