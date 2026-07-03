#!/usr/bin/env node
/**
 * video-studio launcher (macOS).
 *
 * Bootstraps everything needed to turn long videos into promo cuts, then hands
 * off to Claude Code (the skill is the primary interface):
 *   1. checks required system tools (ffmpeg, whisper, ollama, claude, …)
 *      and offers to install the missing ones via Homebrew,
 *   2. installs npm deps + builds the frame-accurate scene analyzer,
 *   3. makes sure Ollama is running in your GUI session (needed for Metal/GPU),
 *   4. installs the `video-studio` Claude skill into ~/.claude/skills,
 *   5. prints a splash + how-to, and launches `claude` in your work dir.
 *
 * Usage:
 *   video-studio [work-dir]        full setup, then launch Claude there
 *   video-studio --check           doctor report only (no install, no launch)
 *   video-studio --no-launch       set up everything but don't launch Claude
 *   video-studio --skills-only      (re)install the Claude skill and exit
 *   video-studio --yes             auto-install missing tools without prompting
 *   video-studio --help
 */
import { execSync, spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { analyzerPrepPlan } from "../tools/launcher-plan.mjs";

const TOOLKIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_SRC = join(TOOLKIT, "skills");
const SKILLS_DEST = join(homedir(), ".claude", "skills");

// ── tiny terminal helpers ────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", orange: "\x1b[38;5;208m",
};
const paint = (s, c) => `${c}${s}${C.reset}`;
const ok = (s) => console.log(`  ${paint("✓", C.green)} ${s}`);
const warn = (s) => console.log(`  ${paint("!", C.yellow)} ${s}`);
const bad = (s) => console.log(`  ${paint("✗", C.red)} ${s}`);
const info = (s) => console.log(`  ${paint("›", C.cyan)} ${s}`);

function which(cmd) {
  try { return execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; }
  catch { return null; }
}
function ver(cmd) {
  try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0]; }
  catch { return ""; }
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", ...opts }).status === 0;
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const FLAGS = {
  check: has("--check") || has("--doctor"),
  noLaunch: has("--no-launch"),
  skillsOnly: has("--skills-only"),
  yes: has("--yes") || has("-y"),
  help: has("--help") || has("-h"),
};
const workdir = resolve(args.find((a) => !a.startsWith("-")) ?? process.cwd());

function splash() {
  const o = C.orange, d = C.dim, r = C.reset;
  console.log(`
${o}   ▗▖ ▗▖▗▄▄▄▖▗▄▄▄ ▗▄▄▄▖ ▗▄▖    ${r}${C.bold}video-studio${r}
${o}   ▐▌ ▐▌  █  ▐▌  █▐▌   ▐▌ ▐▌   ${r}${d}long videos → promo cuts, driven from Claude${r}
${o}    ▝▜▌  █  ▐▙▄▄▀▐▙▄▄▖▝▚▄▞▘   ${r}${d}frame-accurate · ffmpeg · whisper · domotion-svg${r}
`);
}

async function confirm(question) {
  if (FLAGS.yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ${paint("?", C.yellow)} ${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === "" || a === "y" || a === "yes";
}

// ── dependency checks ────────────────────────────────────────────────────
// kind: "system" tools we can brew-install; "manual" needs a documented step.
const TOOLS = [
  { name: "node", check: () => which("node"), version: () => ver("node -v"), required: true, manual: "Install Node 18+ from https://nodejs.org" },
  { name: "npm", check: () => which("npm"), version: () => ver("npm -v"), required: true, manual: "Comes with Node.js" },
  { name: "ffmpeg", check: () => which("ffmpeg"), version: () => ver("ffmpeg -version").replace(/ffmpeg version /, ""), required: true, brew: "ffmpeg" },
  { name: "ffprobe", check: () => which("ffprobe"), version: () => "", required: true, brew: "ffmpeg" },
  { name: "whisper", check: () => which("whisper"), version: () => "", required: false, brew: "openai-whisper", note: "word-level soundbite timing" },
  { name: "ollama", check: () => which("ollama"), version: () => ver("ollama --version"), required: false, brew: "ollama", note: "optional — only for local auto-descriptions; Claude describes frames by default" },
  { name: "claude", check: () => which("claude"), version: () => ver("claude --version"), required: true, manual: "Install Claude Code: https://docs.claude.com/claude-code" },
];

async function checkTools() {
  console.log(C.bold + "Checking tools" + C.reset);
  const brew = which("brew");
  const missing = [];
  for (const t of TOOLS) {
    const path = t.check();
    if (path) { ok(`${t.name.padEnd(9)} ${C.dim}${t.version() || path}${C.reset}`); continue; }
    missing.push(t);
    const how = t.brew ? `brew install ${t.brew}` : t.manual;
    (t.required ? bad : warn)(`${t.name.padEnd(9)} missing${t.note ? ` ${C.dim}(${t.note})${C.reset}` : ""} — ${C.dim}${how}${C.reset}`);
  }
  if (FLAGS.check || missing.length === 0) return missing;

  const brewable = missing.filter((t) => t.brew);
  if (brewable.length && brew) {
    if (await confirm(`Install ${brewable.map((t) => t.brew).join(", ")} via Homebrew now?`)) {
      for (const t of brewable) {
        info(`brew install ${t.brew} …`);
        if (!run("brew", ["install", t.brew])) bad(`failed to install ${t.brew}`);
      }
    }
  } else if (brewable.length && !brew) {
    warn("Homebrew not found — install it (https://brew.sh) or install the tools above manually.");
  }
  return missing.filter((t) => !t.check());
}

// ── node deps + analyzer build ───────────────────────────────────────────
// The npm package ships a prebuilt dist/ (package.json `files`), so an installed user has a
// working analyzer WITHOUT the TS toolchain (typescript + @types/* are devDependencies npm
// omits for consumers). Only recompile when there's no prebuilt dist — i.e. a source
// checkout. Rebuilding unconditionally is what made `tsc` fail with a wall of type errors
// for globally-installed users (VS-77). The decision is the pure `analyzerPrepPlan`.
function ensureNodeDeps() {
  console.log(C.bold + "Preparing analyzer" + C.reset);
  const distEntry = join(TOOLKIT, "dist", "analyzer.js");
  const plan = analyzerPrepPlan({
    hasDist: existsSync(distEntry),
    hasRuntimeDeps: existsSync(join(TOOLKIT, "node_modules", "domotion-svg")),
    hasToolchain: existsSync(join(TOOLKIT, "node_modules", "typescript")),
  });
  if (plan.npmInstall) { info("npm install …"); run("npm", ["install"], { cwd: TOOLKIT }); }
  else ok("npm deps present");
  if (plan.build) {
    info("npm run build …");
    if (run("npm", ["run", "build"], { cwd: TOOLKIT }) && existsSync(distEntry)) ok("analyzer built (dist/analyzer.js)");
    else bad("analyzer build failed — see errors above");
  } else if (existsSync(distEntry)) {
    ok("analyzer ready (dist/analyzer.js)");
  } else {
    warn("no dist/analyzer.js and no build performed — reinstall video-studio");
  }
}

// ── install the Claude skill(s) ──────────────────────────────────────────
function installSkills() {
  console.log(C.bold + "Installing Claude skill" + C.reset);
  if (!existsSync(SKILLS_SRC)) { bad(`no skills/ directory in ${TOOLKIT}`); return; }
  mkdirSync(SKILLS_DEST, { recursive: true });
  for (const name of readdirSync(SKILLS_SRC)) {
    const src = join(SKILLS_SRC, name);
    if (!statSync(src).isDirectory()) continue;
    const dest = join(SKILLS_DEST, name);
    cpSync(src, dest, { recursive: true });
    // inject the absolute toolkit path so the skill's commands resolve anywhere
    const skillMd = join(dest, "SKILL.md");
    if (existsSync(skillMd)) {
      writeFileSync(skillMd, readFileSync(skillMd, "utf8").replaceAll("{{TOOLKIT_DIR}}", TOOLKIT));
    }
    ok(`/${name} → ${C.dim}${dest}${C.reset}`);
  }
}

async function launchClaude() {
  console.log(`
${C.bold}Ready.${C.reset} In Claude, type ${paint("/video-studio", C.orange)} or just say what you want, e.g.:
  ${C.dim}"make a 15-second teaser from ~/Desktop/talk.mov"${C.reset}

  ${C.dim}work dir:${C.reset} ${workdir}
`);
  if (FLAGS.noLaunch) { info("--no-launch: not starting Claude. Run `claude` in your work dir when ready."); return; }
  if (!which("claude")) { warn("claude not found — install it, then run `claude` in your work dir."); return; }
  // Claude's UI clears the terminal the instant it starts, covering the how-to
  // above — so pause and let the user read it first. Skip when there's no TTY to
  // read from, or when --yes asked for a no-prompt run.
  if (process.stdin.isTTY && !FLAGS.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(`  ${paint("›", C.cyan)} Press ${C.bold}Enter${C.reset} to launch Claude…`);
    rl.close();
  }
  const child = spawn("claude", [], { cwd: workdir, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function help() {
  splash();
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(3, 24).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
}

async function main() {
  if (FLAGS.help) return help();
  splash();
  if (process.platform !== "darwin") { bad("video-studio currently supports macOS only."); process.exit(1); }

  if (FLAGS.skillsOnly) { installSkills(); return; }

  const missing = await checkTools();
  if (FLAGS.check) {
    console.log(missing.some((t) => t.required) ? `\n${paint("Some required tools are missing.", C.red)} Re-run without --check to install.` : `\n${paint("All set.", C.green)}`);
    return;
  }
  ensureNodeDeps();
  installSkills();
  await launchClaude();
}

main().catch((e) => { bad(String(e?.stack || e)); process.exit(1); });
