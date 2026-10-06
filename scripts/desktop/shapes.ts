// Apple's continuous-corner rounded rectangle (UIKit, the macOS icon grid, the iOS icon mask).

/** Control points of Apple's continuous corner (UIKit, macOS icon grid), in units of the corner radius. */
const CORNER = { e: 1.52866, c1: 1.08849, c2: 0.8684, m: 0.63149, n: 0.07491, q1: 0.37282, q2: 0.16906 }

export const num = (v: number) => (Math.round(v * 100) / 100).toString()

/** Apple's continuous-corner rounded rectangle as an SVG path, clockwise from the top edge. */
export function continuousRect(x: number, y: number, w: number, h: number, radius: number): string {
  const k = Object.fromEntries(Object.entries(CORNER).map(([key, v]) => [key, v * radius])) as typeof CORNER
  const r = x + w
  const b = y + h
  const p = (...xy: number[]) => xy.map(num).join(' ')
  return [
    `M${p(x + k.e, y)}H${num(r - k.e)}`,
    `C${p(r - k.c1, y, r - k.c2, y, r - k.m, y + k.n)}`,
    `C${p(r - k.q1, y + k.q2, r - k.q2, y + k.q1, r - k.n, y + k.m)}`,
    `C${p(r, y + k.c2, r, y + k.c1, r, y + k.e)}V${num(b - k.e)}`,
    `C${p(r, b - k.c1, r, b - k.c2, r - k.n, b - k.m)}`,
    `C${p(r - k.q2, b - k.q1, r - k.q1, b - k.q2, r - k.m, b - k.n)}`,
    `C${p(r - k.c2, b, r - k.c1, b, r - k.e, b)}H${num(x + k.e)}`,
    `C${p(x + k.c1, b, x + k.c2, b, x + k.m, b - k.n)}`,
    `C${p(x + k.q1, b - k.q2, x + k.q2, b - k.q1, x + k.n, b - k.m)}`,
    `C${p(x, b - k.c2, x, b - k.c1, x, b - k.e)}V${num(y + k.e)}`,
    `C${p(x, y + k.c1, x, y + k.c2, x + k.n, y + k.m)}`,
    `C${p(x + k.q2, y + k.q1, x + k.q1, y + k.q2, x + k.m, y + k.n)}`,
    `C${p(x + k.c2, y, x + k.c1, y, x + k.e, y)}Z`,
  ].join('')
}

/** Corner radius of the mask iOS puts on a home-screen icon, at 1024 px (22.5%). */
export const IOS_MASK_RADIUS = 230.4
