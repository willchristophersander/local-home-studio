import type { Diagnostic, Project, Transaction } from '../shared/model';
import { canonicalJson } from './canonical';
import { CoreError, parseProject, parseTransaction, validateProject } from './schema';
import { applyCommands } from './transactions';

type ExtraValidator = (project: Project) => Diagnostic[];
interface HistoryRow { before: string; after: string }
export interface MemoryState { project: Project; canUndo: boolean; canRedo: boolean }

/**
 * Same command rules as ProjectStore, without durability.
 * The browser preview uses this. Crash recovery is proven on ProjectStore.
 */
export class MemoryStore {
  private current: Project;
  private cursor = 0;
  private readonly history: HistoryRow[] = [];
  private readonly requests = new Map<string, string>();

  constructor(initialProject: Project, private readonly validateExtra?: ExtraValidator) {
    this.current = parseProject(initialProject);
    this.assertValid(this.current);
  }

  private assertValid(project: Project): void {
    const diagnostics = [...validateProject(project), ...(this.validateExtra?.(project) ?? [])];
    if (diagnostics.length) throw new CoreError('INVALID_PROJECT', diagnostics.map(item => item.message).slice(0, 5).join(' '), diagnostics);
  }

  private checkRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CoreError('INVALID_INPUT', 'Expected revision must be a non-negative integer.');
    if (expectedRevision !== this.current.revision) throw new CoreError('STALE_REVISION', `Project changed from revision ${expectedRevision} to ${this.current.revision}; refresh the proposal.`);
  }

  getState(): MemoryState {
    return { project: structuredClone(this.current), canUndo: this.cursor > 0, canRedo: this.cursor < this.history.length };
  }

  transact(input: Transaction | unknown): MemoryState {
    const tx = parseTransaction(input);
    const fingerprint = canonicalJson(tx);
    const prior = this.requests.get(tx.requestId);
    if (prior) {
      if (prior !== fingerprint) throw new CoreError('REQUEST_ID_REUSED', 'This request ID was already used for a different transaction.');
      return this.getState();
    }
    this.checkRevision(tx.baseRevision);
    const next = applyCommands(this.current, tx);
    this.assertValid(next);
    this.history.splice(this.cursor);
    this.history.push({ before: JSON.stringify(this.current), after: JSON.stringify(next) });
    this.requests.set(tx.requestId, fingerprint);
    this.current = next;
    this.cursor += 1;
    return this.getState();
  }

  undo(expectedRevision: number): MemoryState { return this.move(expectedRevision, -1); }
  redo(expectedRevision: number): MemoryState { return this.move(expectedRevision, 1); }

  private move(expectedRevision: number, direction: -1 | 1): MemoryState {
    this.checkRevision(expectedRevision);
    const row = this.history[direction === -1 ? this.cursor - 1 : this.cursor];
    if (!row) throw new CoreError(direction === -1 ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO', direction === -1 ? 'There is no edit to undo.' : 'There is no edit to redo.');
    const next = parseProject(JSON.parse(direction === -1 ? row.before : row.after));
    next.revision = this.current.revision + 1;
    this.assertValid(next);
    this.current = next;
    this.cursor += direction;
    return this.getState();
  }
}
