import { parseArgs } from "node:util";
import { isIP } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

const usage = `npm run demo:web -- [--host ADDRESS] [--port PORT] [--public-origin URL]
  Default: http://127.0.0.1:3180. For a LAN address the server uses HTTPS and browser
  Basic auth (user teamflow). Set --public-origin for wildcard binds (0.0.0.0 or ::).
  Optional: --cert FILE --key FILE and/or --password-file FILE. Otherwise openssl
  generates private credentials under .runtime/web-access/<browser-host>/ on first use.
  Environment equivalents: TEAMFLOW_WEB_HOST, _PORT, _PUBLIC_ORIGIN, _CERT, _KEY,
  _PASSWORD_FILE (each prefixed TEAMFLOW_WEB). CLI flags take precedence.`;

const digest = (value: string) => createHash("sha256").update(value).digest();
const dnsName = (s: string) => s.length <= 253 && s.split(".").every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x));
const present = async (path: string) => stat(path).then(() => true, err => { if (err.code === "ENOENT") return false; throw err; });

async function defaultFiles(host: string, tls: boolean, auth: boolean) {
  const base = resolve(".runtime/web-access");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = join(base, host);
  // Create a complete identity before publishing the directory. Never overwrite
  // an existing key or rotate someone's password just because a file is missing.
  if (!(await present(dir))) {
    const tmp = await mkdtemp(join(base, ".new-"));
    try {
      if (tls) execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256",
        "-days", "365", "-subj", "/CN=Teamflow Web", "-addext", "basicConstraints=critical,CA:FALSE",
        "-addext", "extendedKeyUsage=serverAuth", "-addext", `subjectAltName=${isIP(host) ? "IP" : "DNS"}:${host}`,
        "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem")], { stdio: ["ignore", "ignore", "pipe"] });
      if (auth) await writeFile(join(tmp, "password"), randomBytes(24).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
      try { await rename(tmp, dir); } catch (err) { if (!(await present(dir))) throw err; }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }
  return dir;
}

export async function listenConfig() {
  const { values: v } = parseArgs({ options: { host: { type: "string" }, port: { type: "string" },
    "public-origin": { type: "string" }, cert: { type: "string" }, key: { type: "string" },
    "password-file": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (v.help) { console.log(usage); process.exit(0); }
  const opt = (name: Exclude<keyof typeof v, "help">) => v[name] ?? process.env[`TEAMFLOW_WEB_${name.toUpperCase().replaceAll("-", "_")}`];
  let host = opt("host") ?? "127.0.0.1";
  if (host === "localhost") host = "127.0.0.1";
  if (!isIP(host) && !dnsName(host)) throw new Error("Invalid --host: expected an IP address or hostname");
  const portText = opt("port") ?? "3180", port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port (1–65535)");
  const local = host === "127.0.0.1" || host === "::1";
  const explicitOrigin = opt("public-origin");
  if ((host === "0.0.0.0" || host === "::") && !explicitOrigin) throw new Error("Wildcard --host needs --public-origin https://NAME:PORT");
  let cert = opt("cert"), key = opt("key"), passwordFile = opt("password-file");
  if (!!cert !== !!key) throw new Error("--cert and --key must be provided together");
  const tls = !local || !!cert || !!passwordFile || explicitOrigin?.startsWith("https:");
  const proto = tls ? "https:" : "http:";
  const origin = new URL(explicitOrigin ?? `${proto}//${isIP(host) === 6 ? `[${host}]` : host}:${port}`);
  const browserHost = origin.hostname.replace(/^\[|\]$/g, "");
  if (origin.protocol !== proto || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash ||
      (!isIP(browserHost) && !dnsName(browserHost)) || browserHost === "0.0.0.0" || browserHost === "::")
    throw new Error(`Invalid --public-origin; expected a concrete ${proto}//host[:port]`);
  if (!tls && !["127.0.0.1", "localhost", "::1"].includes(browserHost)) throw new Error("External browser origins require HTTPS and authentication");
  if (!tls) return { host, port, origin, tlsOptions: undefined, authenticated: (_header?: string) => true };
  if (!cert || !passwordFile) {
    const dir = await defaultFiles(browserHost, !cert, !passwordFile);
    cert ??= join(dir, "cert.pem"); key ??= join(dir, "key.pem"); passwordFile ??= join(dir, "password");
  }
  const password = (await readFile(passwordFile, "utf8")).trimEnd();
  if (password.length < 12 || /[\r\n]/.test(password)) throw new Error("Expected a single-line web password of at least 12 characters");
  const expected = digest(`Basic ${Buffer.from(`teamflow:${password}`).toString("base64")}`);
  console.log(`HTTPS certificate: ${cert}; browser login: teamflow; password file: ${passwordFile}`);
  return { host, port, origin, tlsOptions: { key: await readFile(key!), cert: await readFile(cert), minVersion: "TLSv1.2" as const },
    authenticated: (header?: string) => !!header && timingSafeEqual(digest(header), expected) };
}
