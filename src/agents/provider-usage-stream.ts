import {
  stream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createProviderUsageRunContext,
  observeProviderUsageCallChunk,
  persistProviderUsageCall,
  type ProviderUsageCallHandle,
  type ProviderUsageCallObservation,
  type ProviderUsageRunContext,
  type ProviderUsageRunIdentity,
} from "./provider-usage-receipts.js";
import { withProviderUsageAttemptHooks } from "./provider-usage-transport.js";

type ProviderUsageStream = AsyncIterable<unknown> & {
  result(): Promise<AssistantMessage>;
};

type ProviderUsageStreamFn<TModel, TContext, TOptions, TStream extends ProviderUsageStream> = (
  model: TModel,
  context: TContext,
  options?: TOptions,
) => TStream | Promise<TStream>;

export type ProviderUsageStreamIdentity = Omit<
  ProviderUsageRunIdentity,
  "configuredProvider" | "configuredModel"
>;

export type ProviderUsageStreamOptions = {
  run?: ProviderUsageRunContext;
  identity?: ProviderUsageStreamIdentity;
  embeddedAttempt?: number;
};

type ProviderUsageStreamState = {
  call: ProviderUsageCallHandle;
  observation?: ProviderUsageCallObservation;
  persisted: boolean;
};

function errorCategory(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim();
  }
  return "provider_call_error";
}

function terminalStatus(message: AssistantMessage): {
  status: "succeeded" | "failed" | "cancelled";
  errorCategory?: string;
} {
  if (message.stopReason === "error") {
    return { status: "failed", errorCategory: "provider_result_error" };
  }
  if (message.stopReason === "aborted") {
    return { status: "cancelled", errorCategory: "provider_result_aborted" };
  }
  return { status: "succeeded" };
}

function persistState(
  state: ProviderUsageStreamState,
  status: "succeeded" | "failed" | "interrupted" | "cancelled",
  category?: string,
): void {
  if (state.persisted) {
    return;
  }
  state.persisted = true;
  persistProviderUsageCall({
    handle: state.call,
    status,
    observation: state.observation,
    errorCategory: category,
  });
}

function observe(state: ProviderUsageStreamState, value: unknown): void {
  state.observation = observeProviderUsageCallChunk(state.observation, value);
}

function startRetry(
  state: ProviderUsageStreamState,
  run: ProviderUsageRunContext,
  model: { provider: string; id: string },
  embeddedAttempt: number,
): void {
  state.call = run.beginCall({
    requestedProvider: model.provider,
    requestedModel: model.id,
    embeddedAttempt,
    retryPrevious: true,
  });
  state.observation = undefined;
  state.persisted = false;
}

function withAttemptHooks<TOptions extends object | undefined>(
  options: TOptions,
  state: ProviderUsageStreamState,
  run: ProviderUsageRunContext,
  model: { provider: string; id: string },
  embeddedAttempt: number,
): TOptions {
  return withProviderUsageAttemptHooks(options, {
    onAttemptStarted: ({ retry }) => {
      if (retry && state.persisted) {
        startRetry(state, run, model, embeddedAttempt);
      }
    },
    onAttemptFailed: ({ errorCategory: category }) => {
      persistState(state, "failed", category);
    },
  }) as TOptions;
}

async function* observeIterator<T>(
  iterator: AsyncIterator<T>,
  state: ProviderUsageStreamState,
): AsyncIterable<T> {
  let completed = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        completed = true;
        break;
      }
      observe(state, next.value);
      yield next.value;
    }
    if (!state.persisted) {
      const final = state.observation?.providerFinishReason;
      persistState(
        state,
        final === "error" ? "failed" : final === "aborted" ? "cancelled" : "succeeded",
        final === "error"
          ? "provider_stream_error"
          : final === "aborted"
            ? "provider_stream_aborted"
            : undefined,
      );
    }
  } catch (error) {
    persistState(state, "failed", errorCategory(error));
    throw error;
  } finally {
    if (!completed) {
      try {
        await iterator.return?.();
      } catch {
        // The receipt still records the caller-visible interruption.
      }
      persistState(state, "interrupted");
    }
  }
}

function observeStream<TStream extends ProviderUsageStream>(
  source: TStream,
  state: ProviderUsageStreamState,
): TStream {
  let resultPromise: Promise<AssistantMessage> | undefined;
  return new Proxy(source, {
    get(target, property) {
      if (property === Symbol.asyncIterator) {
        return () => observeIterator(target[Symbol.asyncIterator](), state)[Symbol.asyncIterator]();
      }
      if (property === "result") {
        return () => {
          resultPromise ??= target.result().then(
            (message) => {
              observe(state, message);
              const terminal = terminalStatus(message);
              persistState(state, terminal.status, terminal.errorCategory);
              return message;
            },
            (error) => {
              persistState(state, "failed", errorCategory(error));
              throw error;
            },
          );
          return resultPromise;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function wrapStreamFnWithProviderUsageReceipts<
  TModel extends { provider: string; id: string },
  TContext,
  TOptions extends object | undefined,
  TStream extends ProviderUsageStream,
>(
  streamFn: ProviderUsageStreamFn<TModel, TContext, TOptions, TStream>,
  params: ProviderUsageStreamOptions = {},
): ProviderUsageStreamFn<TModel, TContext, TOptions, TStream> {
  return async (model, context, options) => {
    const run =
      params.run ??
      createProviderUsageRunContext({
        runId: params.identity?.runId ?? null,
        turnId: params.identity?.turnId ?? null,
        requestId: params.identity?.requestId ?? null,
        sessionId: params.identity?.sessionId ?? null,
        trigger: params.identity?.trigger ?? "unknown",
        configuredProvider: model.provider,
        configuredModel: model.id,
      });
    const embeddedAttempt = params.embeddedAttempt ?? 1;
    const state: ProviderUsageStreamState = {
      call: run.beginCall({
        requestedProvider: model.provider,
        requestedModel: model.id,
        embeddedAttempt,
      }),
      persisted: false,
    };
    const propagatedOptions = withAttemptHooks(
      options,
      state,
      run,
      model,
      embeddedAttempt,
    ) as TOptions;
    try {
      return observeStream(await streamFn(model, context, propagatedOptions), state);
    } catch (error) {
      persistState(state, "failed", errorCategory(error));
      throw error;
    }
  };
}

export async function completeWithProviderUsageReceipts<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
  receiptOptions?: ProviderUsageStreamOptions,
): Promise<AssistantMessage> {
  const wrapped = wrapStreamFnWithProviderUsageReceipts(
    stream as (
      model: Model<TApi>,
      context: Context,
      options?: ProviderStreamOptions,
    ) => AssistantMessageEventStream,
    receiptOptions,
  );
  return await (await wrapped(model, context, options)).result();
}

export async function completeSimpleWithProviderUsageReceipts<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  receiptOptions?: ProviderUsageStreamOptions,
): Promise<AssistantMessage> {
  const wrapped = wrapStreamFnWithProviderUsageReceipts(
    streamSimple as (
      model: Model<TApi>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream,
    receiptOptions,
  );
  return await (await wrapped(model, context, options)).result();
}
