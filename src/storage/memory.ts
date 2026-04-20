import { inMemoryStorage } from "@gramio/storage";
import type { OnboardingStorage, OnboardingStorageMap } from "../types.js";

/**
 * Default memory adapter. Built on top of `@gramio/storage`'s
 * `inMemoryStorage`, so it satisfies the same `Storage` contract used by
 * every other GramIO plugin (scenes, session, …).
 *
 * State lives only for the lifetime of the current process — fine for tests
 * and dev. Use `redisStorage`, `sqliteStorage`, etc. in production.
 */
export function memoryStorage(): OnboardingStorage {
	return inMemoryStorage<OnboardingStorageMap>();
}
