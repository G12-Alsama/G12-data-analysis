/**
 * Opt-in REAL-PostgreSQL harness for migration/RPC behaviour tests.
 *
 * The repo's migrations are applied by a human in the Supabase SQL editor, so CI can
 * only assert on the SQL text. These tests go further: they build a throwaway
 * database on a LOCAL PostgreSQL server, apply the real migration chain onto minimal
 * Supabase stubs, and execute the actual functions/constraints.
 *
 * Off by default. Set `G12_TEST_PG_ADMIN_URL` to a superuser connection on a local
 * server, e.g. a unix-socket URI:
 *     G12_TEST_PG_ADMIN_URL='postgresql://postgres@/postgres?host=/var/tmp/g12-pg'
 *
 * SAFETY — this must never touch a real database:
 *   * the host must be a unix-socket directory or localhost/127.0.0.1/::1 — anything
 *     else (e.g. *.supabase.co) is refused outright;
 *   * it only ever creates, uses and drops its OWN randomly named scratch database.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_URL = process.env.G12_TEST_PG_ADMIN_URL ?? "";
const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const STUBS = path.resolve(__dirname, "supabase-stubs.sql");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `postgres[ql]://[user[:pw]@]host[:port]/db[?query]` — hand-parsed because the
 *  socket form (`postgresql://postgres@/postgres?host=/dir`) is not a valid WHATWG URL. */
const PG_URI = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?]*)(?::\d+)?(?:\/([^?]*))?(?:\?(.*))?$/;

function parsePgUri(raw: string): { host: string; query: URLSearchParams } {
  const m = PG_URI.exec(raw);
  if (!m) throw new Error("scratch-pg: unparseable connection URI");
  return { host: m[1] ?? "", query: new URLSearchParams(m[3] ?? "") };
}

function isLocalHost(h: string): boolean {
  return h.startsWith("/") || LOCAL_HOSTS.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Throws unless EVERY host the URI could connect to is local: the authority host,
 * the `host=` and `hostaddr=` parameters (libpq lets either override the authority),
 * and no multi-host lists. Exported for the self-test.
 */
export function assertLocalPg(raw: string): void {
  const { host, query } = parsePgUri(raw);
  const candidates = [host, query.get("host") ?? "", query.get("hostaddr") ?? ""].filter((h) => h !== "");
  for (const c of candidates) {
    if (c.includes(",") || !isLocalHost(c)) {
      throw new Error(`scratch-pg refuses non-local host "${c}" — local servers only`);
    }
  }
}

const hasPsql = (): boolean => spawnSync("psql", ["--version"], { stdio: "ignore" }).status === 0;

/** True when the opt-in harness can run here. */
export const PG_AVAILABLE: boolean = ADMIN_URL !== "" && hasPsql();

/** The same URI pointed at database `db`. */
function withDb(raw: string, db: string): string {
  return raw.replace(/^(postgres(?:ql)?:\/\/(?:[^@/]*@)?(?:\[[^\]]*\]|[^/:?]*)(?::\d+)?)(?:\/[^?]*)?/, `$1/${db}`);
}

function psql(url: string, sql: string, extra: string[] = []): string {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...extra, "-f", "-"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).trim().split("\n").slice(0, 6).join("\n")}`);
  return r.stdout;
}

/** Migration files in apply order (lexical, rollbacks excluded), optionally up to and
 *  including a numeric prefix, e.g. upTo "0048". */
export function migrationFiles(upTo?: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".rollback.sql"))
    .filter((f) => upTo === undefined || f.slice(0, 4) <= upTo)
    .sort();
}

export interface ScratchDb {
  /** Run SQL; returns psql's unaligned, tuples-only stdout. `-v name=value` pairs via `vars`. */
  run(sql: string, vars?: Record<string, string>): string;
  /** Apply a migration file by name. */
  apply(file: string): void;
  dispose(): void;
}

/** Create a throwaway DB, install the stubs and apply migrations up to `upTo`. */
export function createScratchDb(upTo?: string): ScratchDb {
  assertLocalPg(ADMIN_URL);
  const name = `g12_test_${randomBytes(5).toString("hex")}`;
  psql(withDb(ADMIN_URL, "postgres"), `create database ${name};`);
  const url = withDb(ADMIN_URL, name);
  const run = (sql: string, vars: Record<string, string> = {}) =>
    psql(url, sql, Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]));
  try {
    run(readFileSync(STUBS, "utf8"));
    for (const f of migrationFiles(upTo)) run(readFileSync(path.join(MIGRATIONS, f), "utf8"));
  } catch (e) {
    psql(withDb(ADMIN_URL, "postgres"), `drop database if exists ${name};`);
    throw e;
  }
  return {
    run,
    apply: (file) => void run(readFileSync(path.join(MIGRATIONS, file), "utf8")),
    dispose: () => void psql(withDb(ADMIN_URL, "postgres"), `drop database if exists ${name};`),
  };
}
