import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(".runtime/demo-project");
const args = process.argv.slice(2);
if (args.length && (args[0] !== "--endpoint" || args.length !== 2)) {
  throw new Error("Usage: npm run demo:prepare [-- --endpoint http://127.0.0.1:PORT]");
}
const mapping = JSON.parse(await readFile(resolve("config/demo-backends.example.json"), "utf8"));
if (args.length) {
  const u = new URL(args[1]);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "0.0.0.0"].includes(u.hostname) ||
      u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("Expected a local HTTP service origin without credentials");
  u.hostname = "127.0.0.1";
  mapping.backends.local.endpoint = u.origin;
}
await mkdir(directory, { recursive: true });
// Explicit expected address, not adopted from whichever service discovery returns.
await writeFile(resolve(".runtime/backends.json"), JSON.stringify(mapping, null, 2) + "\n", {
  flag: "wx", mode: 0o600,
}).catch(error => {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing backend endpoint mapping preserved.");
});
await writeFile(resolve(directory, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [{ package: resolve("plugin"), options: { backendId: "local" } }],
}, null, 2) + "\n", { flag: "wx", mode: 0o600 }).catch(error => {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing demo location config preserved.");
});
console.log(`Demo location ready: ${directory}`);
