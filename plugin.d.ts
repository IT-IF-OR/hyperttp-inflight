import type { HyperPlugin, RequestContext, SendRequest } from "@hyperttp/types";
export type InflightKey = PropertyKey;
export interface InflightOptions<TInput = unknown> {
    enabled?: boolean;
    shouldDedupe?: (request: SendRequest<TInput>, ctx?: RequestContext) => boolean;
    keyExtractor?: (request: SendRequest<TInput>, ctx?: RequestContext) => InflightKey | undefined;
    allowAbortSignal?: boolean;
}
declare module "@hyperttp/types" {
    interface HyperClientOptions {
        inflight?: InflightOptions;
    }
}
export declare function withInflight<TInput = unknown, TOutput = unknown>(options?: InflightOptions<TInput>): HyperPlugin<TInput, TOutput>;
//# sourceMappingURL=plugin.d.ts.map