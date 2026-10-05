export class PerfAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerfAiError';
  }
}
