import { computeEnrollmentActive } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'

export interface HoldChange {
  /** The new stored operator hold. Absent keeps the stored value. */
  operatorHold?: boolean
  /**
   * Replaces the label-log read for this one computation and is never stored.
   * Absent reads the label log.
   */
  takedownHold?: boolean
}

export interface EnrollmentHolds {
  active: boolean
  operatorHold: boolean
}

export type EnrollmentHoldsContext = Pick<
  AppContext,
  'enrollmentStore' | 'labelStore' | 'enrollmentEvents' | 'repoWriteLocks'
>

/**
 * Reads the takedown hold from the label log: the account's latest label is
 * a takedown. Account subject keys are the bare DID.
 */
export async function isAccountTakenDown(
  ctx: Pick<AppContext, 'labelStore'>,
  did: string,
): Promise<boolean> {
  const takedowns = await ctx.labelStore.latestTakedowns([did])
  return takedowns.has(did)
}

/**
 * Applies a change to a member's holds and recomputes `active`.
 *
 * An operator hold and a moderation takedown are independent, so neither
 * lifts the other. Returns null when the DID is not enrolled.
 */
export async function applyEnrollmentHolds(
  ctx: EnrollmentHoldsContext,
  did: string,
  change: HoldChange,
): Promise<EnrollmentHolds | null> {
  const release = await ctx.repoWriteLocks.acquire(did)
  try {
    const enrollment = await ctx.enrollmentStore.getEnrollment(did)
    if (!enrollment) return null

    const storedOperatorHold = enrollment.operatorHold ?? false
    const operatorHold = change.operatorHold ?? storedOperatorHold
    const takedownHold =
      change.takedownHold ?? (await isAccountTakenDown(ctx, did))
    const active = computeEnrollmentActive({ operatorHold, takedownHold })

    const updates: { active?: boolean; operatorHold?: boolean } = {}
    if (operatorHold !== storedOperatorHold) updates.operatorHold = operatorHold
    if (active !== enrollment.active) updates.active = active
    if (Object.keys(updates).length > 0) {
      await ctx.enrollmentStore.updateEnrollment(did, updates)
    }
    if (active !== enrollment.active) {
      ctx.enrollmentEvents.emit('activeChanged', { did })
    }

    return { active, operatorHold }
  } finally {
    release()
  }
}
