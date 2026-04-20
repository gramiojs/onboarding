import type {
	OnboardingRecord,
	OnboardingStorage,
	OnboardingStorageMap,
} from "../types.js";

/**
 * Framework-agnostic storage-contract suite.
 *
 * Returns a list of `{ name, run }` pairs that any adapter implementing
 * `Storage<OnboardingStorageMap>` must satisfy. Wire them to your test
 * runner of choice — `bun:test`, `vitest`, Jest, node:test — the contract
 * itself doesn't pull in a testing framework.
 *
 * @example
 * ```ts
 * import { describe, it } from "bun:test";
 * import { getStorageContractCases } from "@gramio/onboarding";
 * import { redisStorage } from "@gramio/storage-redis";
 *
 * describe("redis adapter", () => {
 *   for (const c of getStorageContractCases(() => redisStorage({ client }))) {
 *     it(c.name, c.run);
 *   }
 * });
 * ```
 *
 * Each case assigns a fresh storage from the factory, so adapters that
 * persist across invocations (redis, sqlite) need to tear down between runs
 * — give the factory flush-on-create semantics.
 */

type Factory = () => OnboardingStorage | Promise<OnboardingStorage>;

export interface StorageContractCase {
	name: string;
	run: () => Promise<void>;
}

const FLOW_KEY = "flow:welcome:42" as keyof OnboardingStorageMap;
const GLOBAL_KEY = "global:42" as keyof OnboardingStorageMap;

const FLOW_RECORD: OnboardingRecord = {
	kind: "flow",
	flowId: "welcome",
	status: "active",
	stepId: "hi",
	runId: "abc123",
	data: { clicks: 2 },
};

const GLOBAL_RECORD: OnboardingRecord = {
	kind: "global",
	disabled: false,
	queue: [{ flowId: "premium" }],
};

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`[storage-contract] ${label}: expected ${e}, got ${a}`);
	}
}

function assertTrue(v: unknown, label: string): void {
	if (!v) throw new Error(`[storage-contract] ${label}: expected truthy`);
}

function assertFalse(v: unknown, label: string): void {
	if (v) throw new Error(`[storage-contract] ${label}: expected falsy`);
}

export function getStorageContractCases(make: Factory): StorageContractCase[] {
	return [
		{
			name: "get() on a missing key returns undefined",
			async run() {
				const s = await make();
				const v = await s.get(FLOW_KEY);
				assertTrue(v === undefined, "missing key → undefined");
			},
		},
		{
			name: "set() then get() round-trips flow records",
			async run() {
				const s = await make();
				await s.set(FLOW_KEY, FLOW_RECORD);
				assertEqual(await s.get(FLOW_KEY), FLOW_RECORD, "flow round-trip");
			},
		},
		{
			name: "set() then get() round-trips global records",
			async run() {
				const s = await make();
				await s.set(GLOBAL_KEY, GLOBAL_RECORD);
				assertEqual(
					await s.get(GLOBAL_KEY),
					GLOBAL_RECORD,
					"global round-trip",
				);
			},
		},
		{
			name: "set() overwrites the value under an existing key",
			async run() {
				const s = await make();
				await s.set(FLOW_KEY, FLOW_RECORD);
				const next: OnboardingRecord = {
					...FLOW_RECORD,
					status: "completed",
					stepId: "done",
				};
				await s.set(FLOW_KEY, next);
				assertEqual(await s.get(FLOW_KEY), next, "overwrite");
			},
		},
		{
			name: "has() reflects presence",
			async run() {
				const s = await make();
				assertFalse(await s.has(FLOW_KEY), "missing key");
				await s.set(FLOW_KEY, FLOW_RECORD);
				assertTrue(await s.has(FLOW_KEY), "present key");
			},
		},
		{
			name: "delete() removes the key",
			async run() {
				const s = await make();
				await s.set(FLOW_KEY, FLOW_RECORD);
				await s.delete(FLOW_KEY);
				assertFalse(await s.has(FLOW_KEY), "deleted key absent");
				assertTrue(
					(await s.get(FLOW_KEY)) === undefined,
					"deleted key returns undefined",
				);
			},
		},
		{
			name: "flow and global keys for the same scope coexist",
			async run() {
				const s = await make();
				await s.set(FLOW_KEY, FLOW_RECORD);
				await s.set(GLOBAL_KEY, GLOBAL_RECORD);
				assertEqual(await s.get(FLOW_KEY), FLOW_RECORD, "flow coexist");
				assertEqual(await s.get(GLOBAL_KEY), GLOBAL_RECORD, "global coexist");
			},
		},
		{
			name: "records with nested data survive the round-trip",
			async run() {
				const s = await make();
				const rec: OnboardingRecord = {
					kind: "flow",
					flowId: "welcome",
					status: "active",
					stepId: "hi",
					data: {
						preferences: { theme: "dark", lang: "en" },
						seen: ["a", "b", "c"],
						count: 7,
					},
				};
				await s.set(FLOW_KEY, rec);
				assertEqual(await s.get(FLOW_KEY), rec, "nested data");
			},
		},
	];
}
