import type { VirtualizationTemplate } from './virtualization-template.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
export function validateVirtualization(value: unknown): asserts value is VirtualizationTemplate {
  const errors: string[] = [];
  if (!isObject(value) || !isObject(value.response)) throw new Error('Invalid virtualization: response must be an object');
  if (Object.keys(value).some((key) => key !== 'response')) errors.push('unexpected top-level properties');
  const response = value.response;
  if (Object.keys(response).sort().join(',') !== 'body,header,metodo,path,status') errors.push('response must contain exactly metodo, path, status, header and body');
  if (typeof response.metodo !== 'string' || !/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)$/.test(response.metodo)) errors.push('response.metodo must be an HTTP method');
  if (typeof response.path !== 'string' || !response.path.startsWith('/') || /[\r\n\s]/.test(response.path)) errors.push('response.path must be an absolute HTTP path');
  if (typeof response.status !== 'number' || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) errors.push('response.status must be a numeric HTTP status');
  if (!isObject(response.header)) errors.push('response.header must be an object');
  if (!Object.hasOwn(response, 'body') || response.body === undefined) errors.push('response.body must exist');
  if (errors.length) throw new Error(`Invalid virtualization: ${errors.join('; ')}`);
}
