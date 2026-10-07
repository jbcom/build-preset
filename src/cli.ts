#!/usr/bin/env node
import { runCli } from "./cliCommands.js";

const result = runCli(process.argv[2]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
