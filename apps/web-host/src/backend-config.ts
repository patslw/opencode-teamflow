import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  selectedBackend: z.string().min(1),
  backends: z.record(z.string().min(1), z.object({
    endpoint: z.string().url(),
    projectDirectory: z.string().min(1).optional(),
    projects: z.array(z.string().min(1)).nonempty().optional(),
    connectionFile: z.string().min(1).optional(),
  }).strict()),
}).strict();

// Bind addresses are equivalent only within the local IPv4 service mapping.
// Do not rewrite arbitrary hosts, ports, paths, credentials or protocols.
export function localEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Backend endpoint must be a credential-free local HTTP origin");
  }
  url.hostname = "127.0.0.1";
  return url.origin;
}

export async function loadBackendConfig(file: string) {
  const config = ConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (!config.backends[config.selectedBackend]) throw new Error("Selected backend is not configured");
  const backends = Object.entries(config.backends).map(([backendId, backend]) => {
    const projects = [...new Set((backend.projects ?? (backend.projectDirectory ? [backend.projectDirectory] : [])).map(p => resolve(p)))];
    if (!projects.length) throw new Error(`No projects configured for ${backendId}`);
    return { backendId, endpoint: localEndpoint(backend.endpoint), projects, connectionFile: backend.connectionFile && resolve(backend.connectionFile) };
  });
  const first = backends.find(b => b.backendId === config.selectedBackend)!;
  return { backends, defaultScope: { backendId: first.backendId, projectDirectory: first.projects[0]! } };
}

export function assertDiscoveredEndpoint(expected: string, discovered: string) {
  if (localEndpoint(discovered) !== expected) throw new Error("Discovered OpenCode endpoint does not match configured backend endpoint; refusing to start");
}

export function assertPluginIdentity(scope: { backendId: string; projectDirectory: string }, info: { backendId: string; directory: string }) {
  if (info.backendId !== scope.backendId || info.directory !== scope.projectDirectory) {
    throw new Error("Plugin backend identity or project directory does not match configured backend; refusing to start");
  }
}
