import type { Command } from 'commander';
export function registerVirtualizeCommand(program: Command): void {
  program.command('virtualize').description('Generate and publish virtualization files').action(() => {
    console.log('PERF AI\nCommand: virtualize');
  });
}
