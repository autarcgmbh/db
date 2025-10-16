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
 * Electric collection utilities type
 */
export interface ElectricCollectionUtils extends UtilsRecord {
  awaitTxId: AwaitTxIdFn
}

/**
 * Electric collection utilities type with persistence
 */
export interface ElectricCollectionUtilsWithPersistence
  extends ElectricCollectionUtils {
  clearPersistence: ClearPersistenceFn
  getPersistenceSize: GetPersistenceSizeFn
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

  console.info(`Electric collection options sync?`)
  const sync = createElectricSync<any>(config.shapeOptions, {
    seenTxids,
    persistence: config.persistence,
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

  // Helper function to save to localStorage if persistence is configured
  // Reads from collection's in-memory state at save time
  const persistToStorage = (collection: any) => {
    if (!config.persistence) return

    const storage =
      config.persistence.storage ||
      (typeof window !== `undefined` ? window.localStorage : null)

    if (!storage) return

    return {
      save: () => {
        // Read directly from collection's in-memory state
        const dataToSave: Record<string, any> = {}

        // Could just save the collection state directly
        for (const [key, value] of collection.state) {
          dataToSave[String(key)] = value
        }

        const serialized = JSON.stringify(dataToSave)
        storage.setItem(config.persistence!.storageKey, serialized)
      },
    }
  }

  // Create wrapper handlers for direct persistence operations that handle txid awaiting
  const wrappedOnInsert = config.onInsert
    ? async (params: InsertMutationFnParams<any>) => {
        // Validate that all values in the transaction can be JSON serialized (if persistence enabled)
        if (config.persistence) {
          params.transaction.mutations.forEach((mutation) => {
            validateJsonSerializable(mutation.modified, `insert`)
          })
        }

        // Runtime check (that doesn't follow type)
        // eslint-disable-next-line
        const handlerResult = (await config.onInsert!(params)) ?? {}
        const txid = (handlerResult as { txid?: Txid | Array<Txid> }).txid

        if (!txid) {
          throw new ElectricInsertHandlerMustReturnTxIdError()
        }

        // Handle both single txid and array of txids
        if (Array.isArray(txid)) {
          await Promise.all(txid.map((id) => awaitTxId(id)))
        } else {
          await awaitTxId(txid)
        }

        // Persist to storage if configured
        if (config.persistence) {
          const persistence = persistToStorage(params.collection)
          if (persistence) {
            // Save collection state to localStorage
            persistence.save()
          }
        }

        return handlerResult
      }
    : undefined

  const wrappedOnUpdate = config.onUpdate
    ? async (params: UpdateMutationFnParams<any>) => {
        // Validate that all values in the transaction can be JSON serialized (if persistence enabled)
        if (config.persistence) {
          params.transaction.mutations.forEach((mutation) => {
            validateJsonSerializable(mutation.modified, `update`)
          })
        }

        // Runtime check (that doesn't follow type)
        // eslint-disable-next-line
        const handlerResult = (await config.onUpdate!(params)) ?? {}
        const txid = (handlerResult as { txid?: Txid | Array<Txid> }).txid

        if (!txid) {
          throw new ElectricUpdateHandlerMustReturnTxIdError()
        }

        // Handle both single txid and array of txids
        if (Array.isArray(txid)) {
          await Promise.all(txid.map((id) => awaitTxId(id)))
        } else {
          await awaitTxId(txid)
        }

        // Persist to storage if configured
        if (config.persistence) {
          const persistence = persistToStorage(params.collection)
          if (persistence) {
            // Save collection state to localStorage
            persistence.save()
          }
        }

        return handlerResult
      }
    : undefined

  const wrappedOnDelete = config.onDelete
    ? async (params: DeleteMutationFnParams<any>) => {
        const handlerResult = await config.onDelete!(params)
        if (!handlerResult.txid) {
          throw new ElectricDeleteHandlerMustReturnTxIdError()
        }

        // Handle both single txid and array of txids
        if (Array.isArray(handlerResult.txid)) {
          await Promise.all(handlerResult.txid.map((id) => awaitTxId(id)))
        } else {
          await awaitTxId(handlerResult.txid)
        }

        // Persist to storage if configured
        if (config.persistence) {
          const persistence = persistToStorage(params.collection)
          if (persistence) {
            // Save collection state to localStorage
            persistence.save()
          }
        }

        return handlerResult
      }
    : undefined

  // Utility functions for persistence
  const clearPersistence: ClearPersistenceFn = async (): Promise<void> => {
    if (!config.persistence) {
      throw new Error(`Persistence is not configured for this collection`)
    }

    const storage =
      config.persistence.storage ||
      (typeof window !== `undefined` ? window.localStorage : null)

    if (storage) {
      storage.removeItem(config.persistence.storageKey)
    }
  }

  const getPersistenceSize: GetPersistenceSizeFn =
    async (): Promise<number> => {
      if (!config.persistence) {
        return 0
      }

      const storage =
        config.persistence.storage ||
        (typeof window !== `undefined` ? window.localStorage : null)

      if (!storage) {
        return 0
      }

      const data = storage.getItem(config.persistence.storageKey)
      return data ? new Blob([data]).size : 0
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
    | ElectricCollectionUtilsWithPersistence = config.persistence
    ? {
        awaitTxId,
        clearPersistence,
        getPersistenceSize,
      }
    : {
        awaitTxId,
      }

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
  }
): SyncConfig<T> {
  const { seenTxids, persistence } = options

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

  console.info(`Creating electric sync`, persistence)
  return {
    // Sync is called once on collection init
    sync: (params: Parameters<SyncConfig<T>[`sync`]>[0]) => {
      const { begin, write, commit, markReady, truncate, collection } = params
      console.info(`Initial sync peristance`, persistence)

      // Load from localStorage if persistence is configured
      if (persistence) {
        const storage =
          persistence.storage ||
          (typeof window !== `undefined` ? window.localStorage : null)

        console.info(`storage`, storage)

        if (storage) {
          try {
            const rawData = storage.getItem(persistence.storageKey)
            console.info(`rawData storage sync`, rawData)
            if (rawData) {
              const parsed = JSON.parse(rawData)
              console.info(`parsed storage sync`, rawData)
              if (parsed) {
                const entries = Object.entries(parsed)
                console.info(`entries`, entries)
                if (entries.length) {
                  console.info(`entries lengths`, entries.length)
                  begin()
                  console.info(`begin`, entries.length)
                  entries.forEach(([_, value]) => {
                    console.info(`valves storage recover`, value)
                    if (value) write({ type: `insert`, value: value as T })
                  })
                  commit()
                }
              }
            }
          } catch (error) {
            console.warn(
              `[ElectricPersistence] Error loading data from storage:`,
              error
            )
          }
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

      const stream = new ShapeStream({
        ...shapeOptions,
        signal: abortController.signal,
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
      let transactionStarted = false
      const newTxids = new Set<Txid>()

      unsubscribeStream = stream.subscribe((messages: Array<Message<T>>) => {
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
            if (persistence) hasSyncedChanges = true
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
            if (persistence) {
              const storage =
                persistence.storage ||
                (typeof window !== `undefined` ? window.localStorage : null)
              if (storage) {
                storage.removeItem(persistence.storageKey)
              }
            }

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

          // Persist synced changes to storage
          if (persistence && hasSyncedChanges) {
            const storage =
              persistence.storage ||
              (typeof window !== `undefined` ? window.localStorage : null)

            if (storage) {
              // Read current collection state and save to localStorage
              const dataToSave: Record<string, T> = {}

              for (const [key, value] of collection.state) {
                dataToSave[String(key)] = value
              }

              const serialized = JSON.stringify(dataToSave)
              storage.setItem(persistence.storageKey, serialized)
            }
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
      })

      // Return the unsubscribe function
      return () => {
        // Unsubscribe from the stream
        unsubscribeStream()
        // Abort the abort controller to stop the stream
        abortController.abort()
      }
    },
    // Expose the getSyncMetadata function
    getSyncMetadata,
  }
}
