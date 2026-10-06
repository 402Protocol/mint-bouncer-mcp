#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
process.argv[2] === '--version'
  ? console.log(pkg.version)
  : (await import('../dist/server.js'));
