#!/usr/bin/env node
import { Command } from 'commander';
import { registerGenerateCommand } from './commands/generate.command.js';
import { registerPublishCommand } from './commands/publish.command.js';
import { registerVirtualizeCommand } from './commands/virtualize.command.js';

export function createProgram(): Command {
  const program = new Command();
  program.name('perf-ai').description('Generate and publish performance-test virtualizations').version('0.1.0');
  registerGenerateCommand(program);
  registerPublishCommand(program);
  registerVirtualizeCommand(program);
  return program;
}

if (process.env.NODE_ENV !== 'test') {
  void createProgram().parseAsync();
}
