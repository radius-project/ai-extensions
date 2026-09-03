// Kept as the Canvas-facing module so existing imports stay stable. The shared
// Node adapter owns the implementation because it also stamps generated graph
// artifacts with the same normalized application-model hash.
export {
  APP_BICEP_HASH_ALGORITHM,
  hashAppBicep
} from "@radius-project/adapter-shared";
