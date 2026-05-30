#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_NAME = 'llm-council';

function main() {
  const command = process.argv[2] || 'install';

  if (command === '--help' || command === '-h') {
    console.log(`
  ghcp-llm-council — Multi-model deliberation skill for GitHub Copilot CLI

  Usage:
    npx ghcp-llm-council install    Install the skill (default)
    npx ghcp-llm-council uninstall  Remove the skill
    npx ghcp-llm-council --help     Show this help
`);
    process.exit(0);
  }

  if (command === 'uninstall') {
    uninstall();
  } else {
    install();
  }
}

function getSkillDest() {
  const home = os.homedir();
  return path.join(home, '.copilot', 'skills', SKILL_NAME);
}

function install() {
  const source = path.resolve(__dirname, '..', 'skills', SKILL_NAME);
  const destRoot = path.join(os.homedir(), '.copilot', 'skills');
  const dest = path.join(destRoot, SKILL_NAME);

  if (!fs.existsSync(source)) {
    console.error(`\x1b[31mError: Source skill not found at: ${source}\x1b[0m`);
    process.exit(1);
  }

  fs.mkdirSync(destRoot, { recursive: true });

  if (fs.existsSync(dest)) {
    console.log('\x1b[33mReplacing existing installation...\x1b[0m');
    fs.rmSync(dest, { recursive: true, force: true });
  }

  console.log(`\x1b[36mInstalling '${SKILL_NAME}' skill...\x1b[0m`);
  copyDirSync(source, dest);

  console.log(`\x1b[32m✓ Installed to: ${dest}\x1b[0m`);
  console.log('\x1b[36mRestart your Copilot CLI session, then say: ask the council <your question>\x1b[0m');
}

function uninstall() {
  const dest = getSkillDest();

  if (!fs.existsSync(dest)) {
    console.log('\x1b[33mSkill not installed — nothing to remove.\x1b[0m');
    process.exit(0);
  }

  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`\x1b[32m✓ Removed skill from: ${dest}\x1b[0m`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

main();
