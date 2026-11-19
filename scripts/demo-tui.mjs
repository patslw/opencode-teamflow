import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { TeamflowDemo } from "../dist/packages/protocol/src/rpc.js";
import { homedir } from "node:os";

const config = JSON.parse(await readFile(resolve(process.env.TEAMFLOW_BACKENDS_FILE ?? ".runtime/backends.json"), "utf8"));
const [id = config.selectedBackend, project] = process.argv.slice(2);
const backend = config.backends[id];
if (!backend) throw new Error("Unknown administrator-configured backend ID");
const projects = (backend.projects ?? [backend.projectDirectory]).map(p => resolve(p));
const directory = project ? resolve(project) : projects[0];
if (!projects.includes(directory)) throw new Error("Project not configured for this backend");
const endpoint = backend.connectionFile
  ? JSON.parse(await readFile(resolve(backend.connectionFile), "utf8"))
  : await Service.discover();
const normalized = value => new URL(value).origin.replace("://0.0.0.0:", "://127.0.0.1:").replace("://localhost:", "://127.0.0.1:");
if (!endpoint || normalized(endpoint.url) !== normalized(backend.endpoint)) throw new Error("Backend endpoint identity mismatch");
const client = OpenCode.make({ baseUrl: backend.endpoint, headers: Service.headers(endpoint) });
const rpc = client.rpc(TeamflowDemo);
let info;
for (let attempt = 0; attempt < 30; attempt++) {
  try { info = await rpc.info({}, { location: { directory } }); break; }
  catch (error) { if (attempt === 29) throw error; await new Promise(r => setTimeout(r, 500)); }
}
if (info?.backendId !== id || info.directory !== directory) throw new Error("Plugin backend/project identity mismatch");
// Preserve global and caller CLI settings. Inline arrays REPLACE the global
// array, so explicitly carry its plugin entries into this one-process overlay.
const { execFileSync } = await import("node:child_process");
const binary = process.env.TEAMFLOW_OPENCODE_BIN ?? resolve(homedir(), ".opencode/bin/opencode");
const configDirectory = execFileSync(binary, ["debug", "paths", "config"], { encoding: "utf8" }).trim();
let global = {};
try { global = JSON.parse(await readFile(resolve(configDirectory, "cli.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot safely merge cli.json; preserve it and correct JSON before launching"); }
const inline = JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT ?? "{}");
const packagePath = resolve("plugin");
const plugins = new Map();
for (const entries of [global.plugins ?? [], inline.plugins ?? []]) {
  if (!Array.isArray(entries)) throw new Error("CLI plugins must be an array");
  for (const entry of entries) {
    // 2.3.0 accepts strings (including ordered enable/disable directives)
    // and {package, options?} objects, not legacy tuple entries.
    const identifier = typeof entry === "string" ? entry
      : entry && !Array.isArray(entry) && typeof entry.package === "string" ? entry.package : undefined;
    if (identifier === undefined) throw new Error("CLI plugin must be a string or {package, options?}");
    // Move the entire winning declaration to its last position, preserving
    // directive order. Inline wins by package identifier; never merge options.
    plugins.delete(identifier);
    plugins.set(identifier, entry);
  }
}
// Keep an existing Teamflow object and its options, rather than replacing it.
if (!plugins.has(packagePath)) plugins.set(packagePath, packagePath);
const overlay = { ...inline, plugins: [...plugins.values()] };
console.log(`Teamflow TUI: ${id} · ${directory}; Ctrl+P → Teamflow 流程`);
const child = spawn(binary, ["--server", backend.endpoint, directory], {
  stdio: "inherit", env: { ...process.env,
    OPENCODE_PASSWORD: endpoint.auth?.password ?? "",
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify(overlay),
  },
});
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
