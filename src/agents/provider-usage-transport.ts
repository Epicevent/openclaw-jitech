export const PROVIDER_USAGE_ATTEMPT_HOOKS = Symbol.for("openclaw.providerUsageAttemptHooks.v1");

export type ProviderUsageAttemptHooks = {
  onAttemptStarted: (params: { retry: boolean }) => void;
  onAttemptFailed: (params: { errorCategory: string }) => void;
};

type OptionsWithProviderUsageAttemptHooks = {
  [PROVIDER_USAGE_ATTEMPT_HOOKS]?: ProviderUsageAttemptHooks;
};

export function withProviderUsageAttemptHooks<T extends object | undefined>(
  options: T,
  hooks: ProviderUsageAttemptHooks,
): T & OptionsWithProviderUsageAttemptHooks {
  return {
    ...options,
    [PROVIDER_USAGE_ATTEMPT_HOOKS]: hooks,
  } as T & OptionsWithProviderUsageAttemptHooks;
}

export function resolveProviderUsageAttemptHooks(
  options: unknown,
): ProviderUsageAttemptHooks | undefined {
  if (options === null || typeof options !== "object") {
    return undefined;
  }
  return (options as OptionsWithProviderUsageAttemptHooks)[PROVIDER_USAGE_ATTEMPT_HOOKS];
}

export function wrapFetchWithProviderUsageAttempts(
  fetchFn: typeof fetch,
  hooks: ProviderUsageAttemptHooks | undefined,
): typeof fetch {
  if (!hooks) {
    return fetchFn;
  }
  let physicalAttempt = 0;
  return (async (...args: Parameters<typeof fetch>) => {
    hooks.onAttemptStarted({ retry: physicalAttempt > 0 });
    physicalAttempt += 1;
    try {
      const response = await fetchFn(...args);
      if (!response.ok) {
        hooks.onAttemptFailed({ errorCategory: `http_${response.status}` });
      }
      return response;
    } catch (error) {
      hooks.onAttemptFailed({
        errorCategory:
          error instanceof Error && error.name.trim() ? error.name.trim() : "network_error",
      });
      throw error;
    }
  }) as typeof fetch;
}
