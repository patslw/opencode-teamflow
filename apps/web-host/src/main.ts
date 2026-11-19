import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { createServer as createTLSServer } from "node:https";
import { listenConfig } from "./listen.js";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { backendRegistry } from "./backends.js";

// Local administrator configuration, never supplied by a browser or discovered plugin.
const listen = await listenConfig();
const registry = await backendRegistry(resolve(process.env.TEAMFLOW_BACKENDS_FILE ?? ".runtime/backends.json"));
const address = listen.origin.origin;
async function body(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("application/json required");
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Error("Request too large");
  }
  return JSON.parse(text);
}
const handle: RequestListener = async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  // Reject DNS rebinding and cross-origin browser mutations; no generic upstream proxy.
  if (request.headers.host?.toLowerCase() !== listen.origin.host || (request.headers.origin && request.headers.origin !== address)) {
    response.writeHead(403).end("Forbidden origin/host"); return;
  }
  if (!listen.authenticated(request.headers.authorization)) {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Teamflow", charset="UTF-8"' }).end("Teamflow login required"); return;
  }
  try {
    const url = new URL(request.url ?? "/", address);
    if (url.origin !== address) { response.writeHead(403).end("Forbidden origin"); return; }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      const root = resolve("apps/web/dist");
      const file = resolve(root, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
      if (!file.startsWith(root + sep)) { response.writeHead(403).end("Forbidden path"); return; }
      const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
      response.setHeader("Content-Type", contentTypes[extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file)); return;
    }
    if (request.method === "GET" && url.pathname === "/api/backends") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(registry.catalog)); return;
    }
    const { scope, rpc, options, info, client, readMessages } = await registry.select(url);
    if (response.destroyed) return;
    if (request.method === "GET" && url.pathname === "/api/events") {
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      try {
        // Native server.connected is emitted AFTER its bus subscription exists.
        // RPC's filtered iterable hides that handshake; subscribe to native events
        // instead, then tell the browser to reconcile a snapshot on EVERY connect.
        for await (const event of client.event.subscribe({ types: ["rpc.teamflow.demo.changed"], signal: abort.signal })) {
          if (event.type === "server.connected") {
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.write("event: connected\ndata: {}\n\n");
          } else if (event.type === "rpc.teamflow.demo.changed" && event.location.directory === scope.projectDirectory) {
            response.write(`event: changed\ndata: ${JSON.stringify(event.data)}\n\n`);
          }
        }
      } catch {
        // A closed browser or unavailable event source ends this SSE connection.
        // EventSource reconnects, then the browser refetches authority.
      } finally { response.end(); }
      return;
    }
    let output: unknown;
    if (request.method === "GET" && url.pathname === "/api/info") output = { ...info, scope };
    else if (request.method === "GET" && url.pathname === "/api/snapshot") output = await rpc.snapshot(scope, options);
    else if (request.method === "POST" && url.pathname === "/api/mutate") {
      const input = await body(request);
      if (input.scope?.backendId !== scope.backendId || input.scope?.projectDirectory !== scope.projectDirectory) throw new Error("Mutation envelope scope does not match selected backend/project");
      output = await rpc.mutate(input, options);
    } else if (request.method === "GET" && url.pathname === "/api/session/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      output = await readMessages(sessionId);
    } else if (request.method === "POST" && url.pathname === "/api/session/send") {
      const input = await body(request);
      output = await rpc.sessionSend({ scope, sessionId: input.sessionId, text: input.text }, options);
    } else { response.writeHead(404).end("Not found"); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(output));
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    response.writeHead(400, { "Content-Type": "application/json" });
    // Do not serialize request headers, service registration or transport errors containing secrets.
    const message = error instanceof Error ? error.message :
      (typeof error === "object" && error !== null && "type" in error && error.type === "rejected" && "message" in error && typeof error.message === "string" ? error.message : "Backend rejected request");
    // HTTP400 alone is not proof of non-commit (transport/internal failures can
    // occur after commit). Preserve only the trusted RPC's typed rejection.
    const rejected = typeof error === "object" && error !== null && "type" in error && error.type === "rejected";
    response.end(JSON.stringify({ error: message, ...(rejected ? { outcome: "rejected" } : {}) }));
  }
};
const server = listen.tlsOptions ? createTLSServer(listen.tlsOptions, handle) : createServer(handle);
server.listen(listen.port, listen.host, () => console.log(`Teamflow Demo ${address}; bind=${listen.host}:${listen.port}; configured backends=${registry.catalog.backends.length}`));
