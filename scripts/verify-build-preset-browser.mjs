#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error("browser proof must run through pnpm so npm_execpath identifies the pinned CLI");
}
const browserCwd = process.env.BUILD_PRESET_BROWSER_CWD ?? process.cwd();
const browserConfig =
  process.env.BUILD_PRESET_BROWSER_CONFIG ?? "vitest.build-preset-browser.config.ts";
const javascriptCli = /\.[cm]?js$/i.test(pnpmCli);

const child = spawn(
  javascriptCli ? process.execPath : pnpmCli,
  javascriptCli
    ? [pnpmCli, "exec", "vitest", "run", "--config", browserConfig]
    : ["exec", "vitest", "run", "--config", browserConfig],
  {
    cwd: browserCwd,
    env: { ...process.env, BUILD_PRESET_BROWSER_PROOF: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let observedBrowser = null;
let contractError = null;

function processTable() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    }));
}

function inspectBrowserProcess() {
  if (observedBrowser || contractError || child.exitCode !== null) return;
  try {
    const processes = processTable();
    const descendants = new Set([child.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of processes) {
        if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
          descendants.add(process.pid);
          changed = true;
        }
      }
    }

    const browser = processes.find(
      (process) =>
        descendants.has(process.pid) &&
        process.command.includes("--remote-debugging-pipe") &&
        process.command.includes("--user-data-dir=") &&
        !process.command.includes("--type="),
    );
    if (!browser) return;

    if (!/(?:^|\s)--mute-audio(?:\s|$)/.test(browser.command)) {
      throw new Error(`Chromium process omitted --mute-audio: ${browser.command}`);
    }
    if (/(?:^|\s)--headless(?:=\S+)?(?:\s|$)/.test(browser.command)) {
      throw new Error(`Chromium process unexpectedly used headless mode: ${browser.command}`);
    }
    observedBrowser = browser;
  } catch (error) {
    contractError = error;
    child.kill("SIGTERM");
  }
}

const inspectionTimer = setInterval(inspectBrowserProcess, 25);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Vitest browser proof terminated by ${signal}`));
    else resolve(code ?? 1);
  });
});
clearInterval(inspectionTimer);
inspectBrowserProcess();

if (contractError) throw contractError;
if (exitCode !== 0) throw new Error(`Vitest browser proof exited ${exitCode}`);
if (!observedBrowser) {
  throw new Error("No owned headed Chromium process was observed during the browser proof");
}

process.stdout.write(
  `Verified owned Chromium pid ${observedBrowser.pid}: --mute-audio present, --headless absent\n`,
);
