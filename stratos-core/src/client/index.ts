/**
 * Client utilities for applications consuming Stratos services.
 *
 * This module provides verification and helper functions that client
 * applications use to validate records returned by a Stratos service.
 * It is NOT used by the Stratos service itself.
 */
export {
  isStratosAttestation,
  verifyStratosRecord,
  extractAttestation,
  type VerifyStratosRecordOptions,
  type VerifiedStratosRecord,
} from './verify.js'
