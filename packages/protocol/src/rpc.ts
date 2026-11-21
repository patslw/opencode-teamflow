import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { BackendScopeSchema, ModelCatalogEntrySchema, MutationEnvelopeSchema, MutationResultSchema, SnapshotSchema } from "./index.js";

const sessionInput = z.object({ scope: BackendScopeSchema, sessionId: z.string().min(1) }).strict();
const id = z.string().min(1);
const formBinding = z.object({ runId: id, taskId: id, attemptId: id, sessionId: id }).strict();
const formValue = z.union([z.string().max(32000), z.number().finite(), z.boolean(), z.array(z.string().max(32000)).max(100)]);
export const NativeFormSchema = formBinding.extend({
  formId: id, title: z.string(),
  fields: z.array(z.object({
    key: id, type: z.enum(["string", "number", "integer", "boolean", "multiselect", "external"]),
    title: z.string().optional(), description: z.string().optional(), required: z.boolean().optional(),
    hidden: z.boolean().optional(), custom: z.boolean().optional(),
    default: formValue.optional(),
    options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional(),
  }).passthrough()),
}).strict();
export type NativeForm = z.infer<typeof NativeFormSchema>;
export const CapabilitiesSchema = z.object({
  skills: z.array(z.object({ id, name: z.string(), description: z.string() })),
  tools: z.array(z.object({ id, description: z.string() })),
}).strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const TeamflowDemo = Rpc.define({
  id: "teamflow.demo",
  methods: {
    snapshot: { input: BackendScopeSchema, output: SnapshotSchema },
    capabilities: { input: BackendScopeSchema, output: CapabilitiesSchema },
    models: { input: BackendScopeSchema, output: z.array(ModelCatalogEntrySchema) },
    nativeForms: { input: z.object({ scope: BackendScopeSchema, runId: id }).strict(), output: z.array(NativeFormSchema) },
    nativeFormReply: { input: formBinding.extend({ scope: BackendScopeSchema, formId: id, answer: z.record(id, formValue) }), output: z.object({ accepted: z.literal(true) }) },
    mutate: { input: MutationEnvelopeSchema, output: MutationResultSchema, errors: { rejected: z.object({ reason: z.string() }) } },
    sessionMessages: { input: sessionInput, output: z.array(z.unknown()) },
    sessionSend: { input: sessionInput.extend({ text: z.string().min(1).max(32000) }), output: z.unknown() },
    info: { input: z.object({}).strict(), output: z.object({ backendId: z.string(), directory: z.string(), version: z.string(), runtime: z.record(z.string(), z.string()), sqlite: z.string() }) },
  },
  events: { changed: { schema: z.object({ scope: BackendScopeSchema, revision: z.number().int() }).strict() } },
});
