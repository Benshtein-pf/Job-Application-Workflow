#!/usr/bin/env node
/*
 * scrape-linkedin-skills.js
 *
 * Pulls the COMPLETE, per-role-attributed skills list from a LinkedIn profile's
 * /details/skills/ page — the data the linkedin-scraper-mcp server truncates to
 * ~10 skills (it has no "full" mode and collapses each role's list as "+N
 * skills"). See ./README.md for the why.
 *
 * It reuses the browser session the MCP already authenticated (stored at
 * ~/.linkedin-mcp/profile) by COPYING that profile to a temp dir and driving it
 * with this repo's bundled Playwright Chromium (same revision as the profile, so
 * the session loads without a re-login). The original profile is never touched.
 *
 * USAGE:
 *   # close the MCP browser first so the session profile is free:
 *   #   (call the MCP close_session tool, or stop the server)
 *   node scripts/linkedin-skills/scrape-linkedin-skills.js <username> [options]
 *
 *   <username>            the profile handle, e.g. "jane-doe" (from
 *                         linkedin.com/in/jane-doe). REQUIRED — never hardcode it;
 *                         derive it from the relevant/authenticated user.
 *   --profile <dir>       session profile dir (default: ~/.linkedin-mcp/profile)
 *   --out <file>          write JSON here (default: stdout)
 *   --headed              run with a visible browser (default: headless)
 *   --no-sandbox          disable the Chromium sandbox. Less secure — use only
 *                         when the sandboxed launch fails (running as root, or
 *                         distros restricting unprivileged user namespaces).
 *
 * OUTPUT (JSON to stdout or --out):
 *   { "username": "...", "count": N,
 *     "skills": [ { "skill": "Docker", "attribution": "3 experiences at Taboola and 2 other companies" }, ... ] }
 *
 * Exit codes: 0 ok · 2 auth wall (session expired/rejected) · 1 other error.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const NAVIGATION_TIMEOUT_MS = 45000;
const PAGE_SETTLE_MS = 3000; // after initial navigation
const TAB_SETTLE_MS = 1500; // after clicking a category tab
const SCROLL_PASSES = 10; // lazy-load passes per tab
const SCROLL_PAUSE_MS = 700;
const MAX_SKILL_LENGTH = 55; // longer lines are prose, not skill names

// Chromium profile lock files that would block reusing the copied session.
const PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];

// An attribution line is the "<role> at <company>" / "N experiences at ..." line
// shown under each skill. Matches English + Hebrew localized UIs.
const isAttribution = (line) =>
  /(experience|experiences|\bat\s|\bב-|ניסיונ|חוויות|endors|המלצ)/i.test(line);

// The temp profile copy holds LIVE LinkedIn session cookies, so it must be
// removed on EVERY exit path — success, error, the auth-wall exit(2), and
// Ctrl+C / kill. The 'exit' hook covers normal and process.exit() paths;
// the signal handlers cover interrupts (which otherwise skip 'exit' hooks).
let tmpProfileDir = null;

function removeTmpProfile() {
  if (!tmpProfileDir) return;
  try {
    fs.rmSync(tmpProfileDir, { recursive: true, force: true });
  } catch (_) {
    // best effort — never mask the real exit reason
  }
  tmpProfileDir = null;
}

process.on('exit', removeTmpProfile);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    removeTmpProfile();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function fail(message, code = 1) {
  console.error('ERROR: ' + message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    profile: path.join(os.homedir(), '.linkedin-mcp', 'profile'),
    out: null,
    headed: false,
    noSandbox: false,
    username: null,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      if (arg === '--profile') args.profile = value;
      else args.out = value;
    } else if (arg === '--headed') {
      args.headed = true;
    } else if (arg === '--no-sandbox') {
      args.noSandbox = true;
    } else {
      positional.push(arg);
    }
  }

  args.username = positional[0] || null;
  return args;
}

// Copy the session profile so we never corrupt the MCP's original, and strip
// lock files that would otherwise block reuse. Native fs.cpSync — no shell
// involved (no quoting/injection concerns) and it works on Windows too.
function copySessionProfile(profileDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'li-skills-'));
  fs.cpSync(profileDir, tmp, { recursive: true });
  for (const name of PROFILE_LOCK_FILES) {
    fs.rmSync(path.join(tmp, name), { force: true });
  }
  return tmp;
}

// Sandboxed by default; --no-sandbox is an explicit opt-in for environments
// where the sandbox cannot start (root, restricted unprivileged user namespaces).
async function launchBrowser(profileDir, { headed, noSandbox }) {
  const launchArgs = ['--disable-blink-features=AutomationControlled'];
  if (noSandbox) launchArgs.push('--no-sandbox');

  try {
    return await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      viewport: { width: 1280, height: 1600 },
      args: launchArgs,
    });
  } catch (e) {
    if (!noSandbox) {
      console.error(
        'Chromium failed to launch. If the error below mentions the sandbox or user\n' +
          'namespaces, re-run with --no-sandbox (less secure; last resort).'
      );
    }
    throw e;
  }
}

async function isAuthWall(page) {
  const bodyText = (await page.evaluate(() => document.body.innerText)) || '';
  const head = bodyText.slice(0, 400);
  return (
    /sign in|join now|authwall/i.test(head) || /\/(login|authwall|checkpoint)/.test(page.url())
  );
}

// Discover the category-filter tabs (All / Tools & Technologies / Industry
// Knowledge / Other Skills) by SHAPE, not English text — the UI may be
// localized. They are the first short-text buttons with no aria-label.
async function discoverTabLabels(page) {
  return page.$$eval('main button', (buttons) =>
    buttons
      .map((b) => ({ text: (b.innerText || '').trim(), ariaLabel: b.getAttribute('aria-label') || '' }))
      .filter((b) => b.text && !b.ariaLabel && b.text.length < 30 && !/\d/.test(b.text))
      .slice(0, 4)
      .map((b) => b.text)
  );
}

async function selectTab(page, label) {
  try {
    const button = page.locator('main button', { hasText: label });
    if (await button.count()) {
      await button.first().click({ timeout: 3000 });
      await page.waitForTimeout(TAB_SETTLE_MS);
    }
  } catch (_) {
    // tab may detach on re-render; scrape whatever view is showing
  }
}

async function scrollToBottom(page) {
  for (let i = 0; i < SCROLL_PASSES; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(SCROLL_PAUSE_MS);
  }
}

// A skill = a non-attribution, non-tab line immediately followed by an
// attribution line. Requiring the attribution naturally drops footer/nav
// noise (those lines aren't followed by "<role> at <company>").
function collectSkills(pageText, tabLabels, skills, seenLower) {
  const lines = pageText
    .split('\n')
    .map((line) => line.replace(/[‎‏⁦⁩⁧]/g, '').trim())
    .filter(Boolean);
  const tabSet = new Set(tabLabels.filter(Boolean));

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (tabSet.has(line) || line.length > MAX_SKILL_LENGTH || isAttribution(line)) continue;
    if (/[.!?:]$/.test(line)) continue; // skill names never end in sentence punctuation
    if (!isAttribution(next)) continue;

    const key = line.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    skills.set(line, next);
  }
}

function writeOutput(args, skills) {
  const result = {
    username: args.username,
    count: skills.size,
    skills: [...skills].map(([skill, attribution]) => ({ skill, attribution })),
  };
  const json = JSON.stringify(result, null, 2);

  if (args.out) {
    fs.writeFileSync(args.out, json);
    console.error(`Wrote ${skills.size} skills -> ${args.out}`);
  } else {
    console.log(json);
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.username) {
    fail('<username> is required (e.g. "jane-doe"). Never hardcode it — pass the relevant user.');
  }
  if (!fs.existsSync(args.profile)) {
    fail(`session profile not found at ${args.profile}. Authenticate the LinkedIn MCP first.`);
  }

  tmpProfileDir = copySessionProfile(args.profile);

  let ctx = null;
  try {
    ctx = await launchBrowser(tmpProfileDir, args);
    const page = ctx.pages()[0] || (await ctx.newPage());

    const url = `https://www.linkedin.com/in/${encodeURIComponent(args.username)}/details/skills/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS);

    if (await isAuthWall(page)) {
      console.error(
        'AUTH_WALL: the stored session was not accepted (expired or checkpoint). Re-login the MCP and retry.'
      );
      process.exitCode = 2;
      return;
    }

    const tabLabels = await discoverTabLabels(page);
    if (tabLabels.length === 0) tabLabels.push(null); // no tabs: scrape the single view

    const skills = new Map();
    const seenLower = new Set();
    for (const label of tabLabels) {
      if (label) await selectTab(page, label);
      await scrollToBottom(page);
      const pageText = await page.evaluate(
        () => (document.querySelector('main') || document.body).innerText
      );
      collectSkills(pageText, tabLabels, skills, seenLower);
    }

    writeOutput(args, skills);
  } catch (e) {
    console.error('ERROR: ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    if (ctx) {
      try {
        await ctx.close();
      } catch (_) {}
    }
    removeTmpProfile();
  }
}

run();
