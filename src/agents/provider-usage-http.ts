import {
  createProviderUsageRunContext,
  observeProviderUsageCallChunk,
  persistProviderUsageCall,
  withProviderUsageCallReceipt,
  type ProviderUsageEvidenceRecorder,
} from "./provider-usage-receipts.js";

export type ProviderUsageHttpDescriptor = {
  surfaceCode: string;
  provider: string;
  model: string;
};

type ProviderHttpRequestResult = {
  response: Response;
  release: () => Promise<void>;
};

function errorCategory(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name.trim() : "provider_http_error";
}

export function createProviderUsageHttpAttemptRunner(params: ProviderUsageHttpDescriptor): {
  run<T extends ProviderHttpRequestResult>(request: () => Promise<T>): Promise<T>;
} {
  const runContext = createProviderUsageRunContext({
    runId: null,
    turnId: null,
    requestId: null,
    sessionId: null,
    trigger: "unknown",
    configuredProvider: params.provider,
    configuredModel: params.model,
  });
  let attempt = 0;
  return {
    async run<T extends ProviderHttpRequestResult>(request: () => Promise<T>): Promise<T> {
      const handle = runContext.beginCall({
        requestedProvider: params.provider,
        requestedModel: params.model,
        embeddedAttempt: 1,
        retryPrevious: attempt > 0,
      });
      attempt += 1;
      try {
        const result = await request();
        const headers = result.response.headers;
        const responseId =
          headers?.get?.("x-request-id") ??
          headers?.get?.("request-id") ??
          headers?.get?.("trace-id");
        persistProviderUsageCall({
          handle,
          status: result.response.ok ? "succeeded" : "failed",
          observation: responseId
            ? observeProviderUsageCallChunk(undefined, { responseId })
            : undefined,
          errorCategory: result.response.ok ? null : `http_${result.response.status}`,
        });
        return result;
      } catch (error) {
        persistProviderUsageCall({
          handle,
          status: "failed",
          errorCategory: errorCategory(error),
        });
        throw error;
      }
    },
  };
}

export async function withProviderUsageHttpRequest<T>(params: {
  provider: string;
  model: string;
  request: () => Promise<ProviderHttpRequestResult>;
  consume: (response: Response, recordEvidence: ProviderUsageEvidenceRecorder) => Promise<T>;
}): Promise<T> {
  return await withProviderUsageCallReceipt({
    provider: params.provider,
    model: params.model,
    run: async (recordEvidence) => {
      const { response, release } = await params.request();
      try {
        return await params.consume(response, recordEvidence);
      } finally {
        await release();
      }
    },
  });
}
