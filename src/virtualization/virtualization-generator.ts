import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { FlowContext } from '../flow/flow-context.js';
import type { Confidence } from '../flow/models.js';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import { safeName } from '../shared/safe-name.js';
import { createVirtualizationTemplate } from './virtualization-template.js';
import { validateVirtualization } from './virtualization-validator.js';
import { groupInteractions } from '../flow/interaction-groups.js';

export interface GeneratedFile { fileName: string; confidence: Confidence }
export interface GenerationResult { directory: string; files: GeneratedFile[]; errors: string[]; warnings: string[] }

export class VirtualizationGenerator {
  async generate(context: FlowContext, outputRoot = 'output'): Promise<GenerationResult> {
    const safe = sanitizeValue(context) as FlowContext;
    const root = resolve(outputRoot);
    const directory = join(root, safeName(safe.application, 'application'), safeName(safe.flow), 'virtualization');
    // Reject symlinks along the output path rather than writing outside the intended root.
    let current = root;
    for (const segment of ['', safeName(safe.application, 'application'), safeName(safe.flow), 'virtualization']) {
      if (segment) current = join(current, segment);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Output directory cannot be a symbolic link'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await mkdir(directory, { recursive: true });
    safe.externalCalls = groupInteractions(safe.externalCalls);
    const result: GenerationResult = { directory, files: [], errors: [], warnings: [] };
    for (const call of safe.externalCalls) {
      if (call.virtualizationStatus === 'NO_SUCCESSFUL_RESPONSE') { result.warnings.push(`NO_SUCCESSFUL_RESPONSE: ${call.method} ${call.path}; no virtualization generated.`); continue; }
      if (call.conflict) { result.warnings.push(`VIRTUALIZATION_CONFLICT: ${call.method} ${call.path}; ${call.occurrences} occurrences, ${call.distinctBehaviors} distinct behaviors. No response selected automatically.`); continue; }
      const template = createVirtualizationTemplate(call);
      try { validateVirtualization(template); }
      catch (error) { result.errors.push(`Call ${call.order}: ${error instanceof Error ? error.message : String(error)}`); continue; }
      const base = safeName(call.client ?? call.path ?? 'integration', 'integration');
      let suffix = 1;
      while (true) {
        const fileName = `${base}${suffix === 1 ? '' : `-${suffix}`}.json`;
        try {
          await writeFile(join(directory, fileName), JSON.stringify(template, null, 2) + '\n', { flag: 'wx' });
          result.files.push({ fileName, confidence: call.reviewReasons?.length ? 'REVIEW_REQUIRED' : call.confidence });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          suffix++;
        }
      }
    }
    // Context is the latest run; virtualization files are never silently overwritten.
    const contextPath = join(directory, '..', 'flow-context.json');
    try { if ((await lstat(contextPath)).isSymbolicLink()) throw new Error('FlowContext cannot be a symbolic link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(contextPath, JSON.stringify(safe, null, 2) + '\n');
    return result;
  }
}
