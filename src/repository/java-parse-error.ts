/** File context travels with a parsing failure, without embedding source contents. */
export class JavaParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
    public readonly declaredTypes: string[] = [],
  ) {
    super(reason);
    this.name = 'JavaParseError';
  }
}
