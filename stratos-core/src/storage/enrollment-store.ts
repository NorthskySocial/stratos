import type { Custody, SpacesCapability } from '../enrollment/types.js'

/**
 * Enrollment record as stored in the database.
 * Uses string dates for database compatibility.
 * See Enrollment in enrollment/types.ts for the domain type with Date objects.
 */
export interface StoredEnrollment {
  did: string
  enrolledAt: string
  pdsEndpoint?: string
  boundaries?: string[]
  signingKeyDid: string
  active: boolean
  enrollmentRkey?: string
  isService?: boolean
  /** Who hosts and signs this enrollment's repo. Defaults to 'stratos' when absent (pre-MM-03 rows). */
  custody?: Custody
  /** The repo host endpoint when custody is 'pds'. Undefined for 'stratos' custody. */
  repoHost?: string
  /**
   * The most recently observed capability probe verdict, from the last
   * enrolment or re-auth. Not authoritative on its own -- `custody` is the
   * value every write and read gate trusts -- but keeps the verdict a future
   * migration or audit pass can find, instead of it living only in a log line.
   */
  capabilityVerdict?: SpacesCapability
}

/**
 * Options for listing enrollments
 */
export interface ListEnrollmentsOptions {
  limit?: number
  cursor?: string
}

/**
 * Port interface for reading enrollment data from storage.
 * Returns StoredEnrollment with string dates.
 */
export interface EnrollmentStoreReader {
  /** Check if user is enrolled */
  isEnrolled: (did: string) => Promise<boolean>

  /** Get enrollment record */
  getEnrollment: (did: string) => Promise<StoredEnrollment | null>

  /** List all enrollments */
  listEnrollments: (
    options?: ListEnrollmentsOptions,
  ) => Promise<StoredEnrollment[]>

  /** List only active enrollments */
  listActiveEnrollments: (
    options?: ListEnrollmentsOptions,
  ) => Promise<StoredEnrollment[]>

  /** List only service enrollments */
  listServiceEnrollments: (
    options?: ListEnrollmentsOptions,
  ) => Promise<StoredEnrollment[]>

  /**
   * List active enrollments carrying a given boundary. This is a space's
   * member list: a space maps 1:1 to a boundary, so "who is a member of this
   * space" is "who has this boundary and is active". An indexed join, not a
   * `listEnrollments` scan filtered in memory.
   */
  listEnrollmentsByBoundary: (
    boundary: string,
    options?: ListEnrollmentsOptions,
  ) => Promise<StoredEnrollment[]>

  /** Count total enrollments */
  enrollmentCount: () => Promise<number>

  /** Get boundaries for a user */
  getBoundaries: (did: string) => Promise<string[]>
}

/**
 * Port interface for writing enrollment data to storage.
 * Accepts StoredEnrollment with string dates.
 */
export interface EnrollmentStoreWriter extends EnrollmentStoreReader {
  /** Enroll a user */
  enroll: (enrollment: StoredEnrollment) => Promise<void>

  /** Unenroll a user */
  unenroll: (did: string) => Promise<void>

  /** Update enrollment (e.g., PDS endpoint) */
  updateEnrollment: (
    did: string,
    updates: Partial<Omit<StoredEnrollment, 'did'>>,
  ) => Promise<void>

  /** Set all boundaries for a user (replaces existing) */
  setBoundaries: (did: string, boundaries: string[]) => Promise<void>

  /** Add a single boundary for a user */
  addBoundary: (did: string, boundary: string) => Promise<void>

  /** Remove a single boundary from a user */
  removeBoundary: (did: string, boundary: string) => Promise<void>
}
