/**
 * Event types for sequence store
 */
export type SequenceEventType = 'create' | 'update' | 'delete'

/**
 * A sequenced event in the event log
 */
export interface SequenceEvent {
  seq: number
  did: string
  eventType: SequenceEventType
  collection: string
  rkey: string
  uri: string
  cid: string | null
  rev: string
  event: Buffer // CBOR-encoded event payload
  sequencedAt: string
}

/**
 * Options for querying events
 */
export interface GetEventsSinceOptions {
  limit?: number
  includeEvent?: boolean // Whether to include the CBOR event payload
}

/**
 * Port interface for reading sequence data
 */
export interface SequenceStoreReader {
  /** Get the latest sequence number */
  getLatestSeq(): Promise<number | null>

  /** Get events since a sequence number */
  getEventsSince(
    seq: number,
    options?: GetEventsSinceOptions,
  ): Promise<SequenceEvent[]>

  /** Get a single event by sequence number */
  getEvent(seq: number): Promise<SequenceEvent | null>

  /** Get events in a range */
  getEventsRange(
    startSeq: number,
    endSeq: number,
    options?: GetEventsSinceOptions,
  ): Promise<SequenceEvent[]>
}

/**
 * Input for appending an event (seq is auto-generated)
 */
export interface AppendEventInput {
  did: string
  eventType: SequenceEventType
  collection: string
  rkey: string
  uri: string
  cid: string | null
  rev: string
  event: Buffer
}

/**
 * Port interface for writing sequence data
 */
export interface SequenceStoreWriter extends SequenceStoreReader {
  /** Append a new event to the sequence log */
  appendEvent(event: AppendEventInput): Promise<number>

  /** Truncate events before a sequence number (for cleanup) */
  truncateBefore(seq: number): Promise<number>
}
