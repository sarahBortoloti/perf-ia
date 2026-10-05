import { chromium, errors, type Browser } from 'playwright';
import { EasyPerfPage } from './easyperf-page.js';
import { authenticateEasyPerf } from './easyperf-authenticator.js';
import { parseEasyPerfResult } from './easyperf-result-parser.js';
import type { EasyPerfConfig, SelectedVirtualization, PublicationResult } from './types.js';

export interface PublisherOptions {
  waitForManualLogin: () => Promise<void>;
  progress?: (message: string) => void;
  launch?: () => Promise<Browser>;
  timeout?: number;
}
export class EasyPerfPublisher {
  async publish(files: SelectedVirtualization[], config: EasyPerfConfig, options: PublisherOptions): Promise<PublicationResult> {
    if (!files.length) throw new Error('No virtualizations selected');
    let browser: Browser | undefined;
    let stage = 'opening browser';
    const progress = options.progress ?? (() => {});
    try {
      browser = await (options.launch ?? (() => chromium.launch({ headless: false })))();
      const context = await browser.newContext();
      const page = new EasyPerfPage(await context.newPage(), undefined, options.timeout);
      progress('✓ navegador aberto');
      stage = 'authentication';
      await page.open(config.baseUrl);
      await authenticateEasyPerf(page, config, options.waitForManualLogin);
      progress('✓ autenticado');
      stage = 'selecting project';
      await page.startVirtualization(); await page.selectProject(config.project);
      progress('✓ projeto selecionado');
      stage = 'selecting squad'; await page.selectSquad(config.squad); progress('✓ squad selecionada');
      stage = 'importing responses'; await page.importResponses(files); progress(`✓ ${files.length} responses importadas`);
      stage = 'publishing service'; await page.publishAndWait(); progress('✓ serviço publicado');
      stage = 'reading publication result';
      return parseEasyPerfResult(await page.readResult(), files);
    } catch (error) {
      // Browser and remote UI errors may contain credentials, URLs or session data.
      const timeout = error instanceof errors.TimeoutError;
      const uncertain = ['publishing service', 'reading publication result'].includes(stage);
      const reason = timeout ? `EasyPerf timeout while ${stage}` : `EasyPerf failed while ${stage}`;
      throw new Error(`${reason}. Verify the UI profile${uncertain ? ' and server result; publication may have occurred. Do not retry automatically.' : '.'}`);
    } finally {
      await browser?.close().catch(() => {});
    }
  }
}
