import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { BackendScopeSchema, MutationEnvelopeSchema, MutationResultSchema, SnapshotSchema } from "./index.js";

const sessionInput = z.object({ scope: BackendScopeSchema, sessionId: z.string().min(1) }).strict();
export const TeamflowDemo = Rpc.define({
  id: "teamflow.demo",
  methods: {
    snapshot: { input: BackendScopeSchema, output: SnapshotSchema },
    mutate: { input: MutationEnvelopeSchema, output: MutationResultSchema, errors: { rejected: z.object({ reason: z.string() }) } },
    sessionMessages: { input: sessionInput, output: z.array(z.unknown()) },
    sessionSend: { input: sessionInput.extend({ text: z.string().min(1).max(32000) }), output: z.unknown() },
    info: { input: z.object({}).strict(), output: z.object({ backendId: z.string(), directory: z.string(), version: z.string(), runtime: z.record(z.string(), z.string()), sqlite: z.string() }) },
  },
  events: { changed: { schema: z.object({ scope: BackendScopeSchema, revision: z.number().int() }).strict() } },
});
