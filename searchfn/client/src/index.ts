export { createSearchClient, SearchClientValidationError } from "./client";
export { createMemorySearchClient, createIndexedDbSearchClient } from "./constructors";
export type {
  SearchClient,
  SearchClientConfig,
  SearchClientDefaults,
  SearchAdapter,
  SearchAdapterCapabilities,
  IndexParams,
  SearchParams,
  SearchAllParams,
  SearchAllResult,
  InitializeParams,
} from "./types";
