#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DEFAULT_SOURCE_ROOT = path.join(
  HOME,
  'Library',
  'Containers',
  'com.tencent.xinWeChat',
  'Data',
  'Library',
  'Application Support',
  'com.tencent.xinWeChat',
);
const DEFAULT_TARGET_ROOT = path.join(
  HOME,
  'Library',
  'Containers',
  'com.tencent.xinWeChat',
  'Data',
  'Documents',
  'xwechat_files',
  'compat',
  'db_storage',
);

function parseArgs(argv) {
  const options = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    targetRoot: DEFAULT_TARGET_ROOT,
    printOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--print-only') {
      options.printOnly = true;
      continue;
    }
    if (arg === '--source-root' && argv[i + 1]) {
      options.sourceRoot = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--target-root' && argv[i + 1]) {
      options.targetRoot = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`用法:
  node scripts/setup-compat-dir.js [--source-root PATH] [--target-root PATH] [--print-only]

作用:
  自动查找 macOS 微信真实数据库目录，并在 compat/db_storage 下创建 wechat-cli 可识别的软链接结构。

默认 source-root:
  ${DEFAULT_SOURCE_ROOT}

默认 target-root:
  ${DEFAULT_TARGET_ROOT}
`);
}

function isDir(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listDirs(root) {
  if (!isDir(root)) return [];
  return fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter(isDir);
}

function scoreCandidate(dir) {
  const contact = path.join(dir, 'Contact', 'wccontact_new2.db');
  const session = path.join(dir, 'Session', 'session_new.db');
  const messageDir = path.join(dir, 'Message');
  if (!isFile(contact) || !isFile(session) || !isDir(messageDir)) return null;
  const msgFiles = fs.readdirSync(messageDir).filter((name) => /^msg_\d+\.db$/.test(name));
  if (!msgFiles.length) return null;
  const stat = fs.statSync(dir);
  return {
    dir,
    contact,
    session,
    msgFiles: msgFiles.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])),
    mtimeMs: stat.mtimeMs,
  };
}

function findDataDir(sourceRoot) {
  const candidates = [];
  for (const versionDir of listDirs(sourceRoot)) {
    for (const accountDir of listDirs(versionDir)) {
      const candidate = scoreCandidate(accountDir);
      if (candidate) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetTarget(filePath) {
  try {
    fs.rmSync(filePath, { force: true, recursive: true });
  } catch {}
}

function linkPath(source, target) {
  ensureDir(path.dirname(target));
  resetTarget(target);
  fs.symlinkSync(source, target);
}

function maybeLinkSidecars(source, target) {
  for (const suffix of ['', '-wal', '-shm']) {
    const sourceFile = `${source}${suffix}`;
    const targetFile = `${target}${suffix}`;
    if (isFile(sourceFile)) {
      linkPath(sourceFile, targetFile);
    } else {
      resetTarget(targetFile);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const found = findDataDir(options.sourceRoot);
  if (!found) {
    throw new Error(
      [
        '没有找到可用的微信数据库目录。',
        `已检查: ${options.sourceRoot}`,
        '要求目录内同时存在 Contact/wccontact_new2.db、Session/session_new.db、Message/msg_*.db',
      ].join('\n'),
    );
  }

  if (options.printOnly) {
    console.log(options.targetRoot);
    return;
  }

  ensureDir(path.join(options.targetRoot, 'contact'));
  ensureDir(path.join(options.targetRoot, 'session'));
  ensureDir(path.join(options.targetRoot, 'message'));

  maybeLinkSidecars(found.contact, path.join(options.targetRoot, 'contact', 'contact.db'));
  maybeLinkSidecars(found.session, path.join(options.targetRoot, 'session', 'session.db'));

  const messageDir = path.join(found.dir, 'Message');
  for (const name of fs.readdirSync(path.join(options.targetRoot, 'message'))) {
    if (/^message_\d+\.db(?:-wal|-shm)?$/.test(name)) {
      resetTarget(path.join(options.targetRoot, 'message', name));
    }
  }

  for (const fileName of found.msgFiles) {
    const index = fileName.match(/^msg_(\d+)\.db$/)[1];
    maybeLinkSidecars(
      path.join(messageDir, fileName),
      path.join(options.targetRoot, 'message', `message_${index}.db`),
    );
  }

  console.log('Compat db_storage 已准备好');
  console.log(`来源目录: ${found.dir}`);
  console.log(`目标目录: ${options.targetRoot}`);
  console.log('');
  console.log('下一步执行:');
  console.log(`sudo wechat-cli init --db-dir "${options.targetRoot}" --force`);
}

try {
  main();
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exit(1);
}
