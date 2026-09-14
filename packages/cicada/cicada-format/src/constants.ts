/**
 * Fixed protocol and format constants for Schematic-Cicada schematic files.
 *
 * The truth file is `.cicada_sch` at version {@link TRUTH_VERSION} (matching
 * KiCad's current `SEXPR_SCHEMATIC_FILE_VERSION`); exported copies are
 * `.kicad_sch` at {@link EXPORT_VERSION} (KiCad 9+ readable). Coordinates are
 * `G` = 0.01mm integers everywhere: `mm = G / 100`, and KiCad's internal
 * 100nm unit maps 0.01mm to exactly 100 IU.
 */

/** 0.01mm per unit of {@link G} is a scale of 1; this is the mm multiplier. */
export const MM_PER_G = 0.01

/** G units per mm (`mm = G / MM_PER_G`). */
export const G_PER_MM = 100

/** KiCad internal units per mm (`SCH_IU_PER_MM = 1e4`, 100nm). */
export const SCH_IU_PER_MM = 10_000

/** Internal units per G (0.01mm = 100 IU, exact). */
export const IU_PER_G = SCH_IU_PER_MM / G_PER_MM

/** Truth file version: current `SEXPR_SCHEMATIC_FILE_VERSION` (KiCad master). */
export const TRUTH_VERSION = 20260803

/** Export copy version: KiCad 9+ schematic format. */
export const EXPORT_VERSION = 20250114

/** Formats the truth file and its generator field with this identity. */
export const GENERATOR = 'cicada'

/** Generator version written into schematic files. */
export const GENERATOR_VERSION = '0.1'

/** Workspace-local directory for schematic artifacts. */
export const WORKSPACE_DIR = '.cicada'

/** Canonical truth file name under {@link WORKSPACE_DIR}. */
export const SCHEMATIC_FILE_NAME = 'schematic.cicada_sch'

/** Canonical export copy file name (KiCad 9+). */
export const EXPORT_FILE_NAME = 'schematic.kicad_sch'

/** Top-level tokens accepted in a `.cicada_sch` file; anything else fails closed. */
export const TOP_WHITELIST = [
  'version',
  'generator',
  'generator_version',
  'uuid',
  'paper',
  'title_block',
  'lib_symbols',
  'symbol',
  'wire',
  'junction',
  'label',
  'no_connect',
  'sheet_instances',
] as const

/** Schematic file versions this parser accepts. */
export const SUPPORTED_VERSIONS = [EXPORT_VERSION, TRUTH_VERSION] as const

/** Convert mm to G (0.01mm integer), rounding to root out float drift. */
export function mmToG(mm: number): number {
  const g = Math.round(mm * G_PER_MM)
  return g === 0 ? 0 : g
}

/** Format G as a two-decimal mm string (grid-aligned values never exceed 2 decimals). */
export function gToMm(g: number): string {
  return (g * MM_PER_G).toFixed(2)
}
