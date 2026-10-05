import { checkbox, confirm, input } from '@inquirer/prompts';
import { config as loadEnvironment } from 'dotenv';
import { discoverVirtualizations, validateSelectedFiles, savePublications } from '../../easyperf/virtualization-files.js';
import { parseEasyPerfConfig } from '../../easyperf/easyperf-config.js';
import { EasyPerfPublisher } from '../../easyperf/easyperf-publisher.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';

export async function runPublish(options: { dryRun?: boolean; outputRoot?: string } = {}): Promise<void> {
  loadEnvironment({ quiet: true });
  console.log('PERF AI — EasyPerf Publisher');
  const files = await discoverVirtualizations(options.outputRoot);
  if (!files.length) { console.log('Nenhuma virtualização encontrada em output.'); return; }
  const selection = await checkbox({
    message: 'Quais virtualizações deseja publicar?',
    choices: files.map((file) => ({ name: sanitizeSensitiveData(`${file.application}/${file.flow} — ${file.fileName}${file.reviewRequired ? ' [REVIEW_REQUIRED]' : ''}`), value: file })),
  });
  if (!selection.length) { console.log('Publicação cancelada: nenhum arquivo selecionado.'); return; }
  const selected = await validateSelectedFiles(selection);
  console.log(`${selected.length} virtualizações selecionadas`);
  for (const file of selected) console.log(sanitizeSensitiveData(`✓ ${file.application}/${file.flow}/${file.fileName} validado`));
  const review = selected.filter((file) => file.reviewRequired);
  if (review.length && !await confirm({
    message: sanitizeSensitiveData(`${review.length} arquivo(s) REVIEW_REQUIRED: ${review.map((file) => `${file.application}/${file.flow}/${file.fileName}`).join(', ')}. Você revisou os arquivos e confirma a publicação?`), default: false,
  })) { console.log('Publicação cancelada: revisão não confirmada.'); return; }
  if (options.dryRun) {
    console.log('Dry run: nenhum navegador ou conexão EasyPerf será aberto.');
    for (const file of selected) console.log(sanitizeSensitiveData(`${file.application}/${file.flow}/${file.fileName} → ${file.template.response.metodo} ${file.template.response.path}`));
    return;
  }
  // Check URL/authentication first; ask only for the optional project/squad settings.
  parseEasyPerfConfig({ ...process.env, EASYPERF_PROJECT: process.env.EASYPERF_PROJECT?.trim() || 'pending', EASYPERF_SQUAD: process.env.EASYPERF_SQUAD?.trim() || 'pending' });
  const project = process.env.EASYPERF_PROJECT?.trim() || (await input({ message: 'Qual Projeto / VS?', validate: (value) => value.trim() ? true : 'Informe o projeto.' })).trim();
  const squad = process.env.EASYPERF_SQUAD?.trim() || (await input({ message: 'Qual Squad?', validate: (value) => value.trim() ? true : 'Informe a squad.' })).trim();
  const settings = parseEasyPerfConfig({ ...process.env, EASYPERF_PROJECT: project, EASYPERF_SQUAD: squad });
  console.log('EasyPerf\nUI profile conceitual: ajuste src/easyperf/easyperf-page.ts contra o DOM real antes de utilizar.');
  const result = await new EasyPerfPublisher().publish(selected, settings, {
    progress: (message) => console.log(message),
    waitForManualLogin: async () => { await input({ message: 'Faça login no EasyPerf no navegador aberto.\nApós concluir a autenticação, pressione Enter para continuar.' }); },
  });
  const paths = await savePublications(selected, result);
  console.log('Publicação concluída');
  for (const service of result.services) console.log(sanitizeSensitiveData(`${service.method} ${service.path}\n→ ${service.url}`));
  console.log(sanitizeSensitiveData(`Resultado salvo em:\n${paths.join('\n')}`));
}
