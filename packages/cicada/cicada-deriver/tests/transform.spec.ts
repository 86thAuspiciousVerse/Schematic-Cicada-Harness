import { describe, expect, it } from 'vitest'

import { pinWorld, rotate } from '../src/transform.ts'
import type { CoordG, Rotation } from '../src/types.ts'

// R pin 1 at file (0, 3.81); pin 2 at (0, -3.81); symbol at (2540, 2540).
const P1: CoordG = { x: 0, y: 381 }
const P2: CoordG = { x: 0, y: -381 }
const AT: CoordG = { x: 2540, y: 2540 }

describe('transform', () => {
  it('matches the M0-3 empirical evidence (rot0, pin2 -> 25.4, 29.21)', () => {
    expect(pinWorld(AT, 0, P2)).toEqual({ x: 2540, y: 2921 })
  })

  it('computes all 8 orientations (4 rotations x 2 pins) at integer precision', () => {
    const expected: Record<Rotation, Record<string, CoordG>> = {
      0: { p1: { x: 2540, y: 2159 }, p2: { x: 2540, y: 2921 } },
      90: { p1: { x: 2159, y: 2540 }, p2: { x: 2921, y: 2540 } },
      180: { p1: { x: 2540, y: 2921 }, p2: { x: 2540, y: 2159 } },
      270: { p1: { x: 2921, y: 2540 }, p2: { x: 2159, y: 2540 } },
    }
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      expect(pinWorld(AT, rot, P1)).toEqual(expected[rot].p1)
      expect(pinWorld(AT, rot, P2)).toEqual(expected[rot].p2)
    }
  })

  it('rotates internal coordinates per the documented matrices', () => {
    expect(rotate(90, { x: 0, y: -381 })).toEqual({ x: -381, y: 0 })
    expect(rotate(270, { x: 0, y: -381 })).toEqual({ x: 381, y: 0 })
    expect(rotate(180, { x: 0, y: -381 })).toEqual({ x: 0, y: 381 })
  })
})
