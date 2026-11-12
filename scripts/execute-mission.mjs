#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PLAN_PATH = path.resolve(process.cwd(), 'sakura-plan.json');
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || 'manual';
const SKIP_PUSH = process.env.SKIP_PUSH === '1';
const SAFE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PUSH_BATCH_SIZE = 400;

const MESSAGES = {
  lycoreco: [
    '☕ Brewed daily house blend at Café LycoReco',
    '🍨 Prepared Takina special chocolate parfait',
    '🌸 Tended crimson spider lily planter outside LycoReco',
    '🎯 Logged peaceful neighborhood patrol report',
    '🥐 Delivered fresh morning café order on time',
  ],
  chisato: [
    '🎯 Non-lethal rubber bullet bullseye!',
    '☕ Chisato signature latte art practice',
    '❤️ Making my own choices — zero regrets!',
    '✨ Dodged incoming bug at point-blank range',
  ],
  takina: [
    '📊 Optimized Café LycoReco inventory ledger',
    '🍨 Precision-crafted hot chocolate parfait',
    '🎯 First Lycoris tactical sweep complete',
    '🐟 Sakana~ quick break between missions',
  ],
  minimal: [
    'chore(sakura): update contribution canvas log',
    'docs(lycoreco): record daily shift entry',
  ],
};

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function getCurrentBranch() {
  try {
    let branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || '';
    if (!branch || branch === 'HEAD') {
      branch = process.env.GITHUB_REF_NAME || 'main';
    }
    if (!branch || branch.startsWith('-') || branch.includes('..') || /[\s\x00-\x1f\x7f]/.test(branch)) {
      return 'main';
    }
    return branch;
  } catch {
    return 'main';
  }
}

function pickMessage(style, idx) {
  const pool = MESSAGES[style] || MESSAGES.lycoreco;
  return pool[idx % pool.length];
}

function runFastImportCommits(branch, authorName, authorEmail, entries, messageStyle) {
  const hasHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }).status === 0;
  const oldHead = hasHead ? git(['rev-parse', 'HEAD']) : null;
  const refName = `refs/heads/${branch}`;

  let markId = 1;
  let globalIdx = 0;
  const chunks = [];

  for (const entry of entries) {
    if (!entry || typeof entry.date !== 'string' || !SAFE_DATE_RE.test(entry.date)) continue;
    const count = Math.min(500, Math.max(0, Math.round(Number(entry.count) || 0)));
    if (count <= 0) continue;

    // Noon UTC avoids timezone shifts across UTC-11..UTC+11
    const baseUnix = Math.floor(new Date(`${entry.date}T12:00:00Z`).getTime() / 1000);
    if (!Number.isFinite(baseUnix)) continue;

    for (let i = 0; i < count; i++) {
      const ts = baseUnix + i;
      const msg = `${pickMessage(messageStyle, globalIdx)} [${entry.date} #${i + 1}] [skip ci]`.replace(/[\r\n\0]/g, ' ');
      const msgBytes = Buffer.from(msg, 'utf8');

      const header = [
        `commit ${refName}`,
        `mark :${markId}`,
        `author ${authorName} <${authorEmail}> ${ts} +0000`,
        `committer ${authorName} <${authorEmail}> ${ts} +0000`,
        `data ${msgBytes.length}`,
      ].join('\n') + '\n';

      chunks.push(Buffer.from(header, 'utf8'), msgBytes, Buffer.from('\n', 'utf8'));
      if (markId === 1) {
        if (hasHead) {
          chunks.push(Buffer.from(`from ${refName}^0\n`, 'utf8'));
        }
      } else {
        chunks.push(Buffer.from(`from :${markId - 1}\n`, 'utf8'));
      }
      chunks.push(Buffer.from('\n', 'utf8'));

      markId += 1;
      globalIdx += 1;
    }
  }

  if (globalIdx === 0) {
    console.log('No commits requested in plan.');
    return { total: 0, oldHead };
  }

  const input = Buffer.concat(chunks);
  const res = spawnSync('git', ['fast-import', '--quiet'], {
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (res.status !== 0) {
    throw new Error(`git fast-import failed with exit code ${res.status}`);
  }

  git(['reset', '--hard', refName]);
  console.log(`Generated ${globalIdx} commits on ${branch} via git fast-import.`);
  return { total: globalIdx, oldHead };
}

function pushBranchInBatches(branch, oldHead) {
  const refName = `refs/heads/${branch}`;
  const range = oldHead ? `${oldHead}..${refName}` : refName;
  const rawList = git(['rev-list', '--reverse', range]);
  const shas = rawList ? rawList.split(/\r?\n/).filter(Boolean) : [];

  if (shas.length <= PUSH_BATCH_SIZE) {
    git(['push', 'origin', branch]);
    console.log(`Pushed ${shas.length} commits to origin/${branch}.`);
    return;
  }

  const totalBatches = Math.ceil(shas.length / PUSH_BATCH_SIZE);
  let batchNum = 0;

  for (let i = PUSH_BATCH_SIZE - 1; i < shas.length; i += PUSH_BATCH_SIZE) {
    batchNum += 1;
    git(['push', 'origin', `${shas[i]}:${refName}`]);
    console.log(`Pushed batch ${batchNum}/${totalBatches} (${i + 1}/${shas.length} commits)...`);
  }

  if (shas.length % PUSH_BATCH_SIZE !== 0) {
    batchNum += 1;
    git(['push', 'origin', branch]);
    console.log(`Pushed batch ${batchNum}/${totalBatches} (${shas.length}/${shas.length} commits).`);
  }
}

function main() {
  if (!fs.existsSync(PLAN_PATH)) {
    console.log('sakura-plan.json not found. Exiting cleanly.');
    return;
  }

  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  const authorName = String(plan.authorName || 'Lycoris Agent').replace(/[<>\r\n\0]/g, '').trim() || 'Lycoris Agent';
  const authorEmail = String(plan.authorEmail || '').replace(/[<>\r\n\0]/g, '').trim();

  if (!authorEmail || !authorEmail.includes('@')) {
    throw new Error('authorEmail is required in sakura-plan.json so GitHub counts contributions.');
  }

  git(['config', 'user.name', authorName]);
  git(['config', 'user.email', authorEmail]);

  const branch = getCurrentBranch();
  const style = plan.messageStyle || 'lycoreco';

  if (EVENT_NAME === 'schedule') {
    if (!plan.dailyShift || !plan.dailyShift.enabled) {
      console.log('Daily Café Shift is disabled. Skipping scheduled run.');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const count = Math.max(1, Math.min(50, Number(plan.dailyShift.commitsPerDay) || 1));
    const { total, oldHead } = runFastImportCommits(branch, authorName, authorEmail, [{ date: today, count }], style);
    if (total > 0 && !SKIP_PUSH) {
      pushBranchInBatches(branch, oldHead);
    }
    return;
  }

  if (plan.mode === 'reset') {
    plan.mode = 'idle';
    plan.commits = [];
    fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    git(['add', '-A']);
    const tree = git(['write-tree']);
    const rootCommit = git(['commit-tree', tree, '-m', '🌸 Café LycoReco: Canvas reset [skip ci]']);
    git(['update-ref', `refs/heads/${branch}`, rootCommit]);
    git(['reset', '--hard', rootCommit]);
    if (!SKIP_PUSH) {
      git(['push', '--force', 'origin', branch]);
    }
    console.log('Repository canvas history reset cleanly.');
    return;
  }

  if (plan.mode === 'paint') {
    const entries = Array.isArray(plan.commits) ? plan.commits : [];
    const { total, oldHead } = runFastImportCommits(branch, authorName, authorEmail, entries, style);
    if (total > 0 && !SKIP_PUSH) {
      pushBranchInBatches(branch, oldHead);
    }
    return;
  }

  console.log(`Plan mode is "${plan.mode}". Nothing to execute.`);
}

main();
