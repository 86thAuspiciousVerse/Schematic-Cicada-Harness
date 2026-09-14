/**
 * IC pin geometry: deterministic four-edge even distribution (8-spec §2.5).
 *
 * All returned coordinates are integer G (0.01mm). Pitch 1.27mm, pin length
 * 2.54mm, margin 1.27mm. Library file semantics: pin `at` is the connectable
 * outer end, `length` extends toward the body, angle points toward the body
 * (top=270, right=180, bottom=90, left=0). Quantized symmetric offsets avoid
 * JS asymmetric rounding (±0.005mm max drift on graphics; connection points
 * stay self-consistent because all consumers read the same emitted mm text).
 */

import { G_PER_MM } from '@deepseek-ai/dsh-cicada-format'

import type { CoordG, G, GeneratedPin, IcGeometry, Side } from './types.ts'

const PITCH_G = 127
const PIN_LEN_G = 254
const MARGIN_G = 127

/** Assign pins to the four sides (physical number ascending, counter-clockwise, Y-down screen space). */
export function assignSides(n: number): Record<Side, number> {
  const perSide = Math.ceil(n / 4)
  const t = Math.min(perSide, n)
  const r = Math.min(perSide, n - t)
  const b = Math.min(perSide, n - t - r)
  const l = n - t - r - b
  return { top: t, right: r, bottom: b, left: l }
}

/** Final box geometry for n pins (size made even so the symmetric half is an integer G). */
export function icBox(n: number): IcGeometry {
  const perSide = Math.ceil(n / 4)
  const sides = assignSides(n)
  let size = (perSide - 1) * PITCH_G + 2 * MARGIN_G
  if (size % 2 !== 0) size += 1
  return { perSide, sides, width: size, height: size }
}

/** Symmetric quantized offsets around 0 for `count` pins at `pitch` G. */
function symmetricOffsets(count: number, pitch: G): G[] {
  const offsets: G[] = []
  for (let i = 0; i < count; i++) {
    const center = i - (count - 1) / 2
    const g = Math.round(Math.abs(center) * pitch)
    offsets.push(center < 0 ? -g : g)
  }
  return offsets
}

/**
 * Generate pin slots for an n-pin IC (physical numbers `1..n`, electrical type
 * defaulting to `passive` — datasheet mapping fills types separately).
 * @param n - pin count (n >= 1).
 * @param typeOf - optional type per physical number.
 * @returns ordered pin slots (file order ascending).
 */
export function icPins(n: number, typeOf?: (number: string) => string): GeneratedPin[] {
  if (n < 1) throw new RangeError(`icPins: n must be >= 1, got ${n}`)
  const box = icBox(n)
  const halfH = box.height / 2
  const halfW = box.width / 2
  const pins: GeneratedPin[] = []
  const type = (num: string): string => typeOf?.(num) ?? 'passive'

  const { top, right, bottom, left } = box.sides
  const topXs = symmetricOffsets(top, PITCH_G)
  const rightYs = symmetricOffsets(right, PITCH_G)
  const bottomXs = symmetricOffsets(bottom, PITCH_G)
  const leftYs = symmetricOffsets(left, PITCH_G)

  let number = 1
  const push = (at: CoordG, angle: number): void => {
    pins.push({ number: String(number++), at, angle, length: PIN_LEN_G, type: type(String(number - 1)), shape: 'line' })
  }
  for (const x of topXs) push({ x, y: halfH + PIN_LEN_G }, 270)
  for (const y of rightYs) push({ x: halfW + PIN_LEN_G, y }, 180)
  for (const x of bottomXs) push({ x, y: -(halfH + PIN_LEN_G) }, 90)
  for (const y of leftYs) push({ x: -(halfW + PIN_LEN_G), y }, 0)

  return pins
}

/** mm string for G (two decimals), shared with template text builders. */
export function mm(g: G): string {
  return (g / G_PER_MM).toFixed(2)
}
