import {
  ShapeStream,
  isChangeMessage,
  isControlMessage,
} from "@electric-sql/client"
import { Store } from "@tanstack/store"
import DebugModule from "debug"
import {
  ElectricDeleteHandlerMustReturnTxIdError,
  ElectricInsertHandlerMustReturnTxIdError,
  ElectricUpdateHandlerMustReturnTxIdError,
  TimeoutWaitingForTxIdError,
} from "./errors"
import { validateJsonSerializable } from "./persistanceAdapter"
import type { StorageApi } from "./persistanceAdapter"
import type {
  BaseCollectionConfig,
  CollectionConfig,
  DeleteMutationFnParams,
  Fn,
  InsertMutationFnParams,
  SyncConfig,
  UpdateMutationFnParams,
  UtilsRecord,
} from "@tanstack/db"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type {
  ControlMessage,
  GetExtensions,
  Message,
  Offset,
  Row,
  ShapeStreamOptions,
} from "@electric-sql/client"

const debug = DebugModule.debug(`ts/db:electric`)

/**
 * Type representing a transaction ID in ElectricSQL
 */
export type Txid = number

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

/**
 * Configuration interface for Electric collection options
 * @template T - The type of items in the collection
 * @template TSchema - The schema type for validation
 */
export interface ElectricCollectionConfig<
  T extends Row<unknown> = Row<unknown>,
  TSchema extends StandardSchemaV1 = never,
> extends BaseCollectionConfig<
    T,
    string | number,
    TSchema,
    Record<string, Fn>,
    { txid: Txid | Array<Txid> }
  > {
  /**
   * Configuration options for the ElectricSQL ShapeStream
   */
  shapeOptions: ShapeStreamOptions<GetExtensions<T>>

  /**
   * Optional persistence configuration for localStorage storage
   * When provided, data will be persisted to localStorage and loaded on startup
   */
  persistence?: ElectricPersistenceConfig
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
 * Type for the pause stream utility function
 */
export type PauseStreamFn = () => void

/**
 * Type for the resume stream utility function
 */
export type ResumeStreamFn = () => void

/**
 * Type for the isStreamPaused utility function
 */
export type IsStreamPausedFn = () => boolean

/**
 * Electric collection utilities type
 */
export interface ElectricCollectionUtils extends UtilsRecord {
  awaitTxId: AwaitTxIdFn
  pauseStream: PauseStreamFn
  resumeStream: ResumeStreamFn
  isStreamPaused: IsStreamPausedFn
}

/**
 * Electric collection utilities type with persistence
 */
export interface ElectricCollectionUtilsWithPersistence
  extends ElectricCollectionUtils {
  clearPersistence: ClearPersistenceFn
  getPersistenceSize: GetPersistenceSizeFn
  pauseStream: PauseStreamFn
  resumeStream: ResumeStreamFn
  isStreamPaused: IsStreamPausedFn
}

export interface ElectricPersistenceConfig {
  storageKey: string
  storage?: StorageApi
}

export interface ElectricCollectionConfig<
  T extends Row<unknown> = Row<unknown>,
  TSchema extends StandardSchemaV1 = never,
> extends BaseCollectionConfig<
    T,
    string | number,
    TSchema,
    Record<string, Fn>,
    { txid: Txid | Array<Txid> }
  > {
  shapeOptions: ShapeStreamOptions<GetExtensions<T>>
  persistence?: ElectricPersistenceConfig
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

  // Stream control functions that will be set by the sync function
  let pauseStreamFn: (() => void) | null = null
  let resumeStreamFn: (() => void) | null = null
  let isStreamPausedFn: (() => boolean) | null = null

  console.info(`Electric collection options sync?`)
  const sync = createElectricSync<any>(config.shapeOptions, {
    seenTxids,
    persistence: config.persistence,
    setStreamControls: (pause, resume, isPaused) => {
      pauseStreamFn = pause
      resumeStreamFn = resume
      isStreamPausedFn = isPaused
    },
  })

  /**
   * Wait for a specific transaction ID to be synced
   * @param txId The transaction ID to wait for as a number
   * @param timeout Optional timeout in milliseconds (defaults to 30000ms)
   * @returns Promise that resolves when the txId is synced
   */
  const awaitTxId: AwaitTxIdFn = async (
    txId: Txid,
    timeout: number = 30000
  ): Promise<boolean> => {
    debug(`awaitTxId called with txid %d`, txId)
    // We should be able to accept a string txid
    // if (typeof txId !== `number`) {
    //   throw new ExpectedNumberInAwaitTxIdError(typeof txId)
    // }

    const hasTxid = seenTxids.state.has(txId)
    if (hasTxid) return true

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        unsubscribe()
        reject(new TimeoutWaitingForTxIdError(txId))
      }, timeout)

      const unsubscribe = seenTxids.subscribe(() => {
        if (seenTxids.state.has(txId)) {
          debug(`awaitTxId found match for txid %o`, txId)
          clearTimeout(timeoutId)
          unsubscribe()
          resolve(true)
        }
      })
    })
  }

  const wrappedOnInsert = config.onInsert
    ? async (params: InsertMutationFnParams<any>) => {
        // Validate that all values in the transaction can be JSON serialized (if persistence enabled)
        if (config.persistence) {
          params.transaction.mutations.forEach((m) =>
            validateJsonSerializable(m.modified, `insert`)
          )
        }
        // Runtime check (that doesn't follow type)
        // eslint-disable-next-line
        const handlerResult = (await config.onInsert!(params)) ?? {}
        const txid = (handlerResult as { txid?: Txid | Array<Txid> }).txid

        if (!txid) throw new ElectricInsertHandlerMustReturnTxIdError()

        // Handle both single txid and array of txids
        if (Array.isArray(txid)) {
          await Promise.all(txid.map((id) => awaitTxId(id)))
        } else {
          await awaitTxId(txid)
        }

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
        // Runtime check (that doesn't follow type)
        // eslint-disable-next-line
        const handlerResult = (await config.onUpdate!(params)) ?? {}
        const txid = (handlerResult as { txid?: Txid | Array<Txid> }).txid
        if (!txid) throw new ElectricUpdateHandlerMustReturnTxIdError()

        // Handle both single txid and array of txids
        if (Array.isArray(txid)) {
          await Promise.all(txid.map((id) => awaitTxId(id)))
        } else {
          await awaitTxId(txid)
        }

        if (persistence) {
          persistence.saveCollectionSnapshot(params.collection)
        }

        return handlerResult
      }
    : undefined

  const wrappedOnDelete = config.onDelete
    ? async (params: DeleteMutationFnParams<any>) => {
        const handlerResult = await config.onDelete!(params)
        const txid = handlerResult.txid

        if (!txid) throw new ElectricDeleteHandlerMustReturnTxIdError()
        // Handle both single txid and array of txids
        if (Array.isArray(handlerResult.txid)) {
          await Promise.all(handlerResult.txid.map((id) => awaitTxId(id)))
        } else {
          await awaitTxId(handlerResult.txid)
        }
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

  /**
   * Pause the shape stream - stops receiving updates from Electric
   */
  const pauseStream: PauseStreamFn = () => {
    if (!pauseStreamFn) {
      throw new Error(
        `Stream not initialized yet. Make sure sync() has been called.`
      )
    }
    pauseStreamFn()
  }

  /**
   * Resume the shape stream - starts receiving updates from Electric again
   */
  const resumeStream: ResumeStreamFn = () => {
    if (!resumeStreamFn) {
      throw new Error(
        `Stream not initialized yet. Make sure sync() has been called.`
      )
    }
    resumeStreamFn()
  }

  /**
   * Check if the stream is currently paused
   */
  const isStreamPaused: IsStreamPausedFn = () => {
    if (!isStreamPausedFn) {
      throw new Error(
        `Stream not initialized yet. Make sure sync() has been called.`
      )
    }
    return isStreamPausedFn()
  }

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
    ? {
        awaitTxId,
        clearPersistence,
        getPersistenceSize,
        pauseStream,
        resumeStream,
        isStreamPaused,
      }
    : { awaitTxId, pauseStream, resumeStream, isStreamPaused }

  return {
    ...restConfig,
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
    seenTxids: Store<Set<Txid>>
    persistence?: ElectricPersistenceConfig
    setStreamControls: (
      pause: () => void,
      resume: () => void,
      isPaused: () => boolean
    ) => void
  }
): SyncConfig<T> {
  const {
    seenTxids,
    persistence: persistenceConfig,
    setStreamControls,
  } = options
  const persistence =
    persistenceConfig && createPersistence<T>(persistenceConfig)

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

  console.info(`Creating electric sync`, persistenceConfig)
  return {
    // Sync is called once on collection init
    sync: (params: Parameters<SyncConfig<T>[`sync`]>[0]) => {
      const { begin, write, commit, markReady, truncate, collection } = params
      console.info(`Initial sync peristance`, persistenceConfig)

      // Load from localStorage if persistence is configured
      if (persistence) {
        try {
          persistence.loadSnapshotInto(begin, (op) => write(op), commit)
        } catch (e) {
          console.warn(`[ElectricPersistence] load error`, e)
        }
      }

      const prev = persistence?.read()
      const computedOffset: Offset | undefined =
        (shapeOptions as any).offset ?? prev?.lastOffset

      const computedHandle: string =
        (shapeOptions as any).shapeHandle ?? prev?.shapeHandle

      // Stream pause/resume state
      let isPaused = false
      let currentStream: any
      let currentStreamAbortController: AbortController
      let currentStreamOffset: Offset | undefined = computedOffset
      let currentStreamHandle: string | undefined = computedHandle

      let transactionStarted = false
      const newTxids = new Set<Txid>()

      const createStream = () => {
        // Create a new abort controller for this stream instance
        currentStreamAbortController = new AbortController()

        // Chain the original abort signal if present
        if (shapeOptions.signal) {
          shapeOptions.signal.addEventListener(
            `abort`,
            () => {
              currentStreamAbortController.abort()
            },
            {
              once: true,
            }
          )
          if (shapeOptions.signal.aborted) {
            currentStreamAbortController.abort()
          }
        }

        return new ShapeStream({
          ...shapeOptions,
          offset: currentStreamOffset,
          handle: currentStreamHandle,
          signal: currentStreamAbortController.signal,
          onError: (errorParams) => {
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
      }

      currentStream = createStream()

      // Message handler function - extracted so we can resubscribe
      const handleMessages = (messages: Array<Message<T>>) => {
        let hasUpToDate = false
        let hasSyncedChanges = false
        for (const message of messages) {
          // Check for txids in the message and add them to our store
          if (hasTxids(message)) {
            message.headers.txids?.forEach((txid) => newTxids.add(txid))
          }

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

            console.info(
              `shape stream is trying to write: `,
              message.value,
              message.headers
            )
            write({
              type: message.headers.operation,
              value: message.value,
              // Include the primary key and relation info in the metadata
              metadata: {
                ...message.headers,
              },
            })

            // Track synced changes for persistence
            if (persistenceConfig) hasSyncedChanges = true
          } else if (isUpToDateMessage(message)) {
            hasUpToDate = true
          } else if (isMustRefetchMessage(message)) {
            debug(
              `Received must-refetch message, starting transaction with truncate`
            )

            // Start a transaction and truncate the collection
            if (!transactionStarted) {
              begin()
              transactionStarted = true
            }

            truncate()

            // Clear persistence storage on truncate
            if (persistence) persistence.clear()

            // Reset hasUpToDate so we continue accumulating changes until next up-to-date
            hasUpToDate = false
          }
        }

        if (hasUpToDate) {
          // Commit transaction if one was started
          if (transactionStarted) {
            commit()
            transactionStarted = false
          }

          // Always update our tracked offset/handle for pause/resume
          currentStreamOffset = currentStream.lastOffset
          currentStreamHandle = currentStream.shapeHandle

          // Persist synced changes to storage
          if (persistence && hasSyncedChanges) {
            persistence.saveCollectionSnapshot(collection, currentStream)
          }

          // Mark the collection as ready now that sync is up to date
          markReady()

          // Always commit txids when we receive up-to-date, regardless of transaction state
          seenTxids.setState((currentTxids) => {
            const clonedSeen = new Set<Txid>(currentTxids)
            if (newTxids.size > 0) {
              debug(`new txids synced from pg %O`, Array.from(newTxids))
            }
            newTxids.forEach((txid) => clonedSeen.add(txid))
            newTxids.clear()
            return clonedSeen
          })
        }
      }

      // Subscribe to the stream with our message handler
      unsubscribeStream = currentStream.subscribe(handleMessages)

      // Stream control functions
      const pauseStreamFn = () => {
        if (isPaused) return
        isPaused = true

        // Save current offset/handle before stopping the stream
        currentStreamOffset = currentStream.lastOffset
        currentStreamHandle = currentStream.shapeHandle

        // Unsubscribe and abort the stream to stop fetching
        unsubscribeStream()
        currentStreamAbortController.abort()

        debug(
          `Stream paused at offset: %o, handle: %o`,
          currentStreamOffset,
          currentStreamHandle
        )
      }

      const resumeStreamFn = () => {
        if (!isPaused) return
        isPaused = false

        // Create a new stream starting from the saved offset/handle
        currentStream = createStream()
        unsubscribeStream = currentStream.subscribe(handleMessages)

        debug(
          `Stream resumed from offset: %o, handle: %o`,
          currentStreamOffset,
          currentStreamHandle
        )
      }

      const isStreamPausedFn = () => isPaused

      // Expose stream controls to the collection
      setStreamControls(pauseStreamFn, resumeStreamFn, isStreamPausedFn)

      // Return the unsubscribe function
      return () => {
        // Unsubscribe from the stream only if not paused because otherwise we're already unsusbcribed
        if (!isPaused) {
          unsubscribeStream()
        }
        // Abort the stream to stop it
        currentStreamAbortController.abort()
      }
    },
    // Expose the getSyncMetadata function
    getSyncMetadata,
  }
}
