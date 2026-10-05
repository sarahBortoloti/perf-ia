# Perf AI

MVP local para gerar e publicar virtualizações para testes de performance.

## Primeira etapa

```bash
npm install
npm run build
npm test
npm run perf-ai -- generate
npm run perf-ai -- publish
npm run perf-ai -- virtualize
```

As próximas etapas implementarão análise de repositório, processamento de logs, geração dos JSONs e publicação no EasyPerf.

## Análise local Java/Spring Boot

```typescript
import { analyzeRepository } from './src/repository/index.js';

const analysis = await analyzeRepository('/caminho/do/repositorio-clonado');
```

A análise determinística retorna `controllers`, `services`, `feignClients` e
`configurationFiles`. Endpoints incluem nome do método Java, verbo HTTP e path
combinado. `RequestMapping` sem verbo explícito retorna `ANY`. Arrays de paths e
verbos produzem todas as combinações. Feign Clients incluem nome, URL, paths base
 e endpoints; placeholders são preservados. Os arquivos `application.properties`,
`application.yml`, `application.yaml` e variantes de perfil incluem caminho relativo,
formato e conteúdo original. Não há execução de Java, acesso à rede ou uso de IA.

O parser lê anotações explícitas nas declarações; não resolve herança,
meta-anotações, constantes Java ou expressões. Expressões não literais são
preservadas como texto, não avaliadas. O conteúdo das configurações não é
interpretado nem usado para resolver placeholders. Links simbólicos e diretórios
de dependências/build são ignorados. Caminhos inválidos e delimitadores Java
incompletos geram erro.

`examples/spring-app` contém uma aplicação fictícia com controller, service,
Feign Client e configurações, usada pelos testes da análise.
