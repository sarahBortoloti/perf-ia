import type { JavaType, JavaMethod } from '../repository/types.js';
import type { ExternalCall } from './external-call.js';

/** Require an HTTP operation and URL evidence; names such as Gateway alone prove nothing. */
export function discoverHttpCodeCalls(type: JavaType, method: JavaMethod, resolve: (value: string) => string | undefined): ExternalCall[] {
  const tokens = method.tokens ?? [];
  const calls: ExternalCall[] = [];
  const operations: Record<string, string> = { getForObject: 'GET', getForEntity: 'GET', postForObject: 'POST', postForEntity: 'POST', put: 'PUT', delete: 'DELETE', patchForObject: 'PATCH', get: 'GET', post: 'POST', head: 'HEAD', options: 'OPTIONS' };
  const httpType = /(?:^|\.)(?:RestTemplate|WebClient|RestClient|HttpClient|HttpRequest|RequestBuilder)$/;
  function value(token: string): string | undefined {
    const expression = token?.startsWith('"') ? token.slice(1, -1) : type.fieldValues?.[token];
    return expression ? resolve(expression) : undefined;
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index + 1] !== '(') continue;
    const operation = tokens[index];
    const receiver = tokens[index - 1] === '.' ? tokens[index - 2] : undefined;
    const receiverType = receiver ? type.fields[receiver] ?? receiver : '';
    const direct = httpType.test(receiverType);
    // Fluent get()/post() after a known HTTP receiver, or HttpRequest.newBuilder().uri().POST().
    const start = tokens.lastIndexOf(';', index - 1) + 1;
    const endAt = tokens.indexOf(';', index);
    const end = endAt < 0 ? tokens.length : endAt;
    const statement = tokens.slice(start, end);
    const known = direct || statement.some((token) => httpType.test(type.fields[token] ?? token));
    if (!known || !operations[operation] && !['exchange', 'method', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].includes(operation)) continue;
    const methodName = operations[operation] ?? (/^(GET|POST|PUT|DELETE|PATCH|HEAD)$/.test(operation) ? operation : statement.find((token) => /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(token)));
    const urls = [...new Set(statement.map(value).filter((item): item is string => Boolean(item && /^https?:\/\//.test(item))))];
    if (!methodName || urls.length !== 1) continue;
    const url = urls[0];
    let path: string; try { path = new URL(url).pathname; } catch { continue; }
    if (calls.some((call) => call.method === methodName && call.url === url)) continue;
    calls.push({ order: calls.length + 1, client: type.name, clientMethod: method.name, method: methodName, url, path, codeUrl: url, codePath: type.filePath,
      source: 'CODE', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' });
  }
  return calls;
}
