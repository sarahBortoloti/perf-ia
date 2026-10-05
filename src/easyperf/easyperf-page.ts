import type { Page, Locator } from 'playwright';
import type { SelectedVirtualization } from './types.js';

/** CONCEPTUAL fixture profile, NOT verified against a real EasyPerf DOM.
 * Adjust these accessible names/roles here before using the corporate UI.
 * No selector outside this adapter should know EasyPerf's DOM.
 */
export const EASY_PERF_UI = {
  username: 'Usuário', password: 'Senha', login: 'Entrar', newVirtualization: 'Nova Virtualização',
  newVirtualizationRole: 'button' as 'button' | 'link', project: 'Projeto / VS', squad: 'Squad',
  importResponse: 'Importar Response', chooseFiles: 'Escolher Arquivos', imported: 'Responses Importadas',
  publish: 'Publicar Serviço', success: 'Resultado da Publicação', error: 'Erro de Publicação',
  baseUrl: 'IP Base', endpoints: 'Endpoints Criados',
  methodHeader: 'Método', pathHeader: 'Path',
};
export type EasyPerfUiProfile = typeof EASY_PERF_UI;
export interface EasyPerfRawResult { baseUrl: string; endpoints: { method?: string; path: string }[] }

export class EasyPerfPage {
  constructor(private readonly page: Page, private readonly profile: EasyPerfUiProfile = EASY_PERF_UI, private readonly timeout = 30000) {}
  private newVirtualization(): Locator { return this.page.getByRole(this.profile.newVirtualizationRole, { name: this.profile.newVirtualization, exact: true }); }
  async open(baseUrl: string): Promise<void> { await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout }); }
  async login(username: string, password: string): Promise<void> {
    await this.page.getByLabel(this.profile.username, { exact: true }).fill(username, { timeout: this.timeout });
    await this.page.getByLabel(this.profile.password, { exact: true }).fill(password, { timeout: this.timeout });
    await this.page.getByRole('button', { name: this.profile.login, exact: true }).click({ timeout: this.timeout });
    await this.waitAuthenticated();
  }
  async waitAuthenticated(): Promise<void> { await this.newVirtualization().waitFor({ state: 'visible', timeout: this.timeout }); }
  async startVirtualization(): Promise<void> { await this.newVirtualization().click({ timeout: this.timeout }); }
  async selectProject(project: string): Promise<void> { await this.page.getByRole('combobox', { name: this.profile.project, exact: true }).selectOption({ label: project }, { timeout: this.timeout }); }
  async selectSquad(squad: string): Promise<void> { await this.page.getByRole('combobox', { name: this.profile.squad, exact: true }).selectOption({ label: squad }, { timeout: this.timeout }); }
  async importResponses(files: SelectedVirtualization[]): Promise<void> {
    const input = this.page.getByLabel(this.profile.chooseFiles, { exact: true });
    if (!await input.isVisible()) await this.page.getByRole('button', { name: this.profile.importResponse, exact: true }).click({ timeout: this.timeout });
    await input.waitFor({ state: 'attached', timeout: this.timeout });
    const uploads = files.map((file) => ({ name: file.fileName, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file.template)) }));
    if (await input.getAttribute('multiple') !== null) {
      await input.setInputFiles(uploads, { timeout: this.timeout });
      await this.waitImported(files.length);
    } else {
      for (const [index, upload] of uploads.entries()) {
        await input.setInputFiles(upload, { timeout: this.timeout });
        await this.waitImported(index + 1);
      }
    }
  }
  private async waitImported(count: number): Promise<void> {
    // Adapt this acknowledgement to the real UI, not just the file input's value.
    await this.page.getByRole('status', { name: this.profile.imported, exact: true }).filter({ hasText: new RegExp(`^\\s*${count}\\s*$`) }).waitFor({ state: 'visible', timeout: this.timeout });
  }
  async publishAndWait(): Promise<void> {
    await this.page.getByRole('button', { name: this.profile.publish, exact: true }).click({ timeout: this.timeout });
    const outcome = await Promise.race([
      this.page.getByRole('dialog', { name: this.profile.success, exact: true }).waitFor({ state: 'visible', timeout: this.timeout }).then(() => 'success'),
      this.page.getByRole('alert', { name: this.profile.error, exact: true }).waitFor({ state: 'visible', timeout: this.timeout }).then(() => 'error'),
    ]);
    if (outcome === 'error') throw new Error('EasyPerf reported a publication error');
  }
  async readResult(): Promise<EasyPerfRawResult> {
    const dialog = this.page.getByRole('dialog', { name: this.profile.success, exact: true });
    const baseUrl = await dialog.getByRole('textbox', { name: this.profile.baseUrl, exact: true }).inputValue();
    const rows = dialog.getByRole('table', { name: this.profile.endpoints, exact: true }).getByRole('row');
    const endpoints: EasyPerfRawResult['endpoints'] = [];
    for (const row of await rows.all()) {
      if (await row.getByRole('columnheader').count() || await row.getByRole('rowheader').count()) continue;
      const cells = await row.getByRole('cell').allTextContents();
      if (cells[0]?.trim() === this.profile.methodHeader && cells[1]?.trim() === this.profile.pathHeader) continue;
      if (cells.length === 2) endpoints.push({ method: cells[0].trim(), path: cells[1].trim() });
      else if (cells.length === 1) endpoints.push({ path: cells[0].trim() });
    }
    return { baseUrl, endpoints };
  }
}
