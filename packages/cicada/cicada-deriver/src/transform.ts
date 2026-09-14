/**
 * Shared pin transform — the single authority for symbol-local -> sheet
 * coordinates (9-impl §2.3, 8-spec §1.1, E21-B1). Used by the deriver and the
 * runtime tool layer; AI/users never call this (tool schemas carry no
 * coordinates).
 *
 * Library pin file values are already in KiCad's "internal" coordinate frame
 * with Y negated (`lib_cache.cpp:773` writes `-aPin->GetPosition().y`), so
 * `m = (localX, -localY)`; the world position is `Transform(m) + symbol pos`.
 * All arithmetic stays in G (0.01mm integers) — connectivity compares exact.
 */

import type { CoordG, Rotation } from './types.ts'

/** Rotation matrices applied to internal coordinates (no mirror support). */
const MATRIX: Readonly<Record<Rotation, readonly [number, number, number, number]>> = {
  0: [1, 0, 0, 1],
  90: [0, 1, -1, 0],
  180: [-1, 0, 0, -1],
  270: [0, -1, 1, 0],
}

function matrixOf(rotation: Rotation): readonly [number, number, number, number] {
  return MATRIX[rotation] ?? MATRIX[0]
}

/**
 * Compute the sheet (world) coordinate of a library pin for a symbol instance.
 * @param at - symbol position.
 * @param rotation - symbol rotation (0/90/180/270).
 * @param libPin - library pin position (file values, Y already negated).
 * @returns the world coordinate in G units.
 */
/** Normalize negative zero: `-0` and `0` must compare equal for coordinate keys. */
function nz(v: number): number {
  return v === 0 ? 0 : v
}

export function pinWorld(at: CoordG, rotation: Rotation, libPin: CoordG): CoordG {
  const m = { x: libPin.x, y: -libPin.y }
  const [a, b, c, d] = matrixOf(rotation)
  return {
    x: nz(at.x + (a * m.x + b * m.y)),
    y: nz(at.y + (c * m.x + d * m.y)),
  }
}

/**
 * Rotate an internal coordinate by the given rotation (pure helper, exported
 * for tests and the J-route geometry in the runtime).
 * @param rotation - rotation to apply.
 * @param m - internal coordinate.
 * @returns rotated internal coordinate.
 */
export function rotate(rotation: Rotation, m: CoordG): CoordG {
  const [a, b, c, d] = matrixOf(rotation)
  return { x: nz(a * m.x + b * m.y), y: nz(c * m.x + d * m.y) }
}
