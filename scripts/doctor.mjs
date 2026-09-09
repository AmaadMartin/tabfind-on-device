/**
 * Preflight check: will Chrome's built-in model actually run on this machine?
 *
 * Checks the documented requirements, then does the only check that really
 * counts — launches Chrome and asks `LanguageModel.availability()` directly.
 *
 *   node scripts/doctor.mjs
 *
 * Requirements per https://developer.chrome.com/docs/ai/get-started
 *   OS       Windows 10/11, macOS 13+, Linux, ChromeOS (Chromebook Plus)
 *   Storage  22 GB free on the volume holding the Chrome profile
 *   GPU      > 4 GB VRAM   -- OR --   CPU: 16 GB RAM and 4+ cores
 *   Network  unmetered, for the initial download only
 */

import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const OK = '  ok  ';
const WARN = ' warn ';
const BAD = ' fail ';
let fatal = 0;

function line(tag, label, detail = '') {
  console.log(`[${tag}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (tag === BAD) fatal++;
}

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
       '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
         '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => fs.existsSync(p));
}

console.log('\nTabFind preflight\n');

/* ------------------------------- OS -------------------------------- */

if (process.platform === 'darwin') {
  const ver = sh('sw_vers -productVersion');
  const major = Number(ver.split('.')[0] || 0);
  line(major >= 13 ? OK : BAD, `macOS ${ver || '?'}`,
    major >= 13 ? 'meets macOS 13+' : 'needs macOS 13 (Ventura) or newer');
  const arch = os.arch();
  line(OK, `architecture ${arch}`,
    arch === 'arm64' ? 'Apple Silicon' : 'Intel — check VRAM, the CPU path needs 16 GB RAM');
} else if (process.platform === 'linux') {
  line(OK, 'Linux', 'supported');
} else if (process.platform === 'win32') {
  line(OK, 'Windows', 'supported (10 or 11)');
} else {
  line(BAD, `platform ${process.platform}`, 'not supported');
}

/* ------------------------------ hardware --------------------------- */

const ramGb = Math.round(os.totalmem() / 1024 ** 3);
const cores = os.cpus().length;
const cpuPathOk = ramGb >= 16 && cores >= 4;
line(cpuPathOk ? OK : WARN, `${ramGb} GB RAM, ${cores} cores`,
  cpuPathOk
    ? 'satisfies the CPU path (16 GB + 4 cores)'
    : 'CPU path needs 16 GB RAM and 4 cores; you will need >4 GB VRAM instead');

/* ------------------------------ storage ---------------------------- */
// The requirement is 22 GB free on the volume holding the Chrome profile.

let freeGb = 0;
try {
  const target = process.platform === 'darwin' ? `${process.env.HOME}/Library` : os.homedir();
  const out = sh(`df -k "${target}"`).split('\n').pop() ?? '';
  const avail = Number(out.split(/\s+/)[3]);
  freeGb = Math.round(avail / 1024 / 1024);
} catch { /* reported below */ }

if (freeGb) {
  line(freeGb >= 22 ? OK : BAD, `${freeGb} GB free on the profile volume`,
    freeGb >= 22 ? 'meets the 22 GB requirement'
      : 'needs 22 GB free — Chrome also evicts the model if free space drops below 10 GB');
} else {
  line(WARN, 'free disk space', 'could not determine; you need 22 GB');
}

/* ------------------------------- Chrome ---------------------------- */

const chrome = findChrome();
if (!chrome) {
  line(BAD, 'Google Chrome', 'not found; set CHROME_PATH');
} else {
  const v = sh(`"${chrome}" --version`);
  const major = Number((v.match(/(\d+)\./) ?? [])[1] ?? 0);
  line(major >= 138 ? OK : BAD, v || 'Chrome',
    major >= 138 ? 'Prompt API available to extensions (138+) '
      + (major >= 148 ? 'and to web pages (148+)' : '— web pages need 148+')
      : 'needs Chrome 138 or newer');
}

/* ------------------- the check that actually matters --------------- */

if (chrome) {
  console.log('\nAsking Chrome directly...\n');
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        // Best effort at the equivalents of the chrome://flags entries, since a
        // temporary profile has none of the user's flags set.
        '--enable-features=AIPromptAPI,OptimizationGuideOnDeviceModel',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
    });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const res = await page.evaluate(async () => {
      if (typeof LanguageModel === 'undefined') return { api: false };
      try {
        return {
          api: true,
          availability: await LanguageModel.availability({
            expectedInputs: [{ type: 'text', languages: ['en'] }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
          }),
        };
      } catch (e) {
        return { api: true, error: String(e) };
      }
    });

    if (!res.api) {
      line(BAD, 'window.LanguageModel', 'not exposed — Chrome too old, or flags off');
    } else {
      const a = res.availability;
      const msg = {
        available: 'model is downloaded and ready',
        downloadable: 'supported — the first search will download it (a few GB)',
        downloading: 'download already in progress',
        unavailable: 'Chrome says this device cannot run it',
      }[a] ?? res.error ?? 'unknown';
      line(a === 'unavailable' ? BAD : OK, `LanguageModel.availability() = "${a}"`, msg);
    }
  } catch (e) {
    line(WARN, 'could not launch Chrome', String(e).split('\n')[0]);
  } finally {
    await browser?.close();
  }
}

/* ------------------------------- flags ----------------------------- */

console.log(`
IMPORTANT: the check above launched Chrome with a fresh temporary profile, so it
cannot see flags you enabled in your everyday Chrome. A "not exposed" result here
does not necessarily mean your normal browser lacks the API.

The authoritative check is in your own browser. Open DevTools on any page and run:

  await LanguageModel.availability()

If that says "unavailable" or LanguageModel is undefined, enable these and
restart Chrome — they are required to use the APIs on localhost:

  chrome://flags/#optimization-guide-on-device-model   -> Enabled
  chrome://flags/#prompt-api-for-gemini-nano           -> Enabled

Then watch the download at:  chrome://on-device-internals
`);

console.log(fatal
  ? `${fatal} blocking problem(s) in the automated checks. TabFind will still run,\n`
    + 'but it will fall back to the scripted stand-in and label itself SIMULATED.\n'
  : 'All clear — you should get the real on-device model.\n');
