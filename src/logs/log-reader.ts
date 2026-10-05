import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';

/** Read one line at a time; close the stream even when the consumer stops early. */
export async function* readLogLines(filePath: string): AsyncGenerator<string> {
  if (!['.txt', '.log'].includes(extname(filePath).toLowerCase())) {
    throw new Error('Log file must have a .txt or .log extension');
  }
  const handle = await open(filePath, 'r');
  let stream: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Log path must be a file');
    stream = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) yield line;
  } finally {
    lines?.close();
    stream?.destroy();
    await handle.close();
  }
}
