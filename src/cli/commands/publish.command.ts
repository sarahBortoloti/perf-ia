import type { Command } from 'commander';
export function registerPublishCommand(program: Command): void {
  program.command('publish').description('Publish virtualization files').action(() => {
    console.log('PERF AI\nCommand: publish');
  });
}
