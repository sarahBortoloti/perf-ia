import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository, parseJavaSource } from '../src/repository/index.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'perf-ai-repository-'));
  temporary.push(path);
  return path;
}

describe('parseJavaSource', () => {
  it('parses qualified annotations, path arrays and HTTP method arrays', () => {
    const result = parseJavaSource(`package test.api;
      @org.springframework.web.bind.annotation.RestController
      @RequestMapping(path = {"/v1", "/v2"})
      public class Api {
        @GetMapping(value = {"/items", "/things"}) public String list() { return "ok"; }
        @RequestMapping(path = "/save", method = {RequestMethod.POST, RequestMethod.PUT})
        public void save(@RequestBody String body) {}
        @DeleteMapping public void delete() {}
      }`, 'Api.java');
    expect(result.controllers[0]).toMatchObject({ name: 'Api', packageName: 'test.api', filePath: 'Api.java' });
    expect(result.controllers[0].annotations.map((a) => a.name)).toEqual(['RestController', 'RequestMapping']);
    expect(result.controllers[0].endpoints).toHaveLength(10);
    expect(result.controllers[0].endpoints).toContainEqual({ methodName: 'save', httpMethod: 'PUT', path: '/v2/save' });
    expect(result.controllers[0].endpoints).toContainEqual({ methodName: 'list', httpMethod: 'GET', path: '/v1/things' });
  });

  it('ignores comments, strings, method bodies and unannotated types', () => {
    const parsed = parseJavaSource(`// @RestController class Fake {}
      /* @Service class FakeService {} */
      class Plain { String x = "@FeignClient(name=\\"fake\\")"; }
      @RestController class Real {
        String text = "@GetMapping(\\"/fake\\")";
        @GetMapping public String root() { if (true) { return "}"; } return "{"; }
        public void plain() {}
      }`, 'Real.java');
    expect(parsed.controllers.map((c) => c.name)).toEqual(['Real']);
    expect(parsed.controllers[0].endpoints).toEqual([{ methodName: 'root', httpMethod: 'GET', path: '/' }]);
    expect(parsed.services).toEqual([]);
    expect(parsed.feignClients).toEqual([]);
  });

  it('parses services and nested types without leaking annotations', () => {
    const result = parseJavaSource(`package sample;
      @Service class ServiceImpl {}
      class Outer { @RestController class Inner { @PostMapping("/new") void create() {} } }
      class Other {}`, 'Types.java');
    expect(result.services[0].name).toBe('ServiceImpl');
    expect(result.controllers[0].name).toBe('Inner');
    expect(result.controllers[0].endpoints[0].path).toBe('/new');
  });

  it('parses Feign metadata and combines client, class and method paths', () => {
    const result = parseJavaSource(`@FeignClient(value="catalog", url="\u0024{catalog.url}", path="/remote/")
      @RequestMapping("/v1/") interface Catalog {
        @GetMapping(path="/items/{id}") String get(String id);
        @RequestMapping("/health") String health();
      }
      @FeignClient(name="empty") interface Empty {}`, 'Catalog.java');
    expect(result.feignClients[0]).toMatchObject({ clientName: 'catalog', url: '${catalog.url}', paths: ['/remote/v1'] });
    expect(result.feignClients[0].endpoints).toEqual([
      { methodName: 'get', httpMethod: 'GET', path: '/remote/v1/items/{id}' },
      { methodName: 'health', httpMethod: 'ANY', path: '/remote/v1/health' },
    ]);
    expect(result.feignClients[1]).toMatchObject({ clientName: 'empty', paths: ['/'], endpoints: [] });
  });

  it('handles empty input and reports malformed delimiters', () => {
    expect(parseJavaSource('', 'Empty.java')).toEqual({ controllers: [], services: [], feignClients: [], javaTypes: [] });
    expect(() => parseJavaSource('@RestController class Bad {', 'Bad.java')).toThrow('Unbalanced');
  });
});

describe('analyzeRepository', () => {
  it('analyzes the complete Spring example deterministically', async () => {
    const result = await analyzeRepository('examples/spring-app');
    expect(result.repositoryPath).toBe(resolve('examples/spring-app'));
    expect(result.controllers).toHaveLength(1);
    expect(result.controllers[0].endpoints).toEqual([
      { methodName: 'list', httpMethod: 'GET', path: '/products' },
      { methodName: 'create', httpMethod: 'POST', path: '/products' },
      { methodName: 'update', httpMethod: 'PUT', path: '/products/{id}' },
      { methodName: 'delete', httpMethod: 'DELETE', path: '/products/{id}' },
    ]);
    expect(result.services.map((s) => s.name)).toEqual(['ProductService']);
    expect(result.feignClients[0].endpoints[0].path).toBe('/inventory/products');
    expect(result.configurationFiles.map((f) => f.format)).toEqual(['yaml', 'properties', 'yaml']);
    expect(result.configurationFiles.find((f) => f.format === 'properties')?.content).toContain('inventory.url=');
    expect(await analyzeRepository('examples/spring-app')).toEqual(result);
  });

  it('skips generated directories and symlinks and preserves configuration content', async () => {
    const root = await fixture();
    for (const dir of ['target', 'node_modules', '.git', 'build', 'dist', '.gradle', '.idea']) {
      await mkdir(join(root, dir));
      await writeFile(join(root, dir, 'Ignored.java'), '@Service class Ignored {}');
    }
    await writeFile(join(root, 'Service.java'), '@Service class Active {}');
    await symlink(join(root, 'Service.java'), join(root, 'Linked.java'));
    await symlink(root, join(root, 'cycle'));
    await writeFile(join(root, 'application.yaml'), 'server:\n  port: 9000\n');
    await writeFile(join(root, 'other.yml'), 'ignored: true');
    const result = await analyzeRepository(root);
    expect(result.services.map((s) => s.name)).toEqual(['Active']);
    expect(result.configurationFiles).toEqual([{ filePath: 'application.yaml', format: 'yaml', content: 'server:\n  port: 9000\n' }]);
  });

  it('handles empty repositories and rejects missing or non-directory paths', async () => {
    const root = await fixture();
    expect(await analyzeRepository(root)).toMatchObject({ controllers: [], services: [], feignClients: [], configurationFiles: [] });
    await expect(analyzeRepository(join(root, 'missing'))).rejects.toThrow();
    await writeFile(join(root, 'file'), 'text');
    await expect(analyzeRepository(join(root, 'file'))).rejects.toThrow('not a directory');
  });
});
