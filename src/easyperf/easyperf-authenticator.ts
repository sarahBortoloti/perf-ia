import type { EasyPerfConfig } from './types.js';
import type { EasyPerfPage } from './easyperf-page.js';

export async function authenticateEasyPerf(page: EasyPerfPage, config: EasyPerfConfig, waitForManualLogin: () => Promise<void>): Promise<void> {
  if (config.manualLogin) {
    await waitForManualLogin();
    await page.waitAuthenticated();
  } else {
    if (!config.username || !config.password) throw new Error('Automatic login requires configured credentials');
    await page.login(config.username, config.password);
  }
}
