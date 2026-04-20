import { describe, it } from "bun:test";
import { getStorageContractCases, memoryStorage } from "../src/index.js";

/**
 * Phase 7 — storage contract.
 *
 * The `getStorageContractCases(make)` export is what third-party adapters
 * (`@gramio/storage-redis`, `@gramio/storage-sqlite`, session-backed, etc.)
 * use to prove they behave the way `@gramio/onboarding` expects. We run it
 * here against `memoryStorage()` both as a regression check and to prove the
 * harness itself works.
 *
 * Each case calls the factory freshly, so adapters with persistent backends
 * must flush state on each invocation (namespaced prefixes, ephemeral DB,
 * etc.).
 */

describe("@gramio/onboarding — Phase 7 storage contract (memory)", () => {
	for (const c of getStorageContractCases(() => memoryStorage())) {
		it(c.name, c.run);
	}
});
