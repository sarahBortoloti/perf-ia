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

## Processamento de logs

```bash
npm run perf-ai -- generate --application demo-api --repository ./examples/spring-app --flow aceite --logs ./examples/logs/aceite.log
npm run perf-ai -- generate --application demo-api --repository ./examples/spring-app --flow aceite --logs ./examples/logs/aceite.log --trace-id trace-123
```

Arquivos TXT/LOG são lidos linha a linha por streaming. `analyzeLogs` em
`src/logs/log-parser.ts` agrega métricas sem guardar o arquivo ou suas linhas;
`parseLogLine` retorna campos extraídos e texto sanitizado. O uso de memória
acompanha os buffers, a maior linha e o conjunto de IDs de trace distintos.

O parser reconhece campos textuais/JSON, identificadores de trace/correlação,
timestamps, requisições HTTP, status, duração, exceptions e indicações de
Feign, RestTemplate e WebClient. URLs absolutas ou indicações de cliente HTTP
sinalizam chamadas externas; sem esses sinais, um path relativo não é considerado
externo. Cada linha de requisição identificada conta como uma chamada; linhas
apenas de resposta não duplicam essa contagem. Não há correlação entre registros
de requisição/resposta nem inferência de hosts internos.

Com `--trace-id`, somente linhas com o ID exato e continuações contíguas de stack
trace desse fluxo são relevantes. Registros sem ID não são atribuídos ao fluxo.
`Trace IDs found` conta os IDs distintos no arquivo inteiro; as métricas de linhas
relevantes e chamadas respeitam o filtro. A redução de contexto é a porcentagem
de linhas descartadas; arquivos vazios retornam 0%.

Dados sensíveis reconhecidos são mascarados antes de retornar registros ou
exibir mensagens. A CLI exibe apenas as métricas dos logs, sem conteúdo bruto.
