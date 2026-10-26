#!/usr/bin/env node
import module from 'node:module';

module.enableCompileCache?.();

const { main } = await import('./main.ts');
main();
