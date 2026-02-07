import { CID } from 'multiformats/cid'

/**
 * Result of writing a stub to the PDS
 */
export interface WriteStubResult {
  /** AT-URI of the stub record on the PDS */
  uri: string
  /** CID of the stub record */
  cid: string
}

/**
 * Service for writing/deleting stub records on user's PDS
 * Stubs contain source fields that point to Stratos for hydration
 */
export interface StubWriterService {
  /**
   * Write a stub record to the user's PDS
   * @param did - User's DID
   * @param collection - Record collection NSID
   * @param rkey - Record key
   * @param recordType - Full $type of the record
   * @param fullRecordCid - CID of the full record in Stratos
   * @param createdAt - Timestamp from the full record
   */
  writeStub(
    did: string,
    collection: string,
    rkey: string,
    recordType: string,
    fullRecordCid: CID,
    createdAt: string,
  ): Promise<WriteStubResult>

  /**
   * Delete a stub record from the user's PDS
   * @param did - User's DID
   * @param collection - Record collection NSID
   * @param rkey - Record key
   */
  deleteStub(did: string, collection: string, rkey: string): Promise<void>
}
