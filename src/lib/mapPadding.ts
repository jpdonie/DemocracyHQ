export interface MapPadding { top: number; right: number; bottom: number; left: number }

/**
 * Padding that always leaves room for the map. When the requested padding would leave less
 * than a third of the stage in a direction it is scaled down, because MapLibre refuses to
 * fit bounds into a negative area.
 */
export function safePadding(padding: MapPadding, container: { clientWidth: number; clientHeight: number }): MapPadding {
  const scale = (a: number, b: number, size: number): [number, number] => {
    const limit = size * (2 / 3);
    if (a + b <= limit || a + b === 0) return [a, b];
    const k = limit / (a + b);
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  const [top, bottom] = scale(padding.top, padding.bottom, container.clientHeight);
  const [left, right] = scale(padding.left, padding.right, container.clientWidth);
  return { top, right, bottom, left };
}
