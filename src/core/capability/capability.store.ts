import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../platform/fs-atomic.ts";
import { projectConfigPath, projectStateDir, runtimeHome } from "../../platform/paths.ts";
import type { CapabilityCatalog, RuntimeSeen } from "./capability.types.ts";

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function catalogPath(home = runtimeHome()): string {
  return join(home, "capabilities", "catalog.json");
}

export function loadCatalog(home = runtimeHome()): CapabilityCatalog | null {
  const raw = readJson<CapabilityCatalog>(catalogPath(home));
  if (!raw || typeof raw.catalogVersion !== "number" || !Array.isArray(raw.capabilities)) {
    return null;
  }
  return raw;
}

export type ConfigReadStatus =
  | { status: "absent" }
  | { status: "parsed"; value: Record<string, unknown> }
  | { status: "malformed"; error: string };

/**
 * why: `readJson` already reads this file but collapses "absent" and "malformed" to the same `null`
 * — the exact silent-corruption gap `doctor` needs to close, so this is a second, tagged reader.
 */
export function readProjectPolicyStatus(projectDir: string): ConfigReadStatus {
  const path = projectConfigPath(projectDir);
  if (!existsSync(path)) {
    return { status: "absent" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // why: a JSON Schema meta-key, not a Policy field — see the identical strip in policy.loader.ts,
    // this is the second, independent read of the same file.
    delete parsed.$schema;
    return { status: "parsed", value: parsed };
  } catch (error) {
    return { status: "malformed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function readProjectPolicyRaw(projectDir: string): Record<string, unknown> | null {
  const result = readProjectPolicyStatus(projectDir);
  return result.status === "parsed" ? result.value : null;
}

function runtimeSeenPath(projectDir: string): string {
  return join(projectStateDir(projectDir), "runtime-seen.json");
}

export function readRuntimeSeen(projectDir: string): RuntimeSeen {
  const raw = readJson<RuntimeSeen>(runtimeSeenPath(projectDir));
  if (!raw || typeof raw.catalogVersion !== "number" || raw.catalogVersion < 0) {
    return { catalogVersion: 0 };
  }
  return raw;
}

export async function writeRuntimeSeen(projectDir: string, catalogVersion: number): Promise<void> {
  await writeJsonAtomic(runtimeSeenPath(projectDir), {
    catalogVersion,
    updatedAt: new Date().toISOString(),
  } satisfies RuntimeSeen);
}
