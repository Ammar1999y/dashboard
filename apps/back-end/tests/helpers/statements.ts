/**
 * Records every statement and transaction Drizzle sends, for budgets a count
 * proves and a timing would only suggest.
 *
 * ⚠️ Patches prototypes every Drizzle client shares, so concurrent work in the
 * same process is recorded too: start right before the request under test and
 * stop right after.
 */
import {
  BunSQLPreparedQuery,
  BunSQLSession,
} from 'drizzle-orm/bun-sql/session';

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

export interface StatementRecorder {
  readonly statements: readonly RecordedStatement[];
  /** Top-level transactions begun; savepoints are not counted. */
  transactions: () => number;
  matching: (pattern: RegExp) => RecordedStatement[];
  /** Statements bound to a string parameter that starts with `prefix`. */
  binding: (prefix: string) => RecordedStatement[];
  stop: () => void;
}

/** Runs `before` ahead of every call; the returned function undoes it. */
function intercept<T extends object>(
  target: T,
  name: keyof T & string,
  before: (self: T) => void
): () => void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== 'function') throw new Error(`${name} is no method`);
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value: function (this: T, ...args: unknown[]) {
      before(this);
      return Reflect.apply(original, this, args);
    },
  });
  return () =>
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: original,
    });
}

export function recordStatements(): StatementRecorder {
  const statements: RecordedStatement[] = [];
  let transactions = 0;
  const query = BunSQLPreparedQuery.prototype;
  const record = (self: typeof query) => {
    statements.push(self.getQuery());
  };
  const restores = [
    intercept(query, 'execute', record),
    intercept(query, 'all', record),
    intercept(BunSQLSession.prototype, 'transaction', () => transactions++),
  ];

  return {
    statements,
    transactions: () => transactions,
    matching: (pattern) => statements.filter(({ sql }) => pattern.test(sql)),
    binding: (prefix) =>
      statements.filter(({ params }) =>
        params.some(
          (value) => typeof value === 'string' && value.startsWith(prefix)
        )
      ),
    stop: () => {
      for (const restore of restores) restore();
    },
  };
}
