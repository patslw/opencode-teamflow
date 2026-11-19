import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SnapshotSchema, type BackendScope, type MutationResult, type TeamflowSnapshot, type WorkflowVersion } from "../../packages/protocol/src/index.js";
import { builtins } from "./model.js";

type Statement = { get(...args: unknown[]): any; all(...args: unknown[]): any[]; run(...args: unknown[]): unknown };
type Database = { exec(sql: string): void; query(sql: string): Statement; close(): void };
export type StoredRequest =
  | { state: "completed"; fingerprint: string; result: MutationResult }
  | { state: "in_progress"; fingerprint: string; token: string; process: string; taskId: string };
export interface TeamflowStore {
  read(scope: BackendScope): TeamflowSnapshot;
  transact<T>(scope: BackendScope, change: (snapshot: TeamflowSnapshot) => T): T;
  request(scope: BackendScope, requestId: string): StoredRequest | undefined;
  pendingRequestForTask(scope: BackendScope, taskId: string): (Extract<StoredRequest, { state: "in_progress" }> & { requestId: string }) | undefined;
  reserveRequest(scope: BackendScope, requestId: string, fingerprint: string, token: string, process: string, taskId: string): void;
  saveRequest(scope: BackendScope, requestId: string, fingerprint: string, result: MutationResult, token?: string): void;
  addVersion(backendId: string, template: TeamflowSnapshot["templates"][number], version: WorkflowVersion): void;
  acquire(key: string, owner: string, expiresAt?: number): boolean;
  renew(key: string, owner: string, expiresAt: number): boolean;
  owns(key: string, owner: string): boolean;
  release(key: string, owner: string): void;
  initialize(scope: BackendScope, legacyFile?: string): void;
  close(): void;
  sqliteVersion: string;
}
const key = (s: BackendScope) => JSON.stringify([s.backendId, s.projectDirectory]);
export async function openStore(dataDirectory: string): Promise<TeamflowStore> {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const module = "bun:sqlite";
  const { Database: Driver } = await import(module);
  const db: Database = new Driver(join(dataDirectory, "teamflow.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog (backend TEXT NOT NULL, id TEXT NOT NULL, template TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(backend,id));
    CREATE TABLE IF NOT EXISTS requests (scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS request_reservations (scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, owner_process TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT, PRIMARY KEY(scope,id));
    CREATE UNIQUE INDEX IF NOT EXISTS one_reconciliation_per_task ON request_reservations(scope,task_id) WHERE status='in_progress';
    CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);`);
  let inside = false;
  const atomic = <T>(fn: () => T): T => {
    if (inside) return fn();
    db.exec("BEGIN IMMEDIATE"); inside = true;
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { inside = false; }
  };
  atomic(() => {
    if (!db.query("PRAGMA table_info(request_reservations)").all().some(column => column.name === "result")) db.exec("ALTER TABLE request_reservations ADD COLUMN result TEXT");
  });
  const store: TeamflowStore = {
    sqliteVersion: String(db.query("SELECT sqlite_version() AS version").get().version),
    read(scope) {
      const row = db.query("SELECT body FROM scopes WHERE scope=?").get(key(scope));
      if (!row) throw new Error("Scope not initialized");
      const snapshot = JSON.parse(row.body);
      const catalog = db.query("SELECT template,version FROM catalog WHERE backend=? ORDER BY id").all(scope.backendId);
      snapshot.templates = [...new Map(catalog.map(r => { const t = JSON.parse(r.template); return [t.id, t]; })).values()];
      snapshot.versions = catalog.map(r => JSON.parse(r.version));
      return SnapshotSchema.parse(snapshot);
    },
    transact(scope, change) {
      return atomic(() => {
        const snapshot = store.read(scope), before = snapshot.revision;
        const result = change(snapshot);
        if (result !== null && typeof result === "object" && "then" in result) throw new Error("SQLite transaction callback must be synchronous");
        SnapshotSchema.parse(snapshot);
        db.query("UPDATE scopes SET body=? WHERE scope=?").run(JSON.stringify(snapshot), key(scope));
        for (const event of snapshot.audit) db.query("INSERT OR IGNORE INTO events VALUES(?,?,?,?)").run(event.id, key(scope), snapshot.revision, JSON.stringify(event));
        if (snapshot.revision < before) throw new Error("Revision regression");
        return result;
      });
    },
    request(scope, id) {
      const row = db.query("SELECT fingerprint,result FROM requests WHERE scope=? AND id=?").get(key(scope), id);
      if (row) return { state: "completed", fingerprint: row.fingerprint, result: JSON.parse(row.result) };
      const record = db.query("SELECT fingerprint,token,owner_process,task_id,status,result FROM request_reservations WHERE scope=? AND id=?").get(key(scope), id);
      if (!record) return undefined;
      if (record.status === "completed" && record.result) return { state: "completed", fingerprint: record.fingerprint, result: JSON.parse(record.result) };
      return { state: "in_progress", fingerprint: record.fingerprint, token: record.token, process: record.owner_process, taskId: record.task_id };
    },
    pendingRequestForTask(scope, taskId) {
      const row = db.query("SELECT id,fingerprint,token,owner_process,task_id FROM request_reservations WHERE scope=? AND task_id=? AND status='in_progress'").get(key(scope), taskId);
      return row ? { state: "in_progress", requestId: row.id, fingerprint: row.fingerprint, token: row.token, process: row.owner_process, taskId: row.task_id } : undefined;
    },
    reserveRequest(scope, id, fingerprint, token, process, taskId) {
      if (!inside) throw new Error("Request reservation must commit with recovery intent");
      if (store.request(scope, id)) throw new Error("requestId already occupied");
      db.query("INSERT INTO request_reservations(scope,id,fingerprint,token,owner_process,task_id,status) VALUES(?,?,?,?,?,?,'in_progress')").run(key(scope), id, fingerprint, token, process, taskId);
    },
    saveRequest(scope, id, fingerprint, result, token) {
      if (!inside) throw new Error("Request must commit with state");
      const existing = store.request(scope, id);
      if (token) {
        if (!existing || existing.state !== "in_progress" || existing.token !== token || existing.fingerprint !== fingerprint) throw new Error("Request reservation ownership mismatch");
        // Complete our own reserved row, atomically with state/result. No competing
        // invocation can insert a completed request while this reservation exists.
        db.query("UPDATE request_reservations SET status='completed',result=? WHERE scope=? AND id=? AND token=?").run(JSON.stringify(result), key(scope), id, token);
        return;
      } else if (existing) throw new Error("requestId already occupied");
      db.query("INSERT INTO requests VALUES(?,?,?,?)").run(key(scope), id, fingerprint, JSON.stringify(result));
    },
    addVersion(backend, template, version) {
      const old = db.query("SELECT template,version FROM catalog WHERE backend=? AND id=?").get(backend, version.id);
      if (old) {
        if (JSON.stringify(JSON.parse(old.version)) !== JSON.stringify(version) || JSON.stringify(JSON.parse(old.template)) !== JSON.stringify(template)) throw new Error("Published version is immutable");
        return;
      }
      db.query("INSERT INTO catalog VALUES(?,?,?,?)").run(backend, version.id, JSON.stringify(template), JSON.stringify(version));
    },
    acquire(leaseKey, owner, expiresAt) {
      return atomic(() => {
        const existing = db.query("SELECT owner,expires FROM leases WHERE key=?").get(leaseKey);
        if (existing && existing.owner !== owner && (existing.expires === null || existing.expires > Date.now())) return false;
        db.query("INSERT INTO leases VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires").run(leaseKey, owner, expiresAt ?? null);
        return true;
      });
    },
    release(leaseKey, owner) { db.query("DELETE FROM leases WHERE key=? AND owner=?").run(leaseKey, owner); },
    owns(leaseKey, owner) {
      const lease = db.query("SELECT owner,expires FROM leases WHERE key=?").get(leaseKey);
      return !!lease && lease.owner === owner && (lease.expires === null || lease.expires > Date.now());
    },
    renew(leaseKey, owner, expiresAt) {
      return atomic(() => {
        if (!store.owns(leaseKey, owner)) return false;
        db.query("UPDATE leases SET expires=? WHERE key=? AND owner=?").run(expiresAt, leaseKey, owner);
        return true;
      });
    },
    initialize(scope, legacyFile) {
      atomic(() => {
        for (const item of builtins) store.addVersion(scope.backendId, item.template, item.version);
        if (db.query("SELECT body FROM scopes WHERE scope=?").get(key(scope))) return;
        let legacy: any;
        if (legacyFile && existsSync(legacyFile)) {
          const source: Database = new Driver(legacyFile, { readonly: true });
          try { const row = source.query("SELECT body FROM state WHERE id=1").get(); if (row) legacy = JSON.parse(row.body); }
          finally { source.close(); }
          if (legacy && key(legacy.scope) !== key(scope)) throw new Error("Legacy scope mismatch; migration refused");
          if (legacy && ["runs", "tasks", "attempts", "deliveries", "approvals"].some(k => legacy[k]?.length)) throw new Error("Legacy workflow data requires explicit migration");
        }
        const snapshot: TeamflowSnapshot = {
          scope, revision: legacy?.revision ?? 0, templates: [], versions: [], runs: [],
          members: (legacy?.members ?? []).map((m: unknown) => ({ ...(m as object), legacy: true })),
          tasks: [], attempts: [], deliveries: [], approvals: [], messages: legacy?.messages ?? [],
          topics: [], patches: [], drafts: [], corrections: [],
          audit: [{ id: randomUUID(), at: new Date().toISOString(), type: legacy ? "storage.migrated" : "storage.initialized", actor: "system", detail: legacy ? `Preserved ${legacy.members.length} legacy members, revision ${legacy.revision}; source retained: ${legacyFile}` : "Backend-level SQLite scope initialized" }],
        };
        db.query("INSERT INTO scopes VALUES(?,?)").run(key(scope), JSON.stringify(SnapshotSchema.parse(snapshot)));
      });
    },
    close() { db.close(); },
  };
  return store;
}
