#!/usr/bin/env node
'use strict';

process.exitCode = require('../dist/swift-cli.js').runSwiftTokensCli(process.argv.slice(2));
