import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Diagnostic, Project, Transaction } from '../shared/model';
import { canonicalJson } from './canonical';
import { migrateProjectDocument } from './migrate';
import { CoreError, parseProject, parseTransaction, validateProject } from './schema';
import { applyCommands } from './transactions';

type ExtraValidator = (project: Project) => Diagnostic[];
export interface ProjectState { project: Project; canUndo: boolean; canRedo: boolean }
interface StateRow { project: string; cursor: number }

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** One cooperating writer; all durable state changes are SQLite FULL transactions.
 * The owner lease is a PID/session row, not a security boundary against arbitrary DB writers.
 * It survives crashes and is recovered only when the recorded process no longer exists. */
export interface StoreHooks {
  /** Runs inside the open transaction, after the writes and before COMMIT. */
  beforeCommit?: () => void;
  /** Runs only after COMMIT has returned. Used to inject a crash in tests. */
  afterCommit?: () => void;
}
export class ProjectStore {
  private readonly db: DatabaseSync;
  private readonly session = randomUUID();
  private closed = false;
  private owns = false;
  private current!: Project;
  private cursor = 0;
  readonly path: string;

  constructor(path: string, initialProject: Project, private readonly validateExtra?: ExtraValidator, private readonly hooks?: StoreHooks) {
    this.path = path === ':memory:' ? path : resolve(path);
    const existed = this.path !== ':memory:' && existsSync(this.path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    try {
      // Inspect existing formats before changing journal mode or creating tables.
      if (existed) {
        const metadata = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
        if (!metadata) throw new CoreError('INVALID_PROJECT_FILE', 'This database is not a Local Home Studio project.');
        const version = this.db.prepare("SELECT value FROM app_meta WHERE key='format'").get() as { value: string } | undefined;
        if (version?.value !== '1') throw new CoreError('UNSUPPORTED_VERSION', `Unsupported project database version ${version?.value ?? 'unknown'}.`);
      }
      // FULL (2) makes COMMIT durable before it returns. WAL keeps readers from blocking that commit.
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_state(id INTEGER PRIMARY KEY CHECK(id=1), project TEXT NOT NULL, cursor INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS history(position INTEGER PRIMARY KEY, before_project TEXT NOT NULL, after_project TEXT NOT NULL, transaction_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, committed_revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS writer(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, session TEXT NOT NULL);
      `);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const version = this.db.prepare("SELECT value FROM app_meta WHERE key='format'").get() as { value: string } | undefined;
        if (version && version.value !== '1') throw new CoreError('UNSUPPORTED_VERSION', `Unsupported project database version ${version.value}.`);
        const writer = this.db.prepare('SELECT pid, session FROM writer WHERE id=1').get() as { pid: number; session: string } | undefined;
        if (writer && isAlive(writer.pid)) throw new CoreError('PROJECT_IN_USE', 'This project is already open for editing in another session.');
        this.db.prepare('INSERT OR REPLACE INTO writer(id,pid,session) VALUES(1,?,?)').run(process.pid, this.session);
        this.db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('format','1')").run();
        const row = this.db.prepare('SELECT project,cursor FROM project_state WHERE id=1').get() as unknown as StateRow | undefined;
        if (row) {
          const stored = JSON.parse(row.project) as unknown;
          const migrated = migrateProjectDocument(stored);
          this.current = parseProject(migrated);
          this.cursor = row.cursor;
          this.assertValid(this.current);
          this.verifyHistory();
          if (migrated !== stored) this.db.prepare('UPDATE project_state SET project=? WHERE id=1').run(JSON.stringify(this.current));
        } else {
          this.current = parseProject(initialProject);
          this.assertValid(this.current);
          this.db.prepare('INSERT INTO project_state(id,project,cursor) VALUES(1,?,0)').run(JSON.stringify(this.current));
        }
        this.db.exec('COMMIT');
        this.owns = true;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }

  private assertOpen(): void { if (this.closed) throw new CoreError('STORE_CLOSED', 'This project is closed.'); }
  private assertValid(project: Project): void {
    const diagnostics = [...validateProject(project), ...(this.validateExtra?.(project) ?? [])];
    if (diagnostics.length) throw new CoreError('INVALID_PROJECT', diagnostics.map(d => d.message).slice(0, 5).join(' '), diagnostics);
  }
  private verifyHistory(): void {
    const aggregate = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(position),0) AS max FROM history').get() as { count: number; max: number };
    if (!Number.isSafeInteger(this.cursor) || this.cursor < 0 || this.cursor > aggregate.max || aggregate.count !== aggregate.max) throw new CoreError('CORRUPT_HISTORY', 'Project undo history is inconsistent.');
  }
  private checkRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CoreError('INVALID_INPUT', 'Expected revision must be a non-negative integer.');
    if (expectedRevision !== this.current.revision) throw new CoreError('STALE_REVISION', `Project changed from revision ${expectedRevision} to ${this.current.revision}; refresh the proposal.`);
    if (this.current.revision >= Number.MAX_SAFE_INTEGER) throw new CoreError('REVISION_LIMIT', 'This project has reached the supported revision limit.');
  }
  private write(callback: () => void): void {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare('SELECT session FROM writer WHERE id=1').get() as { session: string } | undefined;
      if (owner?.session !== this.session) throw new CoreError('PROJECT_IN_USE', 'This editor no longer owns the project writer session.');
      callback();
      this.hooks?.beforeCommit?.();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* the transaction is already closed */ }
      throw error;
    }
    this.hooks?.afterCommit?.();
  }
  durability(): { journalMode: string; synchronous: number } {
    this.assertOpen();
    const journal = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const sync = this.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    return { journalMode: journal.journal_mode, synchronous: sync.synchronous };
  }
  getState(): ProjectState {
    this.assertOpen();
    const redo = this.db.prepare('SELECT 1 AS present FROM history WHERE position=?').get(this.cursor + 1);
    return { project: structuredClone(this.current), canUndo: this.cursor > 0, canRedo: !!redo };
  }

  /** `source` and AI `allowedIds` must be assigned by the trusted calling adapter. */
  transact(input: Transaction | unknown): ProjectState {
    this.assertOpen();
    const tx = parseTransaction(input);
    const fingerprint = createHash('sha256').update(canonicalJson(tx)).digest('hex');
    const prior = this.db.prepare('SELECT fingerprint FROM requests WHERE request_id=?').get(tx.requestId) as { fingerprint: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError('REQUEST_ID_REUSED', 'This request ID was already used for a different transaction.');
      return this.getState(); // A retry is a no-op, even after undo or further edits.
    }
    this.checkRevision(tx.baseRevision);
    const next = applyCommands(this.current, tx);
    this.assertValid(next);
    const nextCursor = this.cursor + 1;
    this.write(() => {
      this.db.prepare('DELETE FROM history WHERE position>?').run(this.cursor);
      this.db.prepare('INSERT INTO history(position,before_project,after_project,transaction_json) VALUES(?,?,?,?)').run(nextCursor, JSON.stringify(this.current), JSON.stringify(next), JSON.stringify(tx));
      this.db.prepare('INSERT INTO requests(request_id,fingerprint,committed_revision) VALUES(?,?,?)').run(tx.requestId, fingerprint, next.revision);
      this.db.prepare('UPDATE project_state SET project=?,cursor=? WHERE id=1').run(JSON.stringify(next), nextCursor);
    });
    this.current = next;
    this.cursor = nextCursor;
    return this.getState();
  }

  undo(expectedRevision: number): ProjectState { return this.moveHistory(expectedRevision, -1); }
  redo(expectedRevision: number): ProjectState { return this.moveHistory(expectedRevision, 1); }
  private moveHistory(expectedRevision: number, direction: -1 | 1): ProjectState {
    this.assertOpen(); this.checkRevision(expectedRevision);
    const position = direction === -1 ? this.cursor : this.cursor + 1;
    const row = this.db.prepare('SELECT before_project,after_project FROM history WHERE position=?').get(position) as { before_project: string; after_project: string } | undefined;
    if (!row) throw new CoreError(direction === -1 ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO', direction === -1 ? 'There is no edit to undo.' : 'There is no edit to redo.');
    const next = parseProject(JSON.parse(direction === -1 ? row.before_project : row.after_project));
    next.revision = this.current.revision + 1;
    this.assertValid(next);
    const nextCursor = this.cursor + direction;
    this.write(() => { this.db.prepare('UPDATE project_state SET project=?,cursor=? WHERE id=1').run(JSON.stringify(next), nextCursor); });
    this.current = next; this.cursor = nextCursor;
    return this.getState();
  }

  /** Consistent database snapshot, including undo/redo and request IDs.
   * Destination must not exist. Caller stages/copies asset files separately. */
  saveCopy(destinationPath: string): void {
    this.assertOpen();
    const destination = resolve(destinationPath);
    if (destination === this.path || existsSync(destination)) throw new CoreError('DESTINATION_EXISTS', 'Save a copy to a new database path.');
    mkdirSync(dirname(destination), { recursive: true });
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      this.db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
      const copy = new DatabaseSync(temp);
      try {
        copy.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DELETE FROM writer; COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
      } finally { copy.close(); }
      const descriptor = openSync(temp, 'r');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      // Linking within the same directory publishes atomically and refuses a
      // destination created concurrently, instead of overwriting it.
      linkSync(temp, destination);
      unlinkSync(temp);
      const directory = openSync(dirname(destination), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      for (const file of [temp, `${temp}-wal`, `${temp}-shm`]) rmSync(file, { force: true });
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      if (this.owns) this.write(() => { this.db.prepare('DELETE FROM writer WHERE id=1 AND session=?').run(this.session); });
    } finally { this.db.close(); this.closed = true; this.owns = false; }
  }
}
