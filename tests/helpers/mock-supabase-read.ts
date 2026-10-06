/**
 * Minimal read-only Supabase client stand-in for exercising `hydrate`.
 *
 * Serves rows from an in-memory table map through the small slice of the
 * postgrest query-builder surface `supabase-hydrate.ts` actually uses:
 * `.from(table).select(...).eq(...).in(...).order(...).range(...).limit(...)
 * .maybeSingle()`, each awaitable to `{ data, error }`. Filters/sorts/pages are
 * applied so the hydrate path sees exactly what the database would return.
 *
 * OPTIONAL PostgREST FIDELITY (`opts`). To reproduce the production `max-rows`
 * truncation that caused the 15→6 score-matrix collapse, pass `maxRows` (the cap)
 * and `defaultOrder` (the index order a table is served in when the query gives no
 * explicit `ORDER BY`). A query that neither `.order()`s nor `.range()`s then
 * returns AT MOST `maxRows` rows in that default order — exactly what an unbounded
 * `.select("*").eq(...)` gets from PostgREST. A `.range()`d, `.order()`ed read pages
 * safely under the cap, so the fix (selAllByCycle) returns everything.
 */

type Row = Record<string, unknown>;

/** One executed read: the table and the `.eq()` filters it carried. */
export interface QueryLogEntry {
  table: string;
  eq: Record<string, unknown>;
}

export interface MockClientOptions {
  /** When set, every executed read is appended here (table + `.eq` filters) so a
   *  test can assert WHICH tables were read, and for which cycle. */
  log?: QueryLogEntry[];
  /** PostgREST `max-rows` cap. Omitted → unbounded (legacy behaviour). */
  maxRows?: number;
  /** Per-table index order used when a query specifies no explicit `.order()`. */
  defaultOrder?: Record<string, readonly string[]>;
}

function cmp(x: unknown, y: unknown, asc: boolean): number {
  if (x === y) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return ((x as never) < (y as never) ? -1 : 1) * (asc ? 1 : -1);
}

/** Multi-key stable sort — matches PostgREST `ORDER BY col1, col2, …`. */
function sortByKeys(rows: Row[], keys: readonly { col: string; asc: boolean }[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const d = cmp(a[k.col], b[k.col], k.asc);
      if (d !== 0) return d;
    }
    return 0;
  });
}

class Query implements PromiseLike<{ data: Row[] | Row | null; error: null }> {
  private rows: Row[];
  private single = false;
  private orderKeys: { col: string; asc: boolean }[] = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitN: number | null = null;
  constructor(
    rows: Row[],
    private readonly table: string,
    private readonly opts: MockClientOptions,
  ) {
    this.rows = [...rows];
  }
  select(_cols?: string): this {
    return this;
  }
  private eqs: Record<string, unknown> = {};
  eq(col: string, val: unknown): this {
    this.eqs[col] = val;
    this.rows = this.rows.filter((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    const set = new Set(vals);
    this.rows = this.rows.filter((r) => set.has(r[col]));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    // Accumulate keys so `.order(a).order(b)` sorts by (a, b) — not b alone.
    this.orderKeys.push({ col, asc: opts?.ascending ?? true });
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }
  private resolveRows(): Row[] {
    let rows = this.rows;
    if (this.orderKeys.length > 0) {
      rows = sortByKeys(rows, this.orderKeys);
    } else if (this.opts.defaultOrder?.[this.table]) {
      // Serve via the table's index order when the query gave no explicit ORDER BY —
      // this is how PostgREST decides which rows a truncated read keeps.
      rows = sortByKeys(rows, this.opts.defaultOrder[this.table]!.map((c) => ({ col: c, asc: true })));
    }
    if (this.rangeFrom != null && this.rangeTo != null) {
      // A range request is still capped at max-rows within the requested window.
      const windowSize = this.rangeTo - this.rangeFrom + 1;
      const cap = this.opts.maxRows != null ? Math.min(windowSize, this.opts.maxRows) : windowSize;
      rows = rows.slice(this.rangeFrom, this.rangeFrom + cap);
    } else if (this.opts.maxRows != null) {
      rows = rows.slice(0, this.opts.maxRows);
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }
  then<TR = { data: Row[] | Row | null; error: null }, TE = never>(
    onfulfilled?: ((v: { data: Row[] | Row | null; error: null }) => TR | PromiseLike<TR>) | null,
    onrejected?: ((reason: unknown) => TE | PromiseLike<TE>) | null,
  ): Promise<TR | TE> {
    this.opts.log?.push({ table: this.table, eq: { ...this.eqs } });
    const rows = this.resolveRows();
    const data = this.single ? rows[0] ?? null : rows;
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

export interface MockDb {
  [table: string]: Row[];
}

export function makeSupabaseReadClient(db: MockDb, opts: MockClientOptions = {}) {
  return {
    from(table: string) {
      return new Query(db[table] ?? [], table, opts);
    },
    auth: {
      // hydrate() never calls auth; provided for completeness.
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
    },
  };
}
