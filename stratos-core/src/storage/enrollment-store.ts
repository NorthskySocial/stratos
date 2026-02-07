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
  isEnrolled(did: string): Promise<boolean>

  /** Get enrollment record */
  getEnrollment(did: string): Promise<StoredEnrollment | null>

  /** List all enrollments */
  listEnrollments(options?: ListEnrollmentsOptions): Promise<StoredEnrollment[]>

  /** Count total enrollments */
  enrollmentCount(): Promise<number>

  /** Get boundaries for a user */
  getBoundaries(did: string): Promise<string[]>
}

/**
 * Port interface for writing enrollment data to storage.
 * Accepts StoredEnrollment with string dates.
 */
export interface EnrollmentStoreWriter extends EnrollmentStoreReader {
  /** Enroll a user */
  enroll(enrollment: StoredEnrollment): Promise<void>

  /** Unenroll a user */
  unenroll(did: string): Promise<void>

  /** Update enrollment (e.g., PDS endpoint) */
  updateEnrollment(
    did: string,
    updates: Partial<Omit<StoredEnrollment, 'did'>>,
  ): Promise<void>

  /** Set all boundaries for a user (replaces existing) */
  setBoundaries(did: string, boundaries: string[]): Promise<void>

  /** Add a single boundary for a user */
  addBoundary(did: string, boundary: string): Promise<void>

  /** Remove a single boundary from a user */
  removeBoundary(did: string, boundary: string): Promise<void>
}
