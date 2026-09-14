/**
 * v1 graph-structure warnings (9-impl §1.7): unconnected pins, no-connect
 * conflicts, and nets with no members beyond a lone pin. Pure derivation;
 * warnings never block.
 */

import type { SchematicFile } from '@deepseek-ai/dsh-cicada-format'
import { derive, deriveConnectivity, memberKey } from '@deepseek-ai/dsh-cicada-deriver'

export type WarningCode = 'unconnected_pin' | 'no_connect_conflict' | 'single_member_net'

export interface Warning {
  code: WarningCode
  target: string
  message: string
}

/** Run the graph-structure checks over a parsed schematic. */
export function runChecks(file: SchematicFile): Warning[] {
  const warnings: Warning[] = []
  const view = derive(file)
  const conn = deriveConnectivity(file)
  const netKeys = new Set(view.nets.flatMap((net) => net.members.map(memberKey)))
  const ncKeys = new Set(view.noConnects.map((member) => memberKey(member)))

  for (const pin of conn.pins) {
    const key = memberKey(pin)
    if (netKeys.has(key)) continue
    if (ncKeys.has(key)) continue
    warnings.push({ code: 'unconnected_pin', target: key, message: `pin ${key} is not connected and has no no-connect marker` })
  }
  for (const member of view.noConnects) {
    const key = memberKey(member)
    if (netKeys.has(key)) {
      warnings.push({ code: 'no_connect_conflict', target: key, message: `pin ${key} is marked no-connect but belongs to a net` })
    }
  }
  for (const net of view.nets) {
    if (net.members.length === 1 && !net.labelled && !net.power) {
      warnings.push({ code: 'single_member_net', target: net.name, message: `net ${net.name} has a single member` })
    }
  }
  return warnings
}

/** Placeholder for the M2 ERC engine seam (KiCad ERC subset). */
export interface ErcEngine {
  run(file: SchematicFile): Warning[]
}

let engine: ErcEngine | undefined

/** Set the external ERC engine (M2+); clears back to the built-in checks. */
export function setErcEngine(next?: ErcEngine): void {
  engine = next
}

/** Run checks through the active engine (built-in by default). */
export function run(file: SchematicFile): Warning[] {
  return engine === undefined ? runChecks(file) : engine.run(file)
}
