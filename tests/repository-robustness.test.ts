import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository, parseJavaSource, JavaParseError, formatRepositoryDiagnostics, getEndpointAnalysisStatus, formatEndpointWarning } from '../src/repository/index.js';
import { tokenizeJava, matchJavaDelimiters } from '../src/repository/java-lexer.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'perf-ai-java-robustness-'));
  temporary.push(root);
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

const validCases = [
  {
    file: 'JsonController.java', name: 'JsonController', path: '/json',
    source: String.raw`@RestController class JsonController {
      @GetMapping("/json") public String json() { return "{\"items\":[{\"name\":\"{}\"}]}"; }
    }`,
  },
  {
    file: 'BracesController.java', name: 'BracesController', path: '/braces',
    source: String.raw`@RestController class BracesController {
      @GetMapping("/braces") public String braces() { char bracket = '{'; char quote = '\''; return "{}" + " ) ] } "; }
    }`,
  },
  {
    file: 'CommentsController.java', name: 'CommentsController', path: '/comments',
    source: String.raw`// { } ) ] ((( " @RestController class Fake {}
    @RestController class CommentsController {
      /* {} [ ( } """ @FeignClient(name="fake") */
      @GetMapping("/comments") public String comments() { return "https://example.test/*/value"; }
    } // ) ]`,
  },
  {
    file: 'TextBlockController.java', name: 'TextBlockController', path: '/text-block',
    source: String.raw`@RestController class TextBlockController {
      @GetMapping("/text-block") public String json() { return """
        {"items":[{"braces":"{}", "unmatched":"[ ( }"}], "comment":"/* not a comment */"}
        """; }
    }`,
  },
  {
    file: 'EscapedTextBlockController.java', name: 'EscapedTextBlockController', path: '/escaped-block',
    source: String.raw`@RestController class EscapedTextBlockController {
      @GetMapping("/escaped-block") public String text() { return """
        Escaped quote \"""
        [( literal delimiters, not Java syntax
        """; }
    }`,
  },
  {
    file: 'AnnotationsController.java', name: 'AnnotationsController', path: '/annotations/{id}',
    source: String.raw`@RestController
    @Custom(types={String.class, Object.class}, nested=@Nested(value="{ [ ("))
    class AnnotationsController {
      @GetMapping("/annotations/{id}") @Pattern(regexp="[{}()\\[\\]]+")
      public String annotation(@PathVariable String id) { return "{\"id\":\"fixture\"}"; }
    }`,
  },
  {
    file: 'PrototypeController.java', name: 'PrototypeController', path: '/prototype',
    source: String.raw`@RestController class PrototypeController {
      @GetMapping("/prototype") public String toString() { return "{}"; }
      public String constructor() { return "constructor"; }
      public Object valueOf() { return null; }
      public boolean hasOwnProperty() { return false; }
    }`,
  },
];

describe('Java structural lexical analysis', () => {
  it.each(validCases)('parses $file without counting literal or comment delimiters', ({ file, name, path, source }) => {
    const result = parseJavaSource(source, file);
    expect(result.controllers).toHaveLength(1);
    expect(result.controllers[0].name).toBe(name);
    expect(result.controllers[0].endpoints).toHaveLength(1);
    expect(result.controllers[0].endpoints[0]).toMatchObject({ httpMethod: 'GET', path });
  });

  it('retains annotation strings in semantic tokens and removes literals/comments from structural tokens', () => {
    const lexical = tokenizeJava(String.raw`@GetMapping("/items/{id}") class Items { String s="[ ( }"; /* { ( ] */ }`);
    expect(lexical.values).toContain('"/items/{id}"');
    expect(lexical.structural).not.toContain('"/items/{id}"');
    expect(lexical.structural.filter((token) => token === '{')).toHaveLength(1);
    expect(() => matchJavaDelimiters(lexical.structural)).not.toThrow();
  });

  it.each(['class Broken {', 'class Broken { void test(] {} }', 'class Broken {} }'])('rejects truly unbalanced syntax with file context: %s', (source) => {
    try {
      parseJavaSource(source, 'src/Broken.java');
      throw new Error('Expected parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(JavaParseError);
      if (!(error instanceof JavaParseError)) throw error;
      expect(error.filePath).toBe('src/Broken.java');
      expect(error.reason).toBe('Unbalanced Java delimiters');
      expect(error.declaredTypes).toContain('Broken');
    }
  });

  it.each([
    ['class Broken { String x = "unfinished;', 'string literal'],
    ["class Broken { char x = 'unfinished;", 'character literal'],
    ['class Broken { String x = """\nunfinished', 'text block'],
    ['class Broken { /* unfinished', 'block comment'],
  ])('reports lexical failures without pretending malformed source was analyzed', (source, description) => {
    expect(() => parseJavaSource(source, 'Broken.java')).toThrow(`Unterminated Java ${description}`);
  });
});

describe('per-file repository recovery and diagnostics', () => {
  it('continues past a bad file, returns every valid component, and keeps original files unchanged', async () => {
    const files = Object.fromEntries(validCases.map((item) => [`src/${item.file}`, item.source]));
    const broken = '@Service class Broken { void run() {';
    files['src/AAA-Broken.java'] = broken;
    files['src/ValidService.java'] = '@Service class ValidService {}';
    files['src/ValidClient.java'] = '@FeignClient(name="fixture-client") interface ValidClient { @GetMapping("/external") String read(); }';
    const root = await fixture(files);
    const result = await analyzeRepository(root);
    expect(result.javaFilesAnalyzed).toBe(9);
    expect(result.skippedJavaFiles).toEqual([{ filePath: 'src/AAA-Broken.java', reason: 'Unbalanced Java delimiters', declaredTypes: ['Broken'] }]);
    expect(result.incomplete).toBe(true);
    expect(result.controllers).toHaveLength(7);
    expect(result.controllers.flatMap((controller) => controller.endpoints)).toHaveLength(7);
    expect(result.services.map((service) => service.name)).toEqual(['ValidService']);
    expect(result.feignClients.map((client) => client.clientName)).toEqual(['fixture-client']);
    expect(result.javaTypes?.some((type) => type.name === 'Broken')).toBe(false);
    expect(formatRepositoryDiagnostics(result)).toBe([
      'Repository analyzed', '✓ 9 Java files analyzed', '⚠ 1 Java files skipped', '', 'Skipped files:',
      '- src/AAA-Broken.java — Unbalanced Java delimiters',
    ].join('\n'));
    for (const [file, source] of Object.entries(files)) expect(await readFile(join(root, file), 'utf8')).toBe(source);
    expect(await analyzeRepository(root)).toEqual(result);
  });

  it('reports all bad files even when none can be analyzed', async () => {
    const root = await fixture({ 'One.java': 'class One {', 'Two.java': 'class Two {' });
    const result = await analyzeRepository(root);
    expect(result).toMatchObject({ javaFilesAnalyzed: 0, incomplete: true, controllers: [], services: [], feignClients: [] });
    expect(result.skippedJavaFiles?.map((file) => file.filePath)).toEqual(['One.java', 'Two.java']);
    expect(formatRepositoryDiagnostics(result)).toContain('⚠ 2 Java files skipped');
  });

  it('flags an endpoint whose explicit service dependency was skipped, without flagging a known independent method', async () => {
    const root = await fixture({
      'Controller.java': `@RestController class Controller {
        private final GoodService service;
        @GetMapping("/affected") String affected() { return service.read(); }
        @GetMapping("/independent") String independent() { return "fixture"; }
      }`,
      'GoodService.java': '@Service class GoodService { private final BrokenClient client; String read() { return client.read(); } }',
      'BrokenClient.java': '@FeignClient(name="broken") interface BrokenClient { @GetMapping("/remote") String read();',
    });
    const result = await analyzeRepository(root);
    const affected = { method: 'GET', path: '/affected' };
    expect(getEndpointAnalysisStatus(result, affected)).toMatchObject({ incomplete: true, relevantSkippedFiles: [{ filePath: 'BrokenClient.java' }] });
    expect(formatEndpointWarning(result, affected)).toContain('Repository analysis incomplete for endpoint GET /affected');
    expect(formatEndpointWarning(result, affected)).toContain('BrokenClient.java');
    expect(getEndpointAnalysisStatus(result, { method: 'GET', path: '/independent' })).toMatchObject({ incomplete: false, relevantSkippedFiles: [], uncertain: false });
    expect(formatEndpointWarning(result, { method: 'GET', path: '/independent' })).toBeUndefined();
  });

  it('warns conservatively when malformed literals prevent knowing skipped declarations', async () => {
    const root = await fixture({
      'Controller.java': '@RestController class Controller { @GetMapping("/ok") String ok() { return "fixture"; } }',
      'Broken.java': 'class Broken { String x = "unfinished;',
    });
    const result = await analyzeRepository(root);
    expect(getEndpointAnalysisStatus(result, { method: 'GET', path: '/ok' })).toMatchObject({ incomplete: true, uncertain: true });
    expect(formatEndpointWarning(result, { method: 'GET', path: '/ok' })).toContain('Cannot rule out dependencies');
  });

  it('flags skipped request and response DTOs used by the selected endpoint', async () => {
    const root = await fixture({
      'Controller.java': '@RestController class Controller { @PostMapping("/dto") BrokenResponse save(@RequestBody java.util.List<BrokenRequest> input) { return null; } }',
      'BrokenRequest.java': 'class BrokenRequest {',
      'BrokenResponse.java': 'class BrokenResponse {',
    });
    const result = await analyzeRepository(root);
    const status = getEndpointAnalysisStatus(result, { method: 'POST', path: '/dto' });
    expect(status.incomplete).toBe(true);
    expect(status.relevantSkippedFiles.map((file) => file.filePath).sort()).toEqual(['BrokenRequest.java', 'BrokenResponse.java']);
  });

  it('marks repositories without parse failures as complete', async () => {
    const result = await analyzeRepository(await fixture({ 'Good.java': '@Service class Good {}' }));
    expect(result).toMatchObject({ javaFilesAnalyzed: 1, skippedJavaFiles: [], incomplete: false });
    expect(formatRepositoryDiagnostics(result)).toContain('✓ 0 Java files skipped');
  });
});
