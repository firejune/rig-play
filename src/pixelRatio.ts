/**
 * The one forced layout both renderers share: how many device pixels one of
 * the root's CSS pixels covers on screen, read off a throwaway box.
 *
 * A renderer rasters at `world × pixelRatio` in the root's own coordinates,
 * so a `transform: scale(z)` on an ancestor — how a pan/zoom stage is built —
 * oversamples by 1/z² in backing pixels unless the zoom is folded into the
 * ratio. Neither renderer measures this on its own: it is a layout read, and
 * there is no per-frame layout read anywhere in this library. The caller
 * invokes `syncPixelRatio()` when a zoom or a resize settles.
 */

/** Edge length of the throwaway box the root is measured with. */
const SCALE_PROBE_PX = 100;
/**
 * Relative change below which the ratio is left alone. Layout reads are
 * quantized (1/64 px in Blink), so a 100 px probe carries ~0.016% of
 * measurement noise — 6× under this band, which in turn is 10× under the
 * smallest zoom step a UI realistically takes (1%). Inside the band the
 * sampling error is worth ~0.2% of backing pixels; outside it, a rewrite of
 * `pixelRatio` recreates every canvas's GPU surface.
 */
const PIXEL_RATIO_DEADBAND = 1e-3;

/**
 * Measures `root`'s effective on-screen scale once and returns the ratio now
 * in effect: `devicePixelRatio × scale` when that differs from `current` by
 * more than the deadband, else `current` unchanged. A root that is not laid
 * out (a `display: none` ancestor, a detached root) measures nothing, so
 * nothing is decided and `current` comes back. Appends a hidden box to the
 * root, reads its rect, removes it — the root's children are the same
 * elements in the same order on both sides of the call.
 */
export function syncedPixelRatio(root: HTMLElement, current: number): number {
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.left = '0';
  probe.style.top = '0';
  probe.style.width = `${SCALE_PROBE_PX}px`;
  probe.style.height = `${SCALE_PROBE_PX}px`;
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  root.appendChild(probe);
  let width = 0;
  let height = 0;
  try {
    const rect = probe.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  } finally {
    probe.remove();
  }

  const scale = Math.max(width, height) / SCALE_PROBE_PX;
  if (!(scale > 0)) return current;

  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const next = dpr * scale;
  if (current > 0 && Math.abs(next - current) < current * PIXEL_RATIO_DEADBAND) return current;
  return next;
}
