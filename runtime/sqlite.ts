import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

// Preserve the repository's prepared-query contract, including atomic D1 batches.
// Execute every batch synchronously inside a transaction: no await can interleave.
export class SQLiteDatabase {
  readonly raw: DatabaseSync;
  private eventListeners = new Set<()=>void>();
  onEventCommit(listener:()=>void) { this.eventListeners.add(listener); return ()=>{this.eventListeners.delete(listener);}; }

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive:true, mode:0o700});
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  }
  prepare(sql: string) { return new SQLiteStatement(this, sql); }
  async batch(statements: SQLiteStatement[]) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        if (statement.db !== this) throw Error('Batch statement belongs to another database');
        return statement.execute();
      });
      this.raw.exec('COMMIT');
      if (statements.some(s => /\bINSERT\s+INTO\s+negotiation_events\b/i.test(s.sql))) {
        for (const listener of this.eventListeners) queueMicrotask(()=>{try{listener();}catch{/* A listener cannot undo a committed transaction. */}});
      }
      return results;
    } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
  migrate(directory: string) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
      if (this.raw.prepare('SELECT name FROM app_migrations WHERE name=?').get(file)) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(readFileSync(join(directory,file),'utf8').replaceAll('--> statement-breakpoint',''));
        this.raw.prepare('INSERT INTO app_migrations VALUES(?,?)').run(file,Date.now());
        this.raw.exec('COMMIT');
      } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
    }
  }
  close() { this.raw.close(); }
  asD1() { return this as unknown as D1Database; }
}
class SQLiteStatement {
  private values: (string|number|null|Uint8Array)[] = [];
  constructor(readonly db: SQLiteDatabase, readonly sql: string) {}
  bind(...values: (string|number|null|Uint8Array)[]) {
    const result = new SQLiteStatement(this.db,this.sql); result.values = values; return result;
  }
  execute() {
    const statement = this.db.raw.prepare(this.sql);
    const results = statement.all(...this.values);
    const meta = this.db.raw.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
    return {success:true, results, meta};
  }
  async all<T>() { return this.execute() as unknown as D1Result<T>; }
  async run<T>() { return this.execute() as unknown as D1Result<T>; }
  async first<T>(column?: string): Promise<T|null> {
    const row = this.db.raw.prepare(this.sql).get(...this.values);
    return (row ? (column ? row[column] : row) : null) as T|null;
  }
}
