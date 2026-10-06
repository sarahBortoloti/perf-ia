import { select, input, confirm } from '@inquirer/prompts';
import { resolve } from 'node:path';
import { analyzeRepository } from '../../repository/index.js';
import { validateRepositoryPath } from './interactive-generate.js';
import { discoverPublications, readConfigurationContext } from '../../configuration/configuration-context.js';
import { readConfigurations, isProduction } from '../../configuration/configuration-reader.js';
import { planConfiguration } from '../../configuration/configuration-planner.js';
import { applyConfiguration, saveConfigurationMetadata } from '../../configuration/configuration-writer.js';
import { relevantGitDiff } from '../../configuration/git-diff.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';
import type { ConfigurationProposal } from '../../configuration/models.js';

export async function runConfigure(options: { dryRun?: boolean; publication?: string; outputRoot?: string } = {}): Promise<void> {
  console.log('PERF AI — Configure');
  let publicationPath = options.publication;
  if (!publicationPath) {
    const files = await discoverPublications(options.outputRoot);
    if (!files.length) { console.log('Nenhum publication.json encontrado. Execute publish antes de configure.'); return; }
    publicationPath = await select({ message: 'Qual publicação deseja configurar?', choices: files.map((file) => ({ name: sanitizeSensitiveData(file), value: file })) });
  }
  const context = await readConfigurationContext(publicationPath);
  const repositoryChoice = await select({
    message: 'Qual repositório deseja configurar?',
    choices: [
      { name: 'Repositório da aplicação usado no generate', value: 'application' },
      { name: 'Repositório externo de configuração', value: 'external' },
      { name: 'Informar outro caminho', value: 'other' },
      ...(context.configurationRepository ? [{ name: sanitizeSensitiveData(`ConfigurationRepository salvo: ${context.configurationRepository}`), value: 'saved' }] : []),
    ],
  });
  const askPath = async (message: string): Promise<string> => resolve((await input({ message, validate: validateRepositoryPath })).trim());
  const target = repositoryChoice === 'saved' && context.configurationRepository ? resolve(context.configurationRepository)
    : repositoryChoice === 'application' && context.applicationRepository ? resolve(context.applicationRepository)
    : await askPath(repositoryChoice === 'application' ? 'Informe o caminho do repositório usado no generate:' : 'Informe o caminho do repositório de configuração:');
  const application = repositoryChoice === 'application' ? target : context.applicationRepository ? resolve(context.applicationRepository)
    : await askPath('Informe o repositório da aplicação usado no generate para correlacionar as integrações:');
  for (const path of [target, application]) { const valid = await validateRepositoryPath(path); if (valid !== true) throw new Error(valid); }
  const selectedEnvironment = await select<string>({ message: 'Qual ambiente deseja configurar?', choices: ['DEV', 'T1', 'HOM', 'Sandbox', 'Outro'] });
  const environment = selectedEnvironment === 'Outro' ? (await input({ message: 'Informe o ambiente (produção não é alterada automaticamente):', validate: (value) => value.trim() ? true : 'Informe o ambiente.' })).trim() : selectedEnvironment;
  if (isProduction(environment)) { console.log('PRODUÇÃO: alterações automáticas bloqueadas. Files changed: 0'); return; }
  const repository = await analyzeRepository(application);
  const targetScan = await readConfigurations(target);
  const scans = application === target ? [targetScan] : [await readConfigurations(application), targetScan];
  const plan = planConfiguration(context, repository, scans, target, environment);
  for (const warning of plan.warnings) console.warn(sanitizeSensitiveData(`⚠ ${warning}`));
  if (repository.skippedJavaFiles?.length) console.warn('⚠ Existem arquivos Java ignorados; integrações sem vínculo explícito não serão alteradas.');
  const approved: ConfigurationProposal[] = [];
  for (const proposal of plan.proposals) {
    const change = proposal.change;
    console.log(sanitizeSensitiveData([
      `Integration: ${change.integration}`, '', 'Current:', `${change.property}=${change.previousValue}`, '',
      'Proposed:', `${change.property}=${change.newValue}`, '', 'File:', resolve(target, change.file), '', 'Environment:', environment,
      'Chain:', change.chain.join(' → '),
      ...(change.defaultFallback ? ['⚠ Alteração do default; uma variável definida fora do repositório pode prevalecer.'] : []),
    ].join('\n')));
    if (!options.dryRun && await confirm({ message: 'Aplicar alteração?', default: false })) approved.push(proposal);
  }
  const changes = plan.proposals.map((proposal) => proposal.change);
  const save = () => saveConfigurationMetadata(context, application, target, environment, changes, plan.warnings, Boolean(options.dryRun));
  let metadataPath: string | undefined;
  let count = 0;
  if (!options.dryRun) {
    try {
      count = await applyConfiguration(targetScan, approved, async () => { metadataPath = await save(); });
    } finally { metadataPath = await save(); }
  }
  const diff = await relevantGitDiff(target, changes);
  console.log(`Files changed: ${count}`);
  if (diff.diff) console.log(diff.diff);
  if (options.dryRun) console.log('Dry run: nenhum arquivo ou metadata modificado.');
  else if (metadataPath) console.log(sanitizeSensitiveData(`Metadata/rollback: ${metadataPath}`));
  if (!plan.proposals.length) console.log('Nenhuma alteração segura encontrada; veja os avisos.');
}
