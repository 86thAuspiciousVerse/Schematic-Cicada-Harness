/**
 * Semantic-model invariants checked at derivation time (4-spec §4). Structural
 * single-ownership (a pin in exactly one net) holds by construction of the
 * disjoint-group connectivity, so the checked violations are the ones that can
 * occur in practice: duplicate refdes and no-connect conflicts.
 */

import type { InvariantViolation, SemanticModel } from './types.ts'

/** Check invariants over a derived semantic model. */
export function checkInvariants(model: SemanticModel): InvariantViolation[] {
  const violations: InvariantViolation[] = []

  const refdesSeen = new Set<string>()
  for (const component of model.components) {
    if (refdesSeen.has(component.refdes)) {
      violations.push({ code: 'duplicate_refdes', message: `duplicate refdes: ${component.refdes}` })
    }
    refdesSeen.add(component.refdes)
  }

  const inNet = new Set<string>()
  for (const net of model.nets) {
    for (const member of net.members) inNet.add(`${member.refdes}.${member.pinName}`)
  }
  for (const nc of model.noConnects) {
    const id = `${nc.refdes}.${nc.pinName}`
    if (inNet.has(id)) {
      violations.push({
        code: 'no_connect_conflict',
        message: `pin ${id} is both connected and marked no-connect`,
      })
    }
  }

  return violations
}
