import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';
import type { ConfigurationChange } from './models.js';

const execute = promisify(execFile);
export async function relevantGitDiff(repository: string, changes: ConfigurationChange[]): Promise<{ isGit: boolean; diff: string }> {
  try { await execute('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repository }); }
  catch { return { isGit: false, diff: '' }; }
  const files = [...new Set(changes.filter((change) => change.applied).map((change) => change.file))];
  if (!files.length) return { isGit: true, diff: '' };
  // Execute the real diff, but never expose other preexisting modifications or secrets.
  await execute('git', ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', '--', ...files], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
  const relevant = changes.filter((change) => change.applied).map((change) => [
    `diff --git a/${change.file} b/${change.file}`, `@@ ${change.property} (${change.environment}) @@`,
    `-${change.property}=${change.previousValue}`, `+${change.property}=${change.newValue}`,
  ].join('\n'));
  return { isGit: true, diff: sanitizeSensitiveData(relevant.join('\n')) };
}
