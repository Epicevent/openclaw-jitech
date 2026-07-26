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
