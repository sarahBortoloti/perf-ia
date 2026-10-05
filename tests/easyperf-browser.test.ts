import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EasyPerfPublisher } from '../src/easyperf/easyperf-publisher.js';
import type { EasyPerfConfig, SelectedVirtualization } from '../src/easyperf/types.js';

const browsers: Browser[] = [];
afterEach(async () => { await Promise.all(browsers.splice(0).map((browser) => browser.close())); vi.restoreAllMocks(); });
const config: EasyPerfConfig = { baseUrl: 'http://fixture.easyperf.test/', project: 'Projeto fictício', squad: 'Squad fictícia', manualLogin: false, username: 'fictional-user', password: 'fictional-password' };
const files: SelectedVirtualization[] = ['/customer', '/proposal'].map((path, index) => ({
  filePath: `fictional-${index}.json`, fileName: `fictional-${index}.json`, application: 'demo', flow: 'flow', flowDirectory: 'unused', reviewRequired: false,
  template: { response: { metodo: 'POST', path, status: 200, header: {}, body: {} } },
}));
async function launchFixture(outcome = 'success', multiple = true): Promise<Browser> {
  let html = await readFile(new URL('./fixtures/easyperf.html', import.meta.url), 'utf8');
  html = html.replace('<script>', `<script>document.body.dataset.outcome = '${outcome}';`);
  if (!multiple) html = html.replace('type="file" multiple', 'type="file"');
  let browser: Browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
    // Local fallback for developer machines with Chrome but no bundled Chromium.
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
  browsers.push(browser);
  const newContext = browser.newContext.bind(browser);
  vi.spyOn(browser, 'newContext').mockImplementation(async (...args) => {
    const context = await newContext(...args);
    await context.route('**/*', async (route) => {
      if (route.request().url() === config.baseUrl) await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      else await route.abort();
    });
    return context;
  });
  return browser;
}

describe('EasyPerf publisher with local HTML only', () => {
  it.each([true, false])('authenticates, imports files (multiple=%s), publishes and extracts all endpoints', async (multiple) => {
    const manual = vi.fn(async () => {});
    const progress = vi.fn();
    const result = await new EasyPerfPublisher().publish(files, config, { launch: () => launchFixture('success', multiple), waitForManualLogin: manual, progress, timeout: 3000 });
    expect(result).toEqual({ baseUrl: 'http://virtualization.example.test/', services: [{ method: 'POST', path: '/customer', url: 'http://virtualization.example.test/customer' }, { method: 'POST', path: '/proposal', url: 'http://virtualization.example.test/proposal' }] });
    expect(manual).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith('✓ 2 responses importadas');
    expect(browsers[0].isConnected()).toBe(false);
  }, 20000);

  it('waits for manual login instead of filling credentials', async () => {
    let browser: Browser;
    const manual = vi.fn(async () => {
      const page = browsers[0].contexts()[0].pages()[0];
      expect(await page.getByLabel('Usuário', { exact: true }).inputValue()).toBe('');
      expect(await page.getByLabel('Senha', { exact: true }).inputValue()).toBe('');
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    });
    await new EasyPerfPublisher().publish(files, { ...config, manualLogin: true, username: undefined, password: undefined }, {
      launch: async () => { browser = await launchFixture(); return browser; }, waitForManualLogin: manual, timeout: 3000,
    });
    expect(manual).toHaveBeenCalledOnce();
  }, 20000);

  it.each(['error', 'timeout'])('detects publication %s and closes the browser without exposing session information', async (outcome) => {
    const progress = vi.fn();
    await expect(new EasyPerfPublisher().publish(files, config, { launch: () => launchFixture(outcome), waitForManualLogin: async () => {}, progress, timeout: 2000 })).rejects.toThrow(outcome === 'timeout' ? 'timeout' : 'failed while publishing');
    expect(browsers[0].isConnected()).toBe(false);
    expect(JSON.stringify(progress.mock.calls)).not.toContain('fictional-user');
    expect(JSON.stringify(progress.mock.calls)).not.toContain('fictional-password');
  }, 20000);
});
