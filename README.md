# Perf AI

MVP local e determinístico para analisar Java/Spring Boot, reconstruir fluxos de
logs e gerar arquivos de virtualização no contrato EasyPerf.

## Assistente interativo

```bash
npm install
npm run generate
```

Informe aplicação, repositório local e um arquivo TXT/LOG. O assistente analisa o
repositório e oferece os endpoints encontrados para seleção. Trace ID é opcional;
Enter analisa sem esse filtro. O nome do fluxo deriva do path selecionado.

## Modo por argumentos

```bash
npm run perf-ai -- generate \
  --application demo-api \
  --repository ./examples/spring-app \
  --flow aceite \
  --logs ./examples/logs/aceite.log
```

Adicione `--trace-id trace-123` para restringir a análise. O endpoint é identificado
pelas requisições de entrada encontradas nos logs. Se houver ambiguidade, use
`--endpoint "GET /products"` ou o assistente. `application`, `repository` e `flow`
são obrigatórios no modo por argumentos. Sem `--logs`, a análise de repositório
continua disponível como antes.

Caminhos locais usam as APIs de path do Node e podem ser caminhos Windows nativos.
Coloque caminhos com espaços entre aspas. Aplicação, fluxo e nomes dos arquivos
são convertidos em identificadores seguros para filesystem, incluindo proteção
contra nomes reservados do Windows.

## Análise e evidências

`analyzeRepository` em `src/repository/index.ts` identifica controllers, services,
endpoints, Feign Clients e configurações application.properties/yml/yaml, incluindo
perfis. O parser Java usa tokens e balanceamento de delimitadores. Não executa
Java nem resolve herança, meta-anotações ou expressões/constantes arbitrárias.
O FlowBuilder segue chamadas explícitas controller → service → Feign; tipos ou
métodos ambíguos não são inferidos. Invocações estáticas são possibilidades de
execução, identificadas como `CODE`, e requerem revisão.

Logs são lidos por streaming, sem readFile nem cópia do arquivo original. O parser
extrai trace/correlation IDs, timestamps, HTTP, status, duração, exceptions e
indicações de Feign, RestTemplate e WebClient. As métricas guardam contadores e
IDs distintos. A construção do fluxo guarda apenas chamadas e evidências de
resposta necessárias para os artefatos, não as linhas do arquivo inteiro.

Com Trace ID, a seleção usa o ID exato e continuações contíguas de stack/JSON.
Sem filtro, traces identificados pelas entradas do endpoint selecionado delimitam
as chamadas do fluxo, quando disponíveis; sem essa evidência, o arquivo fornecido
é a fonte runtime. `Trace IDs found` conta IDs distintos no arquivo inteiro.
A redução de contexto mede a porcentagem de linhas descartadas; arquivo vazio é
0%. Requisições contam como chamadas; respostas não duplicam a contagem.

A correlação de respostas usa trace, request/correlation ID e identificação do
cliente/método. Respostas ambíguas ficam sem body/status atribuídos. São suportados
`responseBody=<JSON>`, `responseHeaders=<JSON>` e payload JSON separado após uma
resposta Feign, inclusive em múltiplas linhas. A acumulação de um payload em
múltiplas linhas tem limite de 1 MiB; payloads incompletos/excessivos não viram
evidência. Chamadas de código e log correlacionadas recebem `CODE_AND_LOG`;
chamadas runtime sem correlação recebem `LOG`.

A prioridade do response body é:

1. Body capturado no log: `LOG / HIGH`.
2. Exemplo de resposta OpenAPI/Swagger local (JSON/YAML, referências locais):
   `OPENAPI / HIGH` ou `MEDIUM` quando o status não foi capturado.
3. Mock/fixture que identifica método/path e resposta: `EXISTING_MOCK / HIGH`
   ou `MEDIUM` conforme a evidência de status. Aceita WireMock, contrato EasyPerf
   e fixtures com method/path/responseBody.
4. DTO de retorno identificado: campos com valores null, `DTO / REVIEW_REQUIRED`.
5. Sem evidência: `{}`, `EMPTY / REVIEW_REQUIRED`.

Não há valores de negócio sintetizados. Referências externas OpenAPI não são
consultadas. Sem status capturado, o template usa 200 e o FlowContext registra
explicitamente essa ausência em reviewReasons; o arquivo requer revisão.
Paths com parâmetros não resolvidos e chamadas apenas estáticas também requerem
revisão. Headers não capturados usam Content-Type application/json no template.

## Output

```text
output/<application>/<flow>/flow-context.json
output/<application>/<flow>/virtualization/<client>.json
```

O FlowContext contém entrypoint, chamadas ordenadas, origem, bodySource,
confidence e evidências. Cada virtualização tem exatamente:

```json
{
  "response": {
    "metodo": "POST",
    "path": "/cws/v1/fwrk/flow/system",
    "status": 200,
    "header": { "Content-Type": "application/json" },
    "body": {}
  }
}
```

Metadados permanecem no FlowContext. Arquivos de virtualização existentes nunca
são sobrescritos: duplicatas usam -2, -3 etc. O flow-context.json representa a
execução mais recente. Virtualizações inválidas são reportadas e não são salvas;
o comando termina com erro se alguma falhar na validação.

Dados sensíveis são mascarados antes de retornar/persistir bodies, headers ou
exibir mensagens. O terminal apresenta somente resumos e nomes seguros.
Arquivos REVIEW_REQUIRED devem ser revisados antes da importação no EasyPerf.
A geração não acessa o EasyPerf; publicação é um comando separado. Não há IA/LLM ou JMeter.

## Validação local

```bash
npm test
npm run build
npm run lint
```

Os exemplos e testes usam somente dados fictícios. O exemplo possui duas chamadas
Feign: uma com body capturado e uma sem body para validar a revisão obrigatória.

## Publicação no EasyPerf

```bash
npm run perf-ai -- publish --dry-run
npm run publish
```

O checkbox mostra aplicação/fluxo/arquivo. Space seleciona, setas navegam e Enter
confirma; nenhuma seleção ou Ctrl+C cancela. Todos os arquivos selecionados são
validados antes do navegador. Metadata REVIEW_REQUIRED, reviewReasons ou metadata
ilegível exige confirmação explícita. O dry run valida e lista os arquivos, sem
navegador, acesso ao EasyPerf ou escrita de publication.json; não exige .env.

Copie `.env.example` para `.env` e configure:

```dotenv
EASYPERF_BASE_URL=https://seu-easyperf/
EASYPERF_PROJECT=Seu Projeto / VS
EASYPERF_SQUAD=Sua Squad
EASYPERF_MANUAL_LOGIN=true
```

BASE_URL é obrigatória na publicação real. Projeto e squad vazios são perguntados
no terminal. Login manual abre um navegador visível e espera Enter depois da
sua autenticação. Para login automático, defina EASYPERF_MANUAL_LOGIN=false e
EASYPERF_USERNAME/EASYPERF_PASSWORD no .env. Credenciais e sessão não são gravadas
nem exibidas. `.env` e `.env.*` são ignorados pelo Git, com exceção de .env.example.
Instale o navegador localmente antes da publicação real:

```bash
npx playwright install chromium
```

**O DOM real do EasyPerf não foi disponibilizado nem acessado.** O perfil de UI em
`src/easyperf/easyperf-page.ts` usa nomes acessíveis conceituais, verificados apenas
na fixture HTML local. Ajuste esse arquivo contra a UI real antes do uso: login,
navegação, comboboxes, input de upload, contador de responses importadas, modal de
sucesso/erro e campos do resultado. Todos os seletores ficam nesse adaptador; ele
não tenta contornar SSO, MFA ou CAPTCHA.

O publisher usa Chromium com headless=false e sessão efêmera, importa múltiplos
JSONs quando o input permite; caso contrário, importa um por vez aguardando o
contador de confirmação. O upload usa buffers sanitizados e não modifica os
arquivos originais. Aguarda sucesso/erro com locators e timeout, sem sleeps fixos.
Não há retentativa automática de publicação.

O resultado confirma os métodos/paths selecionados, normaliza IP Base e URLs e
salva `output/<application>/<flow>/publication.json`. Seleções de vários fluxos
geram um arquivo por fluxo com os respectivos endpoints. O arquivo registra
application, flow, publishedAt, baseUrl e services (method/path/url), sem sessão.
Publication.json representa a publicação mais recente daquele fluxo. Se houver
falha depois de acionar Publicar Serviço, verifique o resultado no EasyPerf antes
de repetir; o serviço pode ter sido criado mesmo sem confirmação local.

Os testes usam `tests/fixtures/easyperf.html` com todas as requisições interceptadas
localmente. Não usam EasyPerf real, internet ou credenciais reais. Para os testes
com browser, Chromium deve estar instalado; Chrome local é utilizado como fallback
quando Chromium não estiver disponível.

## Configure

Depois de publicar, execute `npm run configure`. O comando seleciona um
`publication.json` em `output`, pede o repositório e o ambiente e correlaciona
as integrações do FlowContext com suas propriedades. Se o caminho da aplicação
não estiver salvo, ele será solicitado para consultar os FeignClients.

```bash
npm run configure -- --dry-run
npm run configure
# Publicação fictícia para experimentar sem alterar arquivos:
npm run configure -- --dry-run --publication ./examples/configure-fixture/published/publication.json
```

Na fixture, selecione o repositório externo `./examples/configure-fixture/config`,
informe a aplicação `./examples/configure-fixture/app` e escolha HOM.
O preview mostra a cadeia `${proposal.url}` → `${API_PROPOSAL_URL}` →
`hom/values.yaml`. Cada alteração real exige confirmação individual.

Produção e propriedades sensíveis são bloqueadas. Configurações ausentes,
ambíguas ou sem correlação segura geram avisos. Defaults `${VAR:default}` podem
ser propostos quando a variável não está definida no repositório, com aviso de
que variáveis externas podem prevalecer. Nenhuma URL Java literal é reescrita.

`configuration.json`, junto da publicação em `output/<application>/<flow>`,
registra propriedade, arquivo, ambiente, valores anterior/novo e `applied` para
rollback lógico. Não copia arquivos inteiros nem secrets. O helper
`rollbackConfiguration` restaura apenas propriedades que ainda correspondem ao
valor aplicado. Em diretórios Git, o comando executa `git diff` e exibe somente
as propriedades aprovadas, evitando expor outras alterações ou secrets.
Dry-run não grava configurações ou metadados. Não há commit, push ou PR.
