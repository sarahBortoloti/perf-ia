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
Não há publicação, IA/LLM, Playwright, JMeter ou acesso a serviços de negócio.

## Validação local

```bash
npm test
npm run build
npm run lint
```

Os exemplos e testes usam somente dados fictícios. O exemplo possui duas chamadas
Feign: uma com body capturado e uma sem body para validar a revisão obrigatória.
