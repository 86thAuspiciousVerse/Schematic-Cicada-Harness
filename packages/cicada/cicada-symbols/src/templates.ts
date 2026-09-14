/**
 * Template symbol builders (4-spec §3.3 / 8-spec §2.3 & §5.2). Each builder
 * returns a canonical `lib_symbols` entry text plus the generated pin slots in
 * file order. All output follows the minimal-field conventions (boolean-style
 * `(hide yes)`, properties without effects, `cicada:` namespace).
 */

import type { CoordG, GeneratedPin, TemplateKind } from './types.ts'
import { mm } from './geometry.ts'

export interface TemplateSymbol {
  /** Full lib id, e.g. `cicada:R`. */
  libId: string
  /** Lib item name after the `cicada:` prefix. */
  name: string
  /** Canonical lib_symbols entry text. */
  text: string
  /** Generated pin slots in file order. */
  pins: GeneratedPin[]
}

const PIN_LEN = 254
const PITCH = 127

function pin(number: string, at: CoordG, angle: number, type = 'passive'): GeneratedPin {
  return { number, at, angle, length: PIN_LEN, type, shape: 'line' }
}

/** Two-pin symmetric template (R/C style): pins on the vertical axis. */
export function sym2(name: string, type = 'passive'): TemplateSymbol {
  const pins = [
    pin('1', { x: 0, y: 381 }, 270, type),
    pin('2', { x: 0, y: -381 }, 90, type),
  ]
  return templateSymbol(name, pins, `(rectangle (start -1.016 -2.54) (end 1.016 2.54))`, { pinNumbersHidden: true, pinNameOffset: 0 })
}

/** Two-pin polarized template (electrolytic/diode style); same pins as sym2, different graphics. */
export function polar2(name: string, type = 'passive'): TemplateSymbol {
  const pins = [
    pin('1', { x: 0, y: 381 }, 270, type),
    pin('2', { x: 0, y: -381 }, 90, type),
  ]
  return templateSymbol(name, pins, `(rectangle (start -1.27 -2.54) (end 1.27 2.54))`, { pinNumbersHidden: true, pinNameOffset: 0 })
}

/** Three-pin template (B/C/E style): two vertical + one on the right. */
export function tri(name: string, names: readonly string[]): TemplateSymbol {
  const at = (num: number): CoordG => (num === 3 ? { x: 508, y: 0 } : { x: 0, y: num === 1 ? 381 : -381 })
  const pins = [1, 2, 3].map((n) => ({ ...pin(String(n), at(n), n === 3 ? 180 : n === 1 ? 270 : 90), name: names[n - 1] ?? '' }))
  return templateSymbol(name, pins, `(rectangle (start -2.54 -2.54) (end 2.54 2.54))`, { pinNumbersHidden: false, pinNameOffset: 0 })
}

/** Connector 1×N template: N pins along the left edge of the box. */
export function connector(name: string, n: number): TemplateSymbol {
  if (n < 1) throw new RangeError(`connector: n must be >= 1, got ${n}`)
  const half = (n - 1) / 2
  const pins = Array.from({ length: n }, (_, i) => {
    const y = Math.round((half - i) * PITCH)
    return pin(String(i + 1), { x: -(762), y }, 0)
  })
  return templateSymbol(name, pins, `(rectangle (start -5.08 -${mm(Math.round((n * PITCH) / 2))}) (end 2.54 ${mm(Math.round((n * PITCH) / 2))}))`, { pinNumbersHidden: false, pinNameOffset: 0.508 })
}

/** Power template: `(power)` marker, one power_in pin at the origin (length 0), Value = net name. */
export function power(name: string): TemplateSymbol {
  const pins: GeneratedPin[] = [{ number: '1', at: { x: 0, y: 0 }, angle: 270, length: 0, type: 'power_in', shape: 'line' }]
  const libId = `cicada:${name}`
  const text = [
    `(symbol "${libId}" (power) (pin_numbers (hide yes)) (pin_names (offset 0) hide)`,
    `  (property "Reference" "#PWR" (at 0 -6.35 0))`,
    `  (property "Value" "${name}" (at 0 -3.81 0))`,
    `  (symbol "${name}_0_1"`,
    `    (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))))`,
    `  (symbol "${name}_1_1"`,
    `    (pin power_in line (at 0 0 270) (length 0) (name "~" ) (number "1" ))))`,
  ].join('\n')
  return { libId, name, text, pins }
}

/** Build a template by kind. */
export function buildTemplate(kind: TemplateKind, name: string, opts: { names?: readonly string[]; n?: number; type?: string } = {}): TemplateSymbol {
  switch (kind) {
    case 'sym2':
      return sym2(name, opts.type ?? 'passive')
    case 'polar2':
      return polar2(name, opts.type ?? 'passive')
    case 'tri':
      return tri(name, opts.names ?? ['B', 'C', 'E'])
    case 'connector':
      return connector(name, opts.n ?? 4)
    case 'power':
      return power(name)
  }
}

function templateSymbol(name: string, pins: GeneratedPin[], graphics: string, opts: { pinNumbersHidden: boolean; pinNameOffset?: number }): TemplateSymbol {
  const libId = `cicada:${name}`
  const bodies = [
    `  (symbol "${name}_0_1"`,
    `    ${graphics})`,
    `  (symbol "${name}_1_1"`,
    ...pins.map((p) => `    (pin ${p.type} ${p.shape} (at ${mm(p.at.x)} ${mm(p.at.y)} ${p.angle}) (length ${mm(p.length)}) (name "${'name' in p && p.name ? p.name : ''}" ) (number "${p.number}" ))`),
    `  ))`,
  ]
  const hide = opts.pinNumbersHidden ? ' (hide yes)' : ''
  const offset = opts.pinNameOffset !== undefined ? ` (offset ${opts.pinNameOffset})` : ' (offset 0)'
  const text = [
    `(symbol "${libId}" (pin_numbers${hide}) (pin_names${offset})`,
    `  (property "Reference" "${name}" (at 2.032 0 90))`,
    `  (property "Value" "${name}" (at 0 0 90))`,
    ...bodies,
  ].join('\n')
  return { libId, name, text, pins }
}
