import { readFile } from "node:fs/promises";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { z } from "zod";
import { TeamflowDemo } from "../../../packages/protocol/src/rpc.js";
import { assertDiscoveredEndpoint, assertPluginIdentity, loadBackendConfig } from "./backend-config.js";

// Only administrator-owned files can supply upstream addresses and credentials.
const ConnectionSchema = z.object({
  url: z.string().url(),
  auth: z.object({ type: z.literal("basic"), username: z.string(), password: z.string().min(1) }).strict(),
}).strict();
export async function backendRegistry(file: string) {
  const config = await loadBackendConfig(file);
  return {
    catalog: { defaultScope: config.defaultScope, backends: config.backends.map(b => ({ backendId: b.backendId, projects: b.projects })) },
    async select(url: URL) {
      const scope = { backendId: url.searchParams.get("backendId") ?? config.defaultScope.backendId,
        projectDirectory: url.searchParams.get("projectDirectory") ?? config.defaultScope.projectDirectory };
      const backend = config.backends.find(b => b.backendId === scope.backendId && b.projects.includes(scope.projectDirectory));
      if (!backend) throw new Error("Backend/project is not configured");
      const endpoint = backend.connectionFile
        ? ConnectionSchema.parse(JSON.parse(await readFile(backend.connectionFile, "utf8")))
        : await Service.discover();
      if (!endpoint) throw new Error("No healthy OpenCode service registered");
      assertDiscoveredEndpoint(backend.endpoint, endpoint.url);
      const client = OpenCode.make({ baseUrl: backend.endpoint, headers: Service.headers(endpoint),
        fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) });
      const rpc = client.rpc(TeamflowDemo);
      const options = { location: { directory: scope.projectDirectory } };
      // Access boots location plugins asynchronously. Cancellation never authorizes a mutation.
      let info;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { info = await rpc.info({}, options); break; }
        catch (error) { if (attempt === 29) throw error; await new Promise(r => setTimeout(r, 500)); }
      }
      if (!info) throw new Error("Plugin identity unavailable");
      assertPluginIdentity(scope, info);
      const readMessages = async (sessionId: string) => {
        // Check membership BEFORE native access, including old cached plugins.
        const snapshot = await rpc.snapshot(scope, options);
        if (!snapshot.members.some(m => m.sessionId === sessionId) && !snapshot.drafts.some(d => d.designer?.sessionId === sessionId) &&
          !snapshot.runs.some(r => r.entry?.state === "ready" && r.entry.sessionId === sessionId))
          throw new Error(`Session ${sessionId} is not registered in this scope`);
        try {
          await client.session.get({ sessionID: sessionId });
          const messages = await rpc.sessionMessages({ scope, sessionId }, options);
          await client.session.get({ sessionID: sessionId });
          return messages;
        } catch (error) {
          throw new Error(`Original native session ${sessionId} unavailable: ${error instanceof Error ? error.message : "Native/RPC read failed; inspect original ID"}`);
        }
      };
      return { scope, info, rpc, options, client, readMessages };
    },
  };
}
