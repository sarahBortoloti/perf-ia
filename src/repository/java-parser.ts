import type { Endpoint, JavaAnnotation, JavaComponent, Controller, FeignClient, JavaType, JavaInvocation } from './types.js';

// Comments and literals are tokens, so their contents cannot become Java syntax.
function tokenize(source: string): string[] {
  return (source.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+|[^\s]/g) ?? [])
    .filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
}
function closing(tokens: string[], start: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[tokens[start]]];
  for (let i = start + 1; i < tokens.length; i++) {
    if (pairs[tokens[i]]) stack.push(pairs[tokens[i]]);
    else if (tokens[i] === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  throw new Error('Unbalanced Java delimiters');
}
function value(tokens: string[]): string[] {
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token === '{' || token === '}') continue;
    if (token === ',') groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups.filter((group) => group.length).map((group) => {
    const expression = group.join('');
    if (group.length === 1 && expression.startsWith('"')) {
      return expression.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (/(?:^|\.)RequestMethod\.\w+$/.test(expression)) return group.at(-1)!;
    return expression;
  });
}
function annotation(tokens: string[], start: number): [JavaAnnotation, number] {
  let i = start + 1;
  let name = tokens[i++];
  while (tokens[i] === '.') { name = tokens[i + 1]; i += 2; }
  const attributes: Record<string, string[]> = {};
  if (tokens[i] === '(') {
    const end = closing(tokens, i);
    let segment = i + 1;
    for (let j = segment; j <= end; j++) {
      if (['{', '(', '['].includes(tokens[j])) { j = closing(tokens, j); continue; }
      if (j === end || tokens[j] === ',') {
        const part = tokens.slice(segment, j);
        const equals = part.indexOf('=');
        if (part.length) attributes[equals < 0 ? 'value' : part[0]] = value(part.slice(equals < 0 ? 0 : equals + 1));
        segment = j + 1;
      }
    }
    i = end + 1;
  }
  return [{ name, attributes }, i];
}
const verbs: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
function paths(a?: JavaAnnotation): string[] {
  return a?.attributes.path ?? a?.attributes.value ?? [''];
}
function join(...parts: string[]): string {
  const path = parts.filter(Boolean).join('/').replace(/\/+/g, '/');
  return '/' + path.replace(/^\/+|\/+$/g, '');
}
function endpoints(annotations: JavaAnnotation[], name: string, basePaths: string[], prefix = ''): Endpoint[] {
  return annotations.flatMap((a) => {
    const methods = verbs[a.name] ? [verbs[a.name]] : a.name === 'RequestMapping' ? a.attributes.method ?? ['ANY'] : [];
    return basePaths.flatMap((base) => paths(a).flatMap((path) => methods.map((httpMethod) => ({ methodName: name, httpMethod, path: join(prefix, base, path) }))));
  });
}
export function parseJavaSource(source: string, filePath: string): { controllers: Controller[]; services: JavaComponent[]; feignClients: FeignClient[]; javaTypes: JavaType[] } {
  const tokens = tokenize(source);
  const packageIndex = tokens.indexOf('package');
  const packageName = packageIndex < 0 ? '' : tokens.slice(packageIndex + 1, tokens.indexOf(';', packageIndex)).join('');
  const result = { controllers: [] as Controller[], services: [] as JavaComponent[], feignClients: [] as FeignClient[], javaTypes: [] as JavaType[] };
  function scan(start: number, end: number): void {
    let pending: JavaAnnotation[] = [];
    for (let i = start; i < end;) {
      if (tokens[i] === '@' && tokens[i + 1] !== 'interface') {
        const [a, next] = annotation(tokens, i); pending.push(a); i = next; continue;
      }
      if (['class', 'interface', 'record', 'enum'].includes(tokens[i])) {
        const name = tokens[i + 1];
        let body = i + 2;
        while (body < end && tokens[body] !== '{') body++;
        if (body === end) break;
        const bodyEnd = closing(tokens, body);
        const component = { name, packageName, filePath, annotations: pending };
        const mapping = pending.find((a) => a.name === 'RequestMapping');
        const feign = pending.find((a) => a.name === 'FeignClient');
        const prefix = feign?.attributes.path?.[0] ?? '';
        const found: Endpoint[] = [];
        const structure: JavaType = { name, packageName, filePath, fields: {}, methods: [] };
        let memberStart = body + 1;
        let methodAnnotations: JavaAnnotation[] = [];
        for (let j = body + 1; j < bodyEnd;) {
          if (tokens[j] === '@') {
            const [a, next] = annotation(tokens, j); methodAnnotations.push(a); j = next; memberStart = j; continue;
          }
          if (['class', 'interface', 'record', 'enum'].includes(tokens[j])) {
            while (j < bodyEnd && tokens[j] !== '{') j++;
            if (j < bodyEnd) j = closing(tokens, j) + 1;
            methodAnnotations = []; memberStart = j; continue;
          }
          if (tokens[j] === '(') {
            const methodName = tokens[j - 1];
            found.push(...endpoints(methodAnnotations, methodName, paths(mapping), prefix));
            const signature = tokens.slice(memberStart, j - 1).filter((t) => !['public', 'private', 'protected', 'static', 'final', 'abstract', 'default', 'synchronized'].includes(t)).join('');
            const endParameters = closing(tokens, j);
            let next = endParameters + 1;
            while (next < bodyEnd && !['{', ';', '='].includes(tokens[next])) next++;
            const invocations: JavaInvocation[] = [];
            if (tokens[next] === '{') {
              const endMethod = closing(tokens, next);
              for (let k = next + 1; k < endMethod; k++) {
                if (tokens[k + 1] === '(' && /^[A-Za-z_$][\w$]*$/.test(tokens[k])) {
                  if (tokens[k - 1] === '.') invocations.push({ receiver: tokens[k - 2], method: tokens[k] });
                  else if (!['if', 'for', 'while', 'switch', 'catch', 'new', 'return'].includes(tokens[k]) && tokens[k - 1] !== 'new') invocations.push({ method: tokens[k] });
                }
              }
              next = endMethod + 1;
            } else if (tokens[next] === ';') next++;
            if (methodName !== name && signature) structure.methods.push({ name: methodName, returnType: signature, invocations });
            methodAnnotations = []; j = next; memberStart = j; continue;
          }
          if (tokens[j] === '{') { methodAnnotations = []; j = closing(tokens, j) + 1; memberStart = j; continue; }
          if (tokens[j] === ';' || tokens[j] === '=') {
            const declaration = tokens.slice(memberStart, j).filter((t) => !['public', 'private', 'protected', 'static', 'final', 'volatile', 'transient'].includes(t));
            const field = declaration.at(-1);
            if (field && declaration.length > 1 && /^[A-Za-z_$][\w$]*$/.test(field)) structure.fields[field] = declaration.slice(0, -1).join('');
            methodAnnotations = []; memberStart = j + 1;
          }
          j++;
        }
        if (pending.some((a) => a.name === 'RestController')) result.controllers.push({ ...component, endpoints: found });
        if (pending.some((a) => a.name === 'Service')) result.services.push(component);
        if (feign) result.feignClients.push({ ...component, clientName: (feign.attributes.name ?? feign.attributes.value ?? feign.attributes.contextId)?.[0], url: feign.attributes.url?.[0], paths: paths(mapping).map((p) => join(prefix, p)), endpoints: found });
        result.javaTypes.push(structure);
        scan(body + 1, bodyEnd);
        pending = []; i = bodyEnd + 1; continue;
      }
      if (tokens[i] === '{' || tokens[i] === '(') { i = closing(tokens, i) + 1; pending = []; continue; }
      if (tokens[i] === ';') pending = [];
      i++;
    }
  }
  scan(0, tokens.length);
  return result;
}
