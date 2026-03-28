import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export function createAuthAwareStreamFn(params: {
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">;
  deps?: {
    streamSimple?: typeof streamSimple;
  };
}): StreamFn {
  return async (model, context, options) => {
    const auth = await params.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    const stream = params.deps?.streamSimple ?? streamSimple;
    // Keep explicit per-call overrides intact while backfilling model-registry auth.
    return stream(model, context, {
      ...options,
      apiKey: options?.apiKey ?? auth.apiKey,
      headers:
        auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
    });
  };
}
