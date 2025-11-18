import DebugModule from "debug"
import { Store } from "@tanstack/store"
import { DeduplicatedLoadSubset } from "@tanstack/db"
import {
  ShapeStream,
  isChangeMessage,
  isControlMessage,
  isVisibleInSnapshot,
} from "@electric-sql/client"
import {
  ExpectedNumberInAwaitTxIdError,
  StreamAbortedError,
  TimeoutWaitingForMatchError,
  TimeoutWaitingForTxIdError,
} from "./errors"
import { compileSQL } from "./sql-compiler"
import { validateJsonSerializable } from "./persistanceAdapter"
import type {
  ControlMessage,
  GetExtensions,
  Message,
  Offset,
  PostgresSnapshot,
  Row,
  ShapeStreamOptions,
} from "@electric-sql/client"
import type { StorageApi } from "./persistanceAdapter"

import type {
  BaseCollectionConfig,
  CollectionConfig,
  DeleteMutationFnParams,
  Fn,
  InsertMutationFnParams,
  LoadSubsetOptions,
  SyncConfig,
  SyncMode,
  UpdateMutationFnParams,
  UtilsRecord,
} from "@tanstack/db"
import type { StandardSchemaV1 } from "@standard-schema/spec"

// Re-export for user convenience in custom match functions
export { isChangeMessage, isControlMessage } from "@electric-sql/client"

const debug = DebugModule.debug(`ts/db:electric`)

/**
 * Type representing a transaction ID in ElectricSQL
 */
export type Txid = number

/**
 * Custom match function type - receives stream messages and returns boolean
 * indicating if the mutation has been synchronized
 */
export type MatchFunction<T extends Row<unknown>> = (
  message: Message<T>
) => boolean

/**
 * Matching strategies for Electric synchronization
 * Handlers can return:
 * - Txid strategy: { txid: number | number[], timeout?: number } (recommended)
 * - Void (no return value) - mutation completes without waiting
 *
 * The optional timeout property specifies how long to wait for the txid(s) in milliseconds.
 * If not specified, defaults to 5000ms.
 */
export type MatchingStrategy = {
  txid: Txid | Array<Txid>
  timeout?: number
} | void

/**
 * Type representing a snapshot end message
 */
type SnapshotEndMessage = ControlMessage & {
  headers: { control: `snapshot-end` }
}
// The `InferSchemaOutput` and `ResolveType` are copied from the `@tanstack/db` package
// but we modified `InferSchemaOutput` slightly to restrict the schema output to `Row<unknown>`
// This is needed in order for `GetExtensions` to be able to infer the parser extensions type from the schema
type InferSchemaOutput<T> = T extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<T> extends Row<unknown>
    ? StandardSchemaV1.InferOutput<T>
    : Record<string, unknown>
  : Record<string, unknown>

/**
 * Configuration interface for Electric collection persistence
 * @template T - The type of items in the collection
 */
export interface ElectricPersistenceConfig {
  /**
   * The key to use for storing the collection data in localStorage/sessionStorage
   */
  storageKey: string

  /**
   * Storage API to use (defaults to window.localStorage)
   * Can be any object that implements the Storage interface (e.g., sessionStorage)
   */
  storage?: StorageApi
}
/** The mode of sync to use for the collection.
 * @default `eager`
 * @description
 * - `eager`:
 *   - syncs all data immediately on preload
 *   - collection will be marked as ready once the sync is complete
 *   - there is no incremental sync
 * - `on-demand`:
 *   - syncs data in incremental snapshots when the collection is queried
 *   - collection will be marked as ready immediately after the first snapshot is synced
 * - `progressive`:
 *   - syncs all data for the collection in the background
 *   - uses incremental snapshots during the initial sync to provide a fast path to the data required for queries
 *   - collection will be marked as ready once the full sync is complete
 */
export type ElectricSyncMode = SyncMode | `progressive`

/**
 * Configuration interface for Electric collection options
 * @template T - The type of items in the collection
 * @template TSchema - The schema type for validation
 */
export type ElectricCollectionConfig<
  T extends Row<unknown> = Row<unknown>,
  TSchema extends StandardSchemaV1 = never,
> = Omit<
  BaseCollectionConfig<T, string | number, TSchema, Record<string, Fn>, any>,
  `onInsert` | `onUpdate` | `onDelete` | `syncMode`
> & {
  /**
   * Configuration options for the ElectricSQL ShapeStream
   */
  shapeOptions: ShapeStreamOptions<GetExtensions<T>>

  /**
   * Optional persistence configuration for localStorage storage
   * When provided, data will be persisted to localStorage and loaded on startup
   */
  persistence?: ElectricPersistenceConfig
  syncMode?: ElectricSyncMode

  /**
   * Optional asynchronous handler function called before an insert operation
   * @param params Object containing transaction and collection information
   * @returns Promise resolving to { txid, timeout? } or void
   * @example
   * // Basic Electric insert handler with txid (recommended)
   * onInsert: async ({ transaction }) => {
   *   const newItem = transaction.mutations[0].modified
   *   const result = await api.todos.create({
   *     data: newItem
   *   })
   *   return { txid: result.txid }
   * }
   *
   * @example
   * // Insert handler with custom timeout
   * onInsert: async ({ transaction }) => {
   *   const newItem = transaction.mutations[0].modified
   *   const result = await api.todos.create({
   *     data: newItem
   *   })
   *   return { txid: result.txid, timeout: 10000 } // Wait up to 10 seconds
   * }
   *
   * @example
   * // Insert handler with multiple items - return array of txids
   * onInsert: async ({ transaction }) => {
   *   const items = transaction.mutations.map(m => m.modified)
   *   const results = await Promise.all(
   *     items.map(item => api.todos.create({ data: item }))
   *   )
   *   return { txid: results.map(r => r.txid) }
   * }
   *
   * @example
   * // Use awaitMatch utility for custom matching
   * onInsert: async ({ transaction, collection }) => {
   *   const newItem = transaction.mutations[0].modified
   *   await api.todos.create({ data: newItem })
   *   await collection.utils.awaitMatch(
   *     (message) => isChangeMessage(message) &&
   *                  message.headers.operation === 'insert' &&
   *                  message.value.name === newItem.name
   *   )
   * }
   */
  onInsert?: (params: InsertMutationFnParams<T>) => Promise<MatchingStrategy>

  /**
   * Optional asynchronous handler function called before an update operation
   * @param params Object containing transaction and collection information
   * @returns Promise resolving to { txid, timeout? } or void
   * @example
   * // Basic Electric update handler with txid (recommended)
   * onUpdate: async ({ transaction }) => {
   *   const { original, changes } = transaction.mutations[0]
   *   const result = await api.todos.update({
   *     where: { id: original.id },
   *     data: changes
   *   })
   *   return { txid: result.txid }
   * }
   *
   * @example
   * // Use awaitMatch utility for custom matching
   * onUpdate: async ({ transaction, collection }) => {
   *   const { original, changes } = transaction.mutations[0]
   *   await api.todos.update({ where: { id: original.id }, data: changes })
   *   await collection.utils.awaitMatch(
   *     (message) => isChangeMessage(message) &&
   *                  message.headers.operation === 'update' &&
   *                  message.value.id === original.id
   *   )
   * }
   */
  onUpdate?: (params: UpdateMutationFnParams<T>) => Promise<MatchingStrategy>

  /**
   * Optional asynchronous handler function called before a delete operation
   * @param params Object containing transaction and collection information
   * @returns Promise resolving to { txid, timeout? } or void
   * @example
   * // Basic Electric delete handler with txid (recommended)
   * onDelete: async ({ transaction }) => {
   *   const mutation = transaction.mutations[0]
   *   const result = await api.todos.delete({
   *     id: mutation.original.id
   *   })
   *   return { txid: result.txid }
   * }
   *
   * @example
   * // Use awaitMatch utility for custom matching
   * onDelete: async ({ transaction, collection }) => {
   *   const mutation = transaction.mutations[0]
   *   await api.todos.delete({ id: mutation.original.id })
   *   await collection.utils.awaitMatch(
   *     (message) => isChangeMessage(message) &&
   *                  message.headers.operation === 'delete' &&
   *                  message.value.id === mutation.original.id
   *   )
   * }
   */
  onDelete?: (params: DeleteMutationFnParams<T>) => Promise<MatchingStrategy>
}

function isUpToDateMessage<T extends Row<unknown>>(
  message: Message<T>
): message is ControlMessage & { up_to_date: true } {
  return isControlMessage(message) && message.headers.control === `up-to-date`
}

function isMustRefetchMessage<T extends Row<unknown>>(
  message: Message<T>
): message is ControlMessage & { headers: { control: `must-refetch` } } {
  return isControlMessage(message) && message.headers.control === `must-refetch`
}

function isSnapshotEndMessage<T extends Row<unknown>>(
  message: Message<T>
): message is SnapshotEndMessage {
  return isControlMessage(message) && message.headers.control === `snapshot-end`
}

function parseSnapshotMessage(message: SnapshotEndMessage): PostgresSnapshot {
  return {
    xmin: message.headers.xmin,
    xmax: message.headers.xmax,
    xip_list: message.headers.xip_list,
  }
}

// Check if a message contains txids in its headers
function hasTxids<T extends Row<unknown>>(
  message: Message<T>
): message is Message<T> & { headers: { txids?: Array<Txid> } } {
  return `txids` in message.headers && Array.isArray(message.headers.txids)
}

/**
 * Type for the awaitTxId utility function
 */
export type AwaitTxIdFn = (txId: Txid, timeout?: number) => Promise<boolean>

/**
 * Type for the clearPersistence utility function
 */
export type ClearPersistenceFn = () => Promise<void>

/**
 * Type for the getPersistenceSize utility function
 */
export type GetPersistenceSizeFn = () => Promise<number>
/**
 * Type for the awaitMatch utility function
 */
export type AwaitMatchFn<T extends Row<unknown>> = (
  matchFn: MatchFunction<T>,
  timeout?: number
) => Promise<boolean>

/**
 * Electric collection utilities type
 */
export interface ElectricCollectionUtils<T extends Row<unknown> = Row<unknown>>
  extends UtilsRecord {
  awaitTxId: AwaitTxIdFn
  awaitMatch: AwaitMatchFn<T>
}

/**
 * Electric collection utilities type with persistence
 */
export interface ElectricCollectionUtilsWithPersistence
  extends ElectricCollectionUtils {
  clearPersistence: ClearPersistenceFn
  getPersistenceSize: GetPersistenceSizeFn
}

export interface ElectricPersistenceConfig {
  storageKey: string
  storage?: StorageApi
}

// Envelope we persist to storage
type PersistedEnvelope<T> = {
  v: 1
  value: Record<string, T>
  lastOffset?: number
  shapeHandle?: string
}

function createPersistence<T>(cfg: ElectricPersistenceConfig) {
  const key = cfg.storageKey
  const storage =
    cfg.storage || (typeof window !== `undefined` ? window.localStorage : null)

  const safeParse = (raw: string | null): PersistedEnvelope<T> | null => {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === `object` && parsed.v === 1) {
        return parsed as PersistedEnvelope<T>
      }
      return null
    } catch {
      return null
    }
  }

  const read = (): PersistedEnvelope<T> | null => {
    if (!storage) return null
    return safeParse(storage.getItem(key))
  }

  const write = (next: PersistedEnvelope<T>) => {
    if (!storage) return
    storage.setItem(key, JSON.stringify(next))
  }

  const clear = () => {
    if (!storage) return
    storage.removeItem(key)
  }

  const size = (): number => {
    if (!storage) return 0
    const data = storage.getItem(key)
    return data ? new Blob([data]).size : 0
  }

  const saveCollectionSnapshot = (collection: any, stream?: any) => {
    if (!storage) return
    // 1) snapshot collection state
    const value: Record<string, T> = {}
    for (const [k, v] of collection.state) value[String(k)] = v as T

    // 2) load previous envelope (to preserve cursor when no stream present)
    const prev = read() ?? { v: 1, value: {} as Record<string, T> }

    // 3) only advance cursor if we’re called from the stream
    const lastOffset =
      (stream?.lastOffset as number | undefined) ?? prev.lastOffset
    const shapeHandle = stream?.shapeHandle ?? prev.shapeHandle

    const next: PersistedEnvelope<T> = { v: 1, value, lastOffset, shapeHandle }
    write(next)
  }

  const loadSnapshotInto = (
    begin: () => void,
    writeOp: (op: { type: `insert`; value: T }) => void,
    commit: () => void
  ) => {
    const env = read()
    if (!env?.value) return
    const entries = Object.entries(env.value)
    if (!entries.length) return
    begin()
    for (const [, row] of entries) {
      writeOp({ type: `insert`, value: row })
    }
    commit()
  }

  return {
    read,
    write,
    clear,
    size,
    saveCollectionSnapshot,
    loadSnapshotInto,
  }
}

/**
 * Creates Electric collection options for use with a standard Collection
 *
 * @template T - The explicit type of items in the collection (highest priority)
 * @template TSchema - The schema type for validation and type inference (second priority)
 * @template TFallback - The fallback type if no explicit or schema type is provided
 * @param config - Configuration options for the Electric collection
 * @returns Collection options with utilities
 */

// Overload for when schema is provided
export function electricCollectionOptions<T extends StandardSchemaV1>(
  config: ElectricCollectionConfig<InferSchemaOutput<T>, T> & {
    schema: T
  }
): CollectionConfig<InferSchemaOutput<T>, string | number, T> & {
  id?: string
  utils: ElectricCollectionUtils
  schema: T
}

// Overload for when no schema is provided
export function electricCollectionOptions<T extends Row<unknown>>(
  config: ElectricCollectionConfig<T> & {
    schema?: never // prohibit schema
  }
): CollectionConfig<T, string | number> & {
  id?: string
  utils: ElectricCollectionUtils
  schema?: never // no schema in the result
}

export function electricCollectionOptions(
  config: ElectricCollectionConfig<any, any>
): CollectionConfig<any, string | number, any> & {
  id?: string
  utils: ElectricCollectionUtils | ElectricCollectionUtilsWithPersistence
  schema?: any
} {
  const seenTxids = new Store<Set<Txid>>(new Set([]))
  const persistence =
    config.persistence && createPersistence<any>(config.persistence)

  const seenSnapshots = new Store<Array<PostgresSnapshot>>([])
  const internalSyncMode = config.syncMode ?? `eager`
  const finalSyncMode =
    internalSyncMode === `progressive` ? `on-demand` : internalSyncMode
  const pendingMatches = new Store<
    Map<
      string,
      {
        matchFn: (message: Message<any>) => boolean
        resolve: (value: boolean) => void
        reject: (error: Error) => void
        timeoutId: ReturnType<typeof setTimeout>
        matched: boolean
      }
    >
  >(new Map())

  // Buffer messages since last up-to-date to handle race conditions
  const currentBatchMessages = new Store<Array<Message<any>>>([])

  /**
   * Helper function to remove multiple matches from the pendingMatches store
   */
  const removePendingMatches = (matchIds: Array<string>) => {
    if (matchIds.length > 0) {
      pendingMatches.setState((current) => {
        const newMatches = new Map(current)
        matchIds.forEach((id) => newMatches.delete(id))
        return newMatches
      })
    }
  }

  /**
   * Helper function to resolve and cleanup matched pending matches
   */
  const resolveMatchedPendingMatches = () => {
    const matchesToResolve: Array<string> = []
    pendingMatches.state.forEach((match, matchId) => {
      if (match.matched) {
        clearTimeout(match.timeoutId)
        match.resolve(true)
        matchesToResolve.push(matchId)
        debug(
          `${config.id ? `[${config.id}] ` : ``}awaitMatch resolved on up-to-date for match %s`,
          matchId
        )
      }
    })
    removePendingMatches(matchesToResolve)
  }
  const sync = createElectricSync<any>(config.shapeOptions, {
    seenTxids,
    seenSnapshots,
    persistence: config.persistence,
    syncMode: internalSyncMode,
    pendingMatches,
    currentBatchMessages,
    removePendingMatches,
    resolveMatchedPendingMatches,
    collectionId: config.id,
  })

  /**
   * Wait for a specific transaction ID to be synced
   * @param txId The transaction ID to wait for as a number
   * @param timeout Optional timeout in milliseconds (defaults to 5000ms)
   * @returns Promise that resolves when the txId is synced
   */
  const awaitTxId: AwaitTxIdFn = async (
    txId: Txid,
    timeout: number = 5000
  ): Promise<boolean> => {
    debug(
      `${config.id ? `[${config.id}] ` : ``}awaitTxId called with txid %d`,
      txId
    )
    if (typeof txId !== `number`) {
      throw new ExpectedNumberInAwaitTxIdError(typeof txId, config.id)
    }

    // First check if the txid is in the seenTxids store
    const hasTxid = seenTxids.state.has(txId)
    if (hasTxid) return true

    // Then check if the txid is in any of the seen snapshots
    const hasSnapshot = seenSnapshots.state.some((snapshot) =>
      isVisibleInSnapshot(txId, snapshot)
    )
    if (hasSnapshot) return true

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        unsubscribeSeenTxids()
        unsubscribeSeenSnapshots()
        reject(new TimeoutWaitingForTxIdError(txId, config.id))
      }, timeout)

      const unsubscribeSeenTxids = seenTxids.subscribe(() => {
        if (seenTxids.state.has(txId)) {
          debug(
            `${config.id ? `[${config.id}] ` : ``}awaitTxId found match for txid %o`,
            txId
          )
          clearTimeout(timeoutId)
          unsubscribeSeenTxids()
          unsubscribeSeenSnapshots()
          resolve(true)
        }
      })

      const unsubscribeSeenSnapshots = seenSnapshots.subscribe(() => {
        const visibleSnapshot = seenSnapshots.state.find((snapshot) =>
          isVisibleInSnapshot(txId, snapshot)
        )
        if (visibleSnapshot) {
          debug(
            `${config.id ? `[${config.id}] ` : ``}awaitTxId found match for txid %o in snapshot %o`,
            txId,
            visibleSnapshot
          )
          clearTimeout(timeoutId)
          unsubscribeSeenSnapshots()
          unsubscribeSeenTxids()
          resolve(true)
        }
      })
    })
  }

  /**
   * Wait for a custom match function to find a matching message
   * @param matchFn Function that returns true when a message matches
   * @param timeout Optional timeout in milliseconds (defaults to 5000ms)
   * @returns Promise that resolves when a matching message is found
   */
  const awaitMatch: AwaitMatchFn<any> = async (
    matchFn: MatchFunction<any>,
    timeout: number = 3000
  ): Promise<boolean> => {
    debug(
      `${config.id ? `[${config.id}] ` : ``}awaitMatch called with custom function`
    )

    return new Promise((resolve, reject) => {
      const matchId = Math.random().toString(36)

      const cleanupMatch = () => {
        pendingMatches.setState((current) => {
          const newMatches = new Map(current)
          newMatches.delete(matchId)
          return newMatches
        })
      }

      const onTimeout = () => {
        cleanupMatch()
        reject(new TimeoutWaitingForMatchError(config.id))
      }

      const timeoutId = setTimeout(onTimeout, timeout)

      // We need access to the stream messages to check against the match function
      // This will be handled by the sync configuration
      const checkMatch = (message: Message<any>) => {
        if (matchFn(message)) {
          debug(
            `${config.id ? `[${config.id}] ` : ``}awaitMatch found matching message, waiting for up-to-date`
          )
          // Mark as matched but don't resolve yet - wait for up-to-date
          pendingMatches.setState((current) => {
            const newMatches = new Map(current)
            const existing = newMatches.get(matchId)
            if (existing) {
              newMatches.set(matchId, { ...existing, matched: true })
            }
            return newMatches
          })
          return true
        }
        return false
      }

      // Check against current batch messages first to handle race conditions
      for (const message of currentBatchMessages.state) {
        if (matchFn(message)) {
          debug(
            `${config.id ? `[${config.id}] ` : ``}awaitMatch found immediate match in current batch, waiting for up-to-date`
          )
          // Register match as already matched
          pendingMatches.setState((current) => {
            const newMatches = new Map(current)
            newMatches.set(matchId, {
              matchFn: checkMatch,
              resolve,
              reject,
              timeoutId,
              matched: true, // Already matched
            })
            return newMatches
          })
          return
        }
      }

      // Store the match function for the sync process to use
      // We'll add this to a pending matches store
      pendingMatches.setState((current) => {
        const newMatches = new Map(current)
        newMatches.set(matchId, {
          matchFn: checkMatch,
          resolve,
          reject,
          timeoutId,
          matched: false,
        })
        return newMatches
      })
    })
  }

  /**
   * Process matching strategy and wait for synchronization
   */
  const processMatchingStrategy = async (
    result: MatchingStrategy
  ): Promise<void> => {
    // Only wait if result contains txid
    if (result && `txid` in result) {
      const timeout = result.timeout
      // Handle both single txid and array of txids
      if (Array.isArray(result.txid)) {
        await Promise.all(result.txid.map((txid) => awaitTxId(txid, timeout)))
      } else {
        await awaitTxId(result.txid, timeout)
      }
    }
    // If result is void/undefined, don't wait - mutation completes immediately
  }

  // Create wrapper handlers for direct persistence operations that handle different matching strategies
  const wrappedOnInsert = config.onInsert
    ? async (params: InsertMutationFnParams<any>) => {
        // Validate that all values in the transaction can be JSON serialized (if persistence enabled)
        if (config.persistence) {
          params.transaction.mutations.forEach((m) =>
            validateJsonSerializable(m.modified, `insert`)
          )
        }

        const handlerResult = await config.onInsert!(params)
        await processMatchingStrategy(handlerResult)

        if (persistence) {
          // called outside stream -> snapshot rows, keep prior cursor
          persistence.saveCollectionSnapshot(params.collection)
        }

        return handlerResult
      }
    : undefined

  // Create wrapper handlers for direct persistence operations that handle txid awaiting
  const wrappedOnUpdate = config.onUpdate
    ? async (params: UpdateMutationFnParams<any>) => {
        // Validate that all values in the transaction can be JSON serialized (if persistence enabled)
        if (config.persistence) {
          params.transaction.mutations.forEach((m) =>
            validateJsonSerializable(m.modified, `update`)
          )
        }

        const handlerResult = await config.onUpdate!(params)
        await processMatchingStrategy(handlerResult)

        if (persistence) {
          persistence.saveCollectionSnapshot(params.collection)
        }

        return handlerResult
      }
    : undefined

  const wrappedOnDelete = config.onDelete
    ? async (params: DeleteMutationFnParams<any>) => {
        const handlerResult = await config.onDelete!(params)
        await processMatchingStrategy(handlerResult)

        // Persist to storage if configured
        if (persistence) {
          // Save collection state to localStorage
          persistence.saveCollectionSnapshot(params.collection)
        }

        return handlerResult
      }
    : undefined

  // eslint-disable-next-line @typescript-eslint/require-await
  const clearPersistence: ClearPersistenceFn = async () => {
    if (!persistence) {
      throw new Error(`Persistence is not configured for this collection`)
    }
    persistence.clear()
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  const getPersistenceSize: GetPersistenceSizeFn = async () =>
    persistence ? persistence.size() : 0

  // Extract standard Collection config properties
  const {
    shapeOptions: _shapeOptions,
    persistence: _persistence,
    onInsert: _onInsert,
    onUpdate: _onUpdate,
    onDelete: _onDelete,
    ...restConfig
  } = config

  // Build utils object based on whether persistence is configured
  const utils:
    | ElectricCollectionUtils
    | ElectricCollectionUtilsWithPersistence = persistence
    ? { awaitTxId, awaitMatch, clearPersistence, getPersistenceSize }
    : { awaitTxId, awaitMatch }

  return {
    ...restConfig,
    syncMode: finalSyncMode,
    sync,
    onInsert: wrappedOnInsert,
    onUpdate: wrappedOnUpdate,
    onDelete: wrappedOnDelete,
    utils,
  }
}

/**
 * Internal function to create ElectricSQL sync configuration
 */
function createElectricSync<T extends Row<unknown>>(
  shapeOptions: ShapeStreamOptions<GetExtensions<T>>,
  options: {
    syncMode: ElectricSyncMode
    seenTxids: Store<Set<Txid>>
    seenSnapshots: Store<Array<PostgresSnapshot>>
    pendingMatches: Store<
      Map<
        string,
        {
          matchFn: (message: Message<T>) => boolean
          resolve: (value: boolean) => void
          reject: (error: Error) => void
          timeoutId: ReturnType<typeof setTimeout>
          matched: boolean
        }
      >
    >
    currentBatchMessages: Store<Array<Message<T>>>
    removePendingMatches: (matchIds: Array<string>) => void
    resolveMatchedPendingMatches: () => void
    collectionId?: string
    persistence?: ElectricPersistenceConfig
  }
): SyncConfig<T> {
  const {
    seenTxids,
    seenSnapshots,
    syncMode,
    pendingMatches,
    currentBatchMessages,
    removePendingMatches,
    resolveMatchedPendingMatches,
    collectionId,
    persistence: persistenceConfig,
  } = options
  const persistence =
    persistenceConfig && createPersistence<T>(persistenceConfig)
  const MAX_BATCH_MESSAGES = 1000 // Safety limit for message buffer

  // Store for the relation schema information
  const relationSchema = new Store<string | undefined>(undefined)

  /**
   * Get the sync metadata for insert operations
   * @returns Record containing relation information
   */
  const getSyncMetadata = (): Record<string, unknown> => {
    // Use the stored schema if available, otherwise default to 'public'
    const schema = relationSchema.state || `public`

    return {
      relation: shapeOptions.params?.table
        ? [schema, shapeOptions.params.table]
        : undefined,
    }
  }

  let unsubscribeStream: () => void

  return {
    // Sync is called once on collection init
    sync: (params: Parameters<SyncConfig<T>[`sync`]>[0]) => {
      const { begin, write, commit, markReady, truncate, collection } = params

      // Load from localStorage if persistence is configured
      if (persistence) {
        try {
          persistence.loadSnapshotInto(begin, (op) => write(op), commit)
        } catch (e) {
          console.warn(`[ElectricPersistence] load error`, e)
        }
      }

      // Abort controller for the stream - wraps the signal if provided
      const abortController = new AbortController()

      if (shapeOptions.signal) {
        shapeOptions.signal.addEventListener(
          `abort`,
          () => {
            abortController.abort()
          },
          {
            once: true,
          }
        )
        if (shapeOptions.signal.aborted) {
          abortController.abort()
        }
      }

      // Cleanup pending matches on abort
      abortController.signal.addEventListener(`abort`, () => {
        pendingMatches.setState((current) => {
          current.forEach((match) => {
            clearTimeout(match.timeoutId)
            match.reject(new StreamAbortedError())
          })
          return new Map() // Clear all pending matches
        })
      })

      // Read from persistence if available
      const prev = persistence?.read()
      const computedOffset: Offset | undefined =
        shapeOptions.offset ??
        (prev?.lastOffset as Offset | undefined) ??
        (syncMode === `on-demand` ? `now` : undefined)

      const computedHandle: string | undefined =
        (shapeOptions as any).shapeHandle ?? prev?.shapeHandle

      const stream = new ShapeStream({
        ...shapeOptions,
        // In on-demand mode, we only want to sync changes, so we set the log to `changes_only`
        log: syncMode === `on-demand` ? `changes_only` : undefined,
        offset: computedOffset,
        handle: computedHandle,
        signal: abortController.signal,
        onError: (errorParams: any) => {
          // Just immediately mark ready if there's an error to avoid blocking
          // apps waiting for `.preload()` to finish.
          // Note that Electric sends a 409 error on a `must-refetch` message, but the
          // ShapeStream handled this and it will not reach this handler, therefor
          // this markReady will not be triggers by a `must-refetch`.
          markReady()

          if (shapeOptions.onError) {
            return shapeOptions.onError(errorParams)
          } else {
            console.error(
              `An error occurred while syncing collection: ${collection.id}, \n` +
                `it has been marked as ready to avoid blocking apps waiting for '.preload()' to finish. \n` +
                `You can provide an 'onError' handler on the shapeOptions to handle this error, and this message will not be logged.`,
              errorParams
            )
          }

          return
        },
      })
      let transactionStarted = false
      const newTxids = new Set<Txid>()
      const newSnapshots: Array<PostgresSnapshot> = []
      let hasReceivedUpToDate = false // Track if we've completed initial sync in progressive mode

      // Create deduplicated loadSubset wrapper for non-eager modes
      // This prevents redundant snapshot requests when multiple concurrent
      // live queries request overlapping or subset predicates
      const loadSubsetDedupe =
        syncMode === `eager`
          ? null
          : new DeduplicatedLoadSubset({
              loadSubset: async (opts: LoadSubsetOptions) => {
                // In progressive mode, stop requesting snapshots once full sync is complete
                if (syncMode === `progressive` && hasReceivedUpToDate) {
                  return
                }
                const snapshotParams = compileSQL<T>(opts)
                await stream.requestSnapshot(snapshotParams)
              },
            })

      unsubscribeStream = stream.subscribe((messages: Array<Message<T>>) => {
        let hasUpToDate = false
        let hasSyncedChanges = false
        let hasSnapshotEnd = false

        for (const message of messages) {
          // Add message to current batch buffer (for race condition handling)
          if (isChangeMessage(message)) {
            currentBatchMessages.setState(
              (currentBuffer: Array<Message<T>>) => {
                const newBuffer = [...currentBuffer, message]
                // Limit buffer size for safety
                if (newBuffer.length > MAX_BATCH_MESSAGES) {
                  newBuffer.splice(0, newBuffer.length - MAX_BATCH_MESSAGES)
                }
                return newBuffer
              }
            )
          }

          // Check for txids in the message and add them to our store
          if (hasTxids(message)) {
            message.headers.txids?.forEach((txid) => newTxids.add(txid))
          }

          // Check pending matches against this message
          // Note: matchFn will mark matches internally, we don't resolve here
          const matchesToRemove: Array<string> = []
          pendingMatches.state.forEach((match, matchId) => {
            if (!match.matched) {
              try {
                match.matchFn(message)
              } catch (err) {
                // If matchFn throws, clean up and reject the promise
                clearTimeout(match.timeoutId)
                match.reject(
                  err instanceof Error ? err : new Error(String(err))
                )
                matchesToRemove.push(matchId)
                debug(`matchFn error: %o`, err)
              }
            }
          })

          // Remove matches that errored
          removePendingMatches(matchesToRemove)

          if (isChangeMessage(message)) {
            // Check if the message contains schema information
            const schema = message.headers.schema
            if (schema && typeof schema === `string`) {
              // Store the schema for future use if it's a valid string
              relationSchema.setState(() => schema)
            }

            if (!transactionStarted) {
              begin()
              transactionStarted = true
            }

            write({
              type: message.headers.operation as `insert` | `update` | `delete`,
              value: message.value,
              // Include the primary key and relation info in the metadata
              metadata: {
                ...message.headers,
              },
            })

            // Track synced changes for persistence
            if (persistenceConfig) hasSyncedChanges = true
          } else if (isSnapshotEndMessage(message)) {
            newSnapshots.push(parseSnapshotMessage(message))
            hasSnapshotEnd = true
          } else if (isUpToDateMessage(message)) {
            hasUpToDate = true
          } else if (isMustRefetchMessage(message)) {
            debug(
              `${collectionId ? `[${collectionId}] ` : ``}Received must-refetch message, starting transaction with truncate`
            )

            // Start a transaction and truncate the collection
            if (!transactionStarted) {
              begin()
              transactionStarted = true
            }

            truncate()

            // Clear persistence storage on truncate
            if (persistence) persistence.clear()

            // Reset the loadSubset deduplication state since we're starting fresh
            // This ensures that previously loaded predicates don't prevent refetching after truncate
            loadSubsetDedupe?.reset()

            // Reset flags so we continue accumulating changes until next up-to-date
            hasUpToDate = false
            hasSnapshotEnd = false
            hasReceivedUpToDate = false // Reset for progressive mode - we're starting a new sync
          }
        }

        if (hasUpToDate || hasSnapshotEnd) {
          // Clear the current batch buffer since we're now up-to-date
          currentBatchMessages.setState(() => [])

          // Commit transaction if one was started
          if (transactionStarted) {
            commit()
            transactionStarted = false
          }

          // Persist synced changes to storage
          if (persistence && hasSyncedChanges) {
            persistence.saveCollectionSnapshot(collection, stream)
          }

          if (hasUpToDate || (hasSnapshotEnd && syncMode === `on-demand`)) {
            // Mark the collection as ready now that sync is up to date
            markReady()
          }

          // Track that we've received the first up-to-date for progressive mode
          if (hasUpToDate) {
            hasReceivedUpToDate = true
          }

          // Always commit txids when we receive up-to-date, regardless of transaction state
          seenTxids.setState((currentTxids: Set<Txid>) => {
            const clonedSeen = new Set<Txid>(currentTxids)
            if (newTxids.size > 0) {
              debug(
                `${collectionId ? `[${collectionId}] ` : ``}new txids synced from pg %O`,
                Array.from(newTxids)
              )
            }
            newTxids.forEach((txid) => clonedSeen.add(txid))
            newTxids.clear()
            return clonedSeen
          })

          // Always commit snapshots when we receive up-to-date, regardless of transaction state
          seenSnapshots.setState(
            (currentSnapshots: Array<PostgresSnapshot>) => {
              const seen = [...currentSnapshots, ...newSnapshots]
              newSnapshots.forEach((snapshot) =>
                debug(
                  `${collectionId ? `[${collectionId}] ` : ``}new snapshot synced from pg %o`,
                  snapshot
                )
              )
              newSnapshots.length = 0
              return seen
            }
          )

          // Resolve all matched pending matches on up-to-date
          resolveMatchedPendingMatches()
        }
      })

      // Return the deduplicated loadSubset if available (on-demand or progressive mode)
      // The loadSubset method is auto-bound, so it can be safely returned directly
      return {
        loadSubset: loadSubsetDedupe?.loadSubset,
        cleanup: () => {
          // Unsubscribe from the stream
          unsubscribeStream()
          // Abort the abort controller to stop the stream
          abortController.abort()
          // Reset deduplication tracking so collection can load fresh data if restarted
          loadSubsetDedupe?.reset()
        },
      }
    },
    // Expose the getSyncMetadata function
    getSyncMetadata,
  }
}
