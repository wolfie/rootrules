import { readFileSync, statSync } from 'node:fs';
import { RulebookLibrary } from '../library.ts';
import type { Rulebook } from '../types.ts';

// How often to check whether the data file was rebuilt (by `npm run update`).
const CHECK_INTERVAL_MS = 10_000;

/** Loads dist/rulebook.json and transparently reloads it when the file changes. */
export class RulebookStore {
  private readonly file: string;
  private current?: { lib: RulebookLibrary; mtimeMs: number };
  private lastCheck = 0;

  constructor(file: string) {
    this.file = file;
  }

  get(): RulebookLibrary {
    const now = Date.now();
    if (this.current && now - this.lastCheck < CHECK_INTERVAL_MS) return this.current.lib;
    this.lastCheck = now;

    try {
      const { mtimeMs } = statSync(this.file);
      if (this.current?.mtimeMs !== mtimeMs) {
        const book = JSON.parse(readFileSync(this.file, 'utf8')) as Rulebook;
        this.current = { lib: new RulebookLibrary(book), mtimeMs };
        const s = book.meta.source;
        console.error(`root-rules: loaded ${s.game}/${s.locale}/${s.printing} @ ${s.commit.slice(0, 7)} (${book.order.length} rules)`);
      }
    } catch (e) {
      // Keep serving the previous data if a reload fails; fail only when there is none.
      if (!this.current) throw new Error(`Cannot load ${this.file}: ${(e as Error).message}. Run \`npm run update\` first.`);
      console.error(`root-rules: reload failed, keeping previous data: ${(e as Error).message}`);
    }
    return this.current.lib;
  }
}
