export {
  electricCollectionOptions,
  type ElectricCollectionConfig,
  type ElectricCollectionUtils,
  type ElectricCollectionUtilsWithPersistence,
  type ElectricPersistenceConfig,
  type Txid,
  type AwaitTxIdFn,
  type ClearPersistenceFn,
  type GetPersistenceSizeFn,
} from "./electric"

export * from "./errors"

export type { StorageApi } from "./persistence/persistenceAdapter"
