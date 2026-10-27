import { providerFetch } from "../lib/http.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  successProvider,
  withRemaining,
} from "./common.js";
import {
  credentialCandidates,
  type EnvPiCredentialResolution,
  errorCode,
  inspectEnvPiAuth,
  KeyEndpointError,
  type KeyCredentialFailure,
  keyCredentialFailure,
  preferCredentialFailure,
  preferRemoteAuthFailure,
  pushEnvCredential,
  requestKeyEndpoint,
  statusFromRequestError,
} from "./env-pi-credential.js";

export const FACTORY_LIMITS_URL = "https://api.factory.ai/api/billing/limits";
export const FACTORY_ENV_SOURCE = "env:FACTORY_API_KEY";

const LABEL = "Factory";
const DEADLINE_MS = 15_000;

type Dependencies = {
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[];
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

type FactoryTierId = "standard" | "core";

const TIERS: readonly FactoryTierId[] = ["standard", "core"];

const TIER_WINDOWS: readonly {
  key: "fiveHour" | "weekly" | "monthly";
  suffix: string;
  label: string;
  kind: QuotaWindow["kind"];
  windowSeconds?: number;
}[] = [
  {
    key: "fiveHour",
    suffix: "5h",
    label: "5-hour",
    kind: "session",
    windowSeconds: 5 * 60 * 60,
  },
  {
    key: "weekly",
    suffix: "weekly",
    label: "weekly",
    kind: "weekly",
    windowSeconds: 7 * 24 * 60 * 60,
  },
  {
    key: "monthly",
    suffix: "monthly",
    label: "monthly",
    kind: "monthly",
  },
];

export type NormalizedFactoryPayload = {
  usesTokenRateLimitsBilling: boolean;
  windows: QuotaWindow[];
};

export function resolveFactoryCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EnvPiCredentialResolution[] {
  const credentials: EnvPiCredentialResolution[] = [];
  pushEnvCredential(
    credentials,
    environment,
    "FACTORY_API_KEY",
    FACTORY_ENV_SOURCE,
  );
  return credentials;
}

export function createFactoryAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveFactoryCredentials(),
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "factory",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const factoryAdapter = createFactoryAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalFailure: KeyCredentialFailure | undefined;
  for (const resolution of credentialCandidates(dependencies.credential)) {
    if (resolution.status !== "available") {
      const failure = keyCredentialFailure("factory", resolution);
      attempts.push({
        source: resolution.source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.error,
        ...(resolution.status === "invalid" || resolution.status === "error"
          ? { credentialPresent: true }
          : {}),
      });
      finalFailure = preferCredentialFailure(finalFailure, failure);
      continue;
    }

    try {
      const payload = await requestKeyEndpoint(
        FACTORY_LIMITS_URL,
        resolution.key,
        dependencies.fetch,
        dependencies.deadlineMs,
      );
      const normalized = normalizeFactoryPayload(payload);
      attempts.push({ source: resolution.source, status: "success" });

      return successProvider({
        provider: "factory",
        label: LABEL,
        source: "api",
        windows: normalized.windows,
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      const code = errorCode(error);
      attempts.push({
        source: resolution.source,
        status: "failed",
        error: code,
      });
      if (code === "provider_auth_rejected") {
        finalFailure = preferRemoteAuthFailure(finalFailure, code);
        continue;
      }
      return failedProvider({
        provider: "factory",
        label: LABEL,
        status: statusFromRequestError(code),
        error: code,
        source: "unavailable",
        retryAfter:
          error instanceof KeyEndpointError ? error.retryAfter : undefined,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
  }

  const failure = finalFailure ?? {
    status: "auth_required" as const,
    error: "factory_credential_unavailable",
  };
  return failedProvider({
    provider: "factory",
    label: LABEL,
    status: failure.status,
    error: failure.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  return inspectEnvPiAuth(
    "factory",
    credentialCandidates(dependencies.credential),
  );
}

export function normalizeFactoryPayload(
  raw: unknown,
): NormalizedFactoryPayload {
  const root = objectValue(raw);
  if (!root) throw new Error("invalid_payload");
  if (typeof root.usesTokenRateLimitsBilling !== "boolean")
    throw new Error("missing_billing_mode");
  if (!root.usesTokenRateLimitsBilling)
    return { usesTokenRateLimitsBilling: false, windows: [] };
  const limits = objectValue(root.limits);
  if (!limits) throw new Error("missing_limits");

  const windows: QuotaWindow[] = [];
  for (const tier of TIERS) {
    const groupValue = limits[tier];
    if (groupValue === undefined || groupValue === null) continue;
    const group = objectValue(groupValue);
    if (!group) throw new Error(`invalid_limits_tier:${tier}`);
    for (const shape of TIER_WINDOWS) {
      const entryValue = group[shape.key];
      if (entryValue === undefined || entryValue === null) continue;
      const entry = objectValue(entryValue);
      if (!entry) throw new Error(`invalid_window:${tier}_${shape.suffix}`);
      const percentUsed = usedPercentValue(entry.usedPercent);
      if (percentUsed === undefined)
        throw new Error(`invalid_used_percent:${tier}_${shape.suffix}`);
      const resetsAt = resetsAtValue(entry.windowEnd);
      if (resetsAt === false)
        throw new Error(`invalid_window_end:${tier}_${shape.suffix}`);
      windows.push(
        withRemaining({
          id: `${tier}_${shape.suffix}`,
          label: shape.label,
          kind: shape.kind,
          percentUsed,
          ...(resetsAt === undefined ? {} : { resetsAt }),
          ...(shape.windowSeconds === undefined
            ? {}
            : { windowSeconds: shape.windowSeconds }),
        }),
      );
    }
  }
  return { usesTokenRateLimitsBilling: true, windows };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function usedPercentValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * `windowEnd` is an ISO timestamp or null when the vendor has not established
 * a reset. Returns undefined for null, the timestamp for a parseable instant,
 * and false when the field is present but neither.
 */
function resetsAtValue(value: unknown): string | undefined | false {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? value : false;
}
