import { describe, expect, it, vi } from "vitest";
import {
  createFactoryAdapter,
  normalizeFactoryPayload,
  resolveFactoryCredentials,
} from "../../src/providers/factory.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-factory-key";

function limitsBody(): unknown {
  return {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: {
          usedPercent: 3,
          windowEnd: "2026-09-01T05:16:40.371Z",
          secondsRemaining: 17462,
        },
        weekly: {
          usedPercent: 28,
          windowEnd: "2026-09-07T15:54:29.726Z",
          secondsRemaining: 512931,
        },
        monthly: {
          usedPercent: 62,
          windowEnd: "2026-10-01T21:05:47.340Z",
          secondsRemaining: 1827609,
        },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: {
          usedPercent: 12,
          windowEnd: "2026-09-02T18:21:33.956Z",
          secondsRemaining: 3355,
        },
        monthly: {
          usedPercent: 9,
          windowEnd: "2026-11-01T18:21:33.956Z",
          secondsRemaining: 1990555,
        },
      },
    },
    overagePreference: "droidCore",
    canManageOverage: true,
    extraUsageBalanceCents: 0,
    extraUsageAllowed: true,
  };
}

describe("Factory provider", () => {
  it("reads per-tier token-rate windows from the first-party API", async () => {
    const request = vi.fn(async () => {
      return new Response(JSON.stringify(limitsBody()), {
        headers: { "content-type": "application/json" },
      });
    });

    const report = await createFactoryAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:FACTORY_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "factory",
      source: "api",
      state: { status: "fresh", stale: false },
      attempts: [{ source: "env:FACTORY_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([
      {
        id: "standard_5h",
        label: "5-hour",
        kind: "session",
        percentUsed: 3,
        percentRemaining: 97,
        resetsAt: "2026-09-01T05:16:40.371Z",
        windowSeconds: 18000,
      },
      {
        id: "standard_weekly",
        label: "weekly",
        kind: "weekly",
        percentUsed: 28,
        percentRemaining: 72,
        resetsAt: "2026-09-07T15:54:29.726Z",
        windowSeconds: 604800,
      },
      {
        id: "standard_monthly",
        label: "monthly",
        kind: "monthly",
        percentUsed: 62,
        percentRemaining: 38,
        resetsAt: "2026-10-01T21:05:47.340Z",
      },
      {
        id: "core_5h",
        label: "5-hour",
        kind: "session",
        percentUsed: 0,
        percentRemaining: 100,
        windowSeconds: 18000,
      },
      {
        id: "core_weekly",
        label: "weekly",
        kind: "weekly",
        percentUsed: 12,
        percentRemaining: 88,
        resetsAt: "2026-09-02T18:21:33.956Z",
        windowSeconds: 604800,
      },
      {
        id: "core_monthly",
        label: "monthly",
        kind: "monthly",
        percentUsed: 9,
        percentRemaining: 91,
        resetsAt: "2026-11-01T18:21:33.956Z",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request).toHaveBeenCalledOnce();
    const init = request.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("reports an account without token-rate billing as fresh with no windows", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ usesTokenRateLimitsBilling: false }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const report = await createFactoryAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:FACTORY_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "factory",
      state: { status: "fresh", stale: false },
    });
    expect(report.windows).toEqual([]);
  });

  it("reports a missing environment key as auth_required", async () => {
    const request = vi.fn();
    const report = await createFactoryAdapter({
      credential: () => resolveFactoryCredentials({}),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "factory",
      state: {
        status: "auth_required",
        error: "factory_credential_unavailable",
        sourcesTried: ["env:FACTORY_API_KEY"],
      },
      attempts: [{ source: "env:FACTORY_API_KEY", status: "skipped" }],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports 401 as auth_required", async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));

    const report = await createFactoryAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:FACTORY_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "factory",
      state: {
        status: "auth_required",
        error: "provider_auth_rejected",
        sourcesTried: ["env:FACTORY_API_KEY"],
      },
      attempts: [
        {
          source: "env:FACTORY_API_KEY",
          status: "failed",
          error: "provider_auth_rejected",
        },
      ],
    });
  });

  it("reports 429 as rate_limited with the Retry-After hint", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "30" } }),
    );

    const report = await createFactoryAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:FACTORY_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "rate_limited" },
    });
    expect(report.state.retryAfter).toBeTruthy();
  });

  it("rejects a non-numeric usedPercent", async () => {
    const body = JSON.parse(JSON.stringify(limitsBody()));
    body.limits.standard.fiveHour.usedPercent = "3";
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
    );

    const report = await createFactoryAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:FACTORY_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "error", error: "invalid_used_percent:standard_5h" },
    });
  });

  it("rejects a non-object payload", () => {
    expect(() => normalizeFactoryPayload("nope")).toThrow("invalid_payload");
  });

  it("rejects a payload without the billing mode flag", () => {
    expect(() => normalizeFactoryPayload({})).toThrow("missing_billing_mode");
  });

  it("enumerates the environment source even when unset", async () => {
    const report = await createFactoryAdapter({
      credential: () => resolveFactoryCredentials({}),
    }).inspectAuth(OPTIONS);

    expect(report).toMatchObject({
      provider: "factory",
      sources: [{ source: "env:FACTORY_API_KEY", status: "missing" }],
    });
  });
});
