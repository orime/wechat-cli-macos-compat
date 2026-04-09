#!/usr/bin/env node

'use strict';

process.env.NODE_NO_WARNINGS = process.env.NODE_NO_WARNINGS || '1';
process.emitWarning = () => {};

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PAGE_SZ = 1024;
const RESERVE_SZ = 48;
const SQLITE_HDR = Buffer.from('SQLite format 3\0', 'binary');
const CACHE_DIR = path.join(os.tmpdir(), 'wechat_cli_cache_js');
const MTIME_FILE = path.join(CACHE_DIR, '_mtimes.json');
const STATE_FILE = path.join(os.homedir(), '.wechat-cli', '.patched-state.json');

const TYPE_LABELS = {
  text: '文本',
  image: '图片',
  voice: '语音',
  video: '视频',
  sticker: '表情',
  location: '位置',
  link: '链接',
  file: '文件',
  call: '通话',
  system: '系统',
};

function resolveOriginalBinary() {
  if (process.env.WECHAT_CLI_ORIGINAL_BINARY) {
    return process.env.WECHAT_CLI_ORIGINAL_BINARY;
  }
  const platformKey = `${process.platform}-${process.arch}`;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const map = {
    'darwin-arm64': '@canghe_ai/wechat-cli-darwin-arm64',
    'darwin-x64': '@canghe_ai/wechat-cli-darwin-x64',
  };
  const pkg = map[platformKey];
  if (!pkg) return null;
  try {
    return require.resolve(`${pkg}/bin/wechat-cli${ext}`);
  } catch {
    return null;
  }
}

const ORIGINAL_BINARY = resolveOriginalBinary();

function md5hex(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function forwardToOriginal(args) {
  if (!ORIGINAL_BINARY) {
    console.error('错误: 找不到原始 wechat-cli 二进制');
    process.exit(1);
  }
  try {
    execFileSync(ORIGINAL_BINARY, args, {
      stdio: 'inherit',
      env: { ...process.env, WECHAT_CLI_USE_PATCHED: '0' },
    });
  } catch (error) {
    if (error && error.status != null) process.exit(error.status);
    throw error;
  }
}

function parseGlobalArgs(argv) {
  const result = {
    configPath: null,
    help: false,
    version: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' && i + 1 < argv.length) {
      result.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help') {
      result.help = true;
      result.rest.push(arg);
      continue;
    }
    if (arg === '--version') {
      result.version = true;
      result.rest.push(arg);
      continue;
    }
    result.rest.push(arg);
  }
  return result;
}

function parseCommandArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next == null || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      if (Array.isArray(options[key])) {
        options[key].push(next);
      } else {
        options[key] = [options[key], next];
      }
    } else {
      options[key] = next;
    }
    i += 1;
  }
  return { positional, options };
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toInt(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUnix(ts) {
  const d = new Date(Number(ts) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseTimeInput(value, isEnd = false) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const suffix = isEnd ? '23:59:59' : '00:00:00';
    return Math.floor(new Date(`${text}T${suffix}`).getTime() / 1000);
  }
  const normalized = text.replace(' ', 'T');
  const ms = new Date(normalized).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function detectAppMsgKind(content) {
  if (!content || !content.includes('<msg')) return null;
  if (/<appattach>/i.test(content) || /<attachid>/i.test(content) || /<totallen>/i.test(content)) {
    return 'file';
  }
  return 'link';
}

function extractXmlTitle(content) {
  if (!content) return '';
  const match = content.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function extractXmlSubject(content) {
  if (!content) return '';
  const match = content.match(/<subject>([\s\S]*?)<\/subject>/i);
  if (!match) return '';
  return match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function extractXmlDigest(content) {
  if (!content) return '';
  const match = content.match(/<digest>([\s\S]*?)<\/digest>/i);
  if (!match) return '';
  return match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function toUtf8Text(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').replace(/\u0000/g, '').replace(/\r/g, '');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8').replace(/\u0000/g, '').replace(/\r/g, '');
  }
  return String(value).replace(/\u0000/g, '').replace(/\r/g, '');
}

function decodeXmlEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&');
}

function extractXmlTag(content, tagName) {
  if (!content || !tagName) return '';
  const match = decodeXmlEntities(String(content)).match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  if (!match) return '';
  return normalizeText(match[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
}

function extractAllXmlTagValues(content, tagName) {
  if (!content || !tagName) return [];
  const values = [];
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'ig');
  const decoded = decodeXmlEntities(String(content));
  let match;
  while ((match = regex.exec(decoded))) {
    const value = normalizeText(match[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
    if (value) values.push(value);
  }
  return values;
}

function extractAtUsernames(msgSource) {
  const raw = extractXmlTag(msgSource, 'atuserlist');
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function extractMentionDisplayNames(content) {
  if (!content) return [];
  const names = [];
  const regex = /@([^\n\r@]+?)(?=[\u2005\s]|$)/g;
  let match;
  while ((match = regex.exec(content))) {
    const value = normalizeText(match[1]);
    if (value && value !== '所有人') names.push(value);
  }
  return names;
}

function extractGroupRawSender(content) {
  const text = normalizeText(content);
  const index = text.indexOf(':\n');
  if (index <= 0 || index >= 80) {
    return { rawSender: '', body: text };
  }
  const rawSender = text.slice(0, index);
  if (!/^[a-zA-Z0-9_@.-]+$/.test(rawSender)) {
    return { rawSender: '', body: text };
  }
  return {
    rawSender,
    body: text.slice(index + 2),
  };
}

function extractRoomDataMembers(sessionInfo) {
  const text = toUtf8Text(sessionInfo);
  const match = text.match(/<RoomData[\s\S]*?<\/RoomData>/i);
  const result = {
    members: [],
    displayMap: new Map(),
  };
  if (!match) return result;
  const memberRegex = /<Member\b[^>]*\bUserName="([^"]+)"[^>]*>([\s\S]*?)<\/Member>/ig;
  let memberMatch;
  while ((memberMatch = memberRegex.exec(match[0]))) {
    const username = normalizeText(decodeXmlEntities(memberMatch[1]));
    if (!username) continue;
    result.members.push(username);
    const display = extractXmlTag(memberMatch[2], 'DisplayName');
    if (display) {
      result.displayMap.set(username, display);
    }
  }
  return result;
}

function extractReplyDisplayEntries(content, chatUsername) {
  const entries = [];
  const decoded = decodeXmlEntities(toUtf8Text(content));
  const blocks = [];
  const regex = /<refermsg>([\s\S]*?)<\/refermsg>/ig;
  let match;
  while ((match = regex.exec(decoded))) {
    blocks.push(match[1]);
  }
  if (!blocks.length) blocks.push(decoded);
  for (const block of blocks) {
    if (extractXmlTag(block, 'fromusr') !== chatUsername) continue;
    const username = extractXmlTag(block, 'chatusr');
    const display = extractXmlTag(block, 'displayname');
    if (username && display) {
      entries.push({ username, display });
    }
  }
  return entries;
}

function extractRecordSourceItems(content, chatUsername) {
  const items = [];
  const decoded = decodeXmlEntities(toUtf8Text(content));
  const regex = /<dataitem\b[^>]*>([\s\S]*?)<\/dataitem>/ig;
  let match;
  while ((match = regex.exec(decoded))) {
    const block = match[1];
    if (extractXmlTag(block, 'srcChatname') !== chatUsername) continue;
    const sourceName = extractXmlTag(block, 'sourcename');
    const srcMsgLocalId = toInt(extractXmlTag(block, 'srcMsgLocalid'), null);
    if (sourceName && Number.isFinite(srcMsgLocalId)) {
      items.push({ sourceName, srcMsgLocalId });
    }
  }
  return items;
}

function extractSysmsgMemberEntries(content) {
  const entries = [];
  const decoded = decodeXmlEntities(toUtf8Text(content));
  const memberRegex = /<member>([\s\S]*?)<\/member>/ig;
  let match;
  while ((match = memberRegex.exec(decoded))) {
    const block = match[1];
    const username = extractXmlTag(block, 'username');
    const display = extractXmlTag(block, 'nickname');
    if (username && display) {
      entries.push({ username, display });
    }
  }
  return entries;
}

function applyAlias(aliases, username, display, priority) {
  const normalizedUsername = normalizeText(username);
  const normalizedDisplay = normalizeText(display);
  if (!normalizedUsername || !normalizedDisplay || normalizedDisplay === '所有人') {
    return;
  }
  const current = aliases.get(normalizedUsername);
  if (!current || Number(priority || 0) >= Number(current.priority || 0)) {
    aliases.set(normalizedUsername, {
      display: normalizedDisplay,
      priority: Number(priority || 0),
    });
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .trim();
}

function classifyMessageType(type, content) {
  switch (Number(type)) {
    case 1:
      return 'text';
    case 3:
      return 'image';
    case 34:
      return 'voice';
    case 43:
    case 62:
      return 'video';
    case 47:
      return 'sticker';
    case 48:
      return 'location';
    case 49:
      return detectAppMsgKind(content) || 'link';
    case 50:
      return 'call';
    case 10000:
    case 10002:
      return 'system';
    default:
      return 'text';
  }
}

function formatMessagePreview(row) {
  const kind = classifyMessageType(row.messageType, row.msgContent);
  const content = normalizeText(row.msgContent);
  if (kind === 'text') {
    const subject = extractXmlSubject(content);
    if (subject) return subject;
    return content || '[空文本]';
  }
  if (kind === 'link' || kind === 'file') {
    const title = extractXmlTitle(content) || extractXmlSubject(content) || extractXmlDigest(content);
    return title || `[${TYPE_LABELS[kind]}]`;
  }
  if (kind === 'system' && content) {
    const title = extractXmlTitle(content) || extractXmlSubject(content) || extractXmlDigest(content);
    return title || content.slice(0, 120);
  }
  return `[${TYPE_LABELS[kind] || `类型${row.messageType}`}]`;
}

function isOutgoingDirection(direction) {
  return Number(direction || 0) === 0;
}

function matchTypeFilter(row, typeFilter) {
  if (!typeFilter) return true;
  return classifyMessageType(row.messageType, row.msgContent) === typeFilter;
}

function escapeIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset: cursor };
    }
    shift += 7;
    if (shift > 35) break;
  }
  return null;
}

function decodeLikelyStrings(buffer) {
  const strings = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const tag = readVarint(buffer, cursor);
    if (!tag) break;
    cursor = tag.offset;
    const wire = tag.value & 0x07;
    if (wire === 0) {
      const next = readVarint(buffer, cursor);
      if (!next) break;
      cursor = next.offset;
      continue;
    }
    if (wire === 1) {
      cursor += 8;
      continue;
    }
    if (wire === 5) {
      cursor += 4;
      continue;
    }
    if (wire !== 2) break;
    const len = readVarint(buffer, cursor);
    if (!len) break;
    const start = len.offset;
    const end = start + len.value;
    if (end > buffer.length) break;
    const chunk = buffer.subarray(start, end);
    const text = normalizeText(chunk.toString('utf8'));
    if (text) strings.push(text);
    cursor = end;
  }
  return strings;
}

function pickSessionDisplay(blob, username) {
  if (!blob) return '';
  const normalized = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const candidates = decodeLikelyStrings(normalized);
  for (const text of candidates) {
    if (!text) continue;
    if (text === username) continue;
    if (text.startsWith('http')) continue;
    if (text === 'IMG_HASH') continue;
    if (text.includes(';')) continue;
    if (text.length > 60) continue;
    return text;
  }
  const rawText = normalized.toString('utf8');
  const fallback = rawText.match(/[\u4e00-\u9fffA-Za-z0-9._-]{4,40}/g) || [];
  for (const text of fallback) {
    if (!text) continue;
    if (text === username) continue;
    if (text === 'chatroom') continue;
    if (text.startsWith('http')) continue;
    if (text === 'IMG_HASH' || text === 'IMG_HASh') continue;
    if (text.includes('wx.qlogo.cn')) continue;
    if (text.length > 40) continue;
    if (/^[0-9]+$/.test(text)) continue;
    if (/@chatroom$/.test(text)) continue;
    if (/^wxid_/i.test(text)) continue;
    if (/^[a-z0-9._-]+$/i.test(text) && !/[\u4e00-\u9fff]/.test(text)) continue;
    return text;
  }
  return '';
}

function decryptPage(encKey, pageData, pgno) {
  const iv = pageData.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + 16);
  const start = pgno === 1 ? 16 : 0;
  const encrypted = pageData.subarray(start, PAGE_SZ - RESERVE_SZ);
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (pgno === 1) {
    return Buffer.concat([SQLITE_HDR, decrypted, Buffer.alloc(RESERVE_SZ)]);
  }
  return Buffer.concat([decrypted, Buffer.alloc(RESERVE_SZ)]);
}

function fullDecrypt(dbPath, outPath, encKey) {
  const data = fs.readFileSync(dbPath);
  const chunks = [];
  for (let i = 0, pgno = 1; i < data.length; i += PAGE_SZ, pgno += 1) {
    let page = data.subarray(i, i + PAGE_SZ);
    if (page.length < PAGE_SZ) {
      page = Buffer.concat([page, Buffer.alloc(PAGE_SZ - page.length)]);
    }
    chunks.push(decryptPage(encKey, page, pgno));
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

function decryptWal(walPath, outPath, encKey) {
  if (!fs.existsSync(walPath)) return 0;
  const wal = fs.readFileSync(walPath);
  if (wal.length <= 32) return 0;
  const walSalt1 = wal.readUInt32BE(16);
  const walSalt2 = wal.readUInt32BE(20);
  const frameSize = 24 + PAGE_SZ;
  let patched = 0;
  const fd = fs.openSync(outPath, 'r+');
  try {
    for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
      const pgno = wal.readUInt32BE(off);
      const frameSalt1 = wal.readUInt32BE(off + 8);
      const frameSalt2 = wal.readUInt32BE(off + 12);
      if (frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) continue;
      if (pgno <= 0 || pgno > 1000000) continue;
      const encPage = wal.subarray(off + 24, off + 24 + PAGE_SZ);
      const decPage = decryptPage(encKey, encPage, pgno);
      fs.writeSync(fd, decPage, 0, decPage.length, (pgno - 1) * PAGE_SZ);
      patched += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return patched;
}

class App {
  constructor(configPath) {
    this.configPath = configPath || path.join(os.homedir(), '.wechat-cli', 'config.json');
    this.baseDir = path.dirname(this.configPath);
    this.config = loadJson(this.configPath, {});
    this.dbDir = this.config.db_dir;
    this.keys = loadJson(path.join(this.baseDir, 'all_keys.json'), {});
    this.cacheMeta = loadJson(MTIME_FILE, {});
    this.contacts = null;
    this.sessionCandidates = null;
    this.chatLookup = new Map();
    this.groupMemberLookup = new Map();
    this.groupRosterLookup = new Map();
    this.groupMessageSenderLookup = new Map();
    this.messageIdColumnLookup = new Map();
    this.tableColumnsLookup = new Map();
  }

  ensureReady() {
    if (!this.dbDir) {
      throw new Error(`缺少配置文件或 db_dir: ${this.configPath}`);
    }
  }

  getDecryptedPath(relKey) {
    this.ensureReady();
    const info = this.keys[relKey];
    if (!info || !info.enc_key) return null;
    const src = path.join(this.dbDir, relKey);
    if (!fs.existsSync(src)) return null;
    const wal = `${src}-wal`;
    const dbMt = fs.statSync(src).mtimeMs;
    const walMt = fs.existsSync(wal) ? fs.statSync(wal).mtimeMs : 0;
    const cacheName = `${md5hex(relKey).slice(0, 12)}.db`;
    const outPath = path.join(CACHE_DIR, cacheName);
    const meta = this.cacheMeta[relKey];
    if (meta && meta.dbMt === dbMt && meta.walMt === walMt && fs.existsSync(outPath)) {
      return outPath;
    }
    const encKey = Buffer.from(info.enc_key, 'hex');
    const tempPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fullDecrypt(src, tempPath, encKey);
      if (fs.existsSync(wal) && fs.statSync(wal).size > 32) {
        decryptWal(wal, tempPath, encKey);
      }
      fs.renameSync(tempPath, outPath);
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
    this.cacheMeta[relKey] = { dbMt, walMt, path: outPath };
    saveJson(MTIME_FILE, this.cacheMeta);
    return outPath;
  }

  openDb(relKey) {
    const dbPath = this.getDecryptedPath(relKey);
    if (!dbPath) return null;
    return this.createDb(dbPath);
  }

  createDb(dbPath) {
    let lastError;
    for (let i = 0; i < 3; i += 1) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;');
        return db;
      } catch (error) {
        lastError = error;
        if (!/database is locked/i.test(String(error.message || error))) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  loadContacts() {
    if (this.contacts) return this.contacts;
    const db = this.openDb(path.join('contact', 'contact.db'));
    if (!db) throw new Error('无法打开联系人库');
    try {
      const rows = db.prepare(`
        SELECT
          m_nsUsrName AS username,
          nickname,
          m_nsRemark AS remark,
          m_nsAliasName AS alias,
          m_nsEncodeUserName AS encodeUsername,
          m_uiType AS type
        FROM WCContact
      `).all();
      const byUsername = new Map();
      for (const row of rows) {
        byUsername.set(row.username, {
          ...row,
          display: normalizeText(row.remark) || normalizeText(row.nickname) || normalizeText(row.alias) || row.username,
        });
      }
      this.contacts = { rows, byUsername };
      return this.contacts;
    } finally {
      db.close();
    }
  }

  getContactDisplay(username) {
    const contact = this.loadContacts().byUsername.get(username);
    return contact ? contact.display : '';
  }

  getMessageDbRelKeys() {
    return Object.keys(this.keys)
      .filter((key) => key.startsWith('message/') && key.endsWith('.db'))
      .sort();
  }

  getMessageLocalIdColumn(location) {
    const cacheKey = `${location.dbPath}:${location.table}`;
    if (this.messageIdColumnLookup.has(cacheKey)) {
      return this.messageIdColumnLookup.get(cacheKey);
    }
    const db = this.createDb(location.dbPath);
    try {
      const rows = db.prepare(`PRAGMA table_info(${escapeIdent(location.table)})`).all();
      const match = rows.find((row) => ['mesLocalID', 'localId', 'msgLocalID'].includes(row.name))
        || rows.find((row) => ['meslocalid', 'localid', 'msglocalid'].includes(String(row.name).toLowerCase()));
      const column = match ? match.name : null;
      this.messageIdColumnLookup.set(cacheKey, column);
      return column;
    } finally {
      db.close();
    }
  }

  getTableColumns(db, dbPath, tableName) {
    const cacheKey = `${dbPath}:${tableName}`;
    if (this.tableColumnsLookup.has(cacheKey)) {
      return this.tableColumnsLookup.get(cacheKey);
    }
    const columns = db.prepare(`PRAGMA table_info(${escapeIdent(tableName)})`).all().map((row) => row.name);
    this.tableColumnsLookup.set(cacheKey, columns);
    return columns;
  }

  getGroupRoster(chatUsername) {
    if (this.groupRosterLookup.has(chatUsername)) {
      return this.groupRosterLookup.get(chatUsername);
    }
    const session = this.getSessionCandidates().find((row) => row.username === chatUsername);
    const roster = session ? extractRoomDataMembers(session.sessionInfo) : { members: [], displayMap: new Map() };
    this.groupRosterLookup.set(chatUsername, roster);
    return roster;
  }

  buildGroupMessageSenderMap(chatUsername) {
    if (this.groupMessageSenderLookup.has(chatUsername)) {
      return this.groupMessageSenderLookup.get(chatUsername);
    }
    const location = this.findChatTable(chatUsername);
    const senderByLocalId = new Map();
    if (!location) {
      this.groupMessageSenderLookup.set(chatUsername, senderByLocalId);
      return senderByLocalId;
    }
    const localIdColumn = this.getMessageLocalIdColumn(location);
    if (!localIdColumn) {
      this.groupMessageSenderLookup.set(chatUsername, senderByLocalId);
      return senderByLocalId;
    }
    const db = this.createDb(location.dbPath);
    try {
      const rows = db.prepare(`
        SELECT ${escapeIdent(localIdColumn)} AS localId, msgContent
        FROM ${escapeIdent(location.table)}
        WHERE msgContent IS NOT NULL
      `).all();
      for (const row of rows) {
        const localId = Number(row.localId);
        if (!Number.isFinite(localId)) continue;
        const { rawSender } = extractGroupRawSender(row.msgContent);
        if (rawSender && !senderByLocalId.has(localId)) {
          senderByLocalId.set(localId, rawSender);
        }
      }
    } finally {
      db.close();
    }
    this.groupMessageSenderLookup.set(chatUsername, senderByLocalId);
    return senderByLocalId;
  }

  collectLocalGroupAliases(chatUsername, aliases) {
    const location = this.findChatTable(chatUsername);
    if (!location) return;
    const db = this.createDb(location.dbPath);
    try {
      const rows = db.prepare(`
        SELECT msgContent, msgSource
        FROM ${escapeIdent(location.table)}
        WHERE msgContent IS NOT NULL
          AND (
            msgContent LIKE ?
            OR msgContent LIKE ?
            OR msgContent LIKE ?
            OR msgSource LIKE ?
          )
      `).all('%<refermsg>%', '%<displayname>%', '%<memberlist>%', '%atuserlist%');
      for (const row of rows) {
        for (const entry of extractReplyDisplayEntries(row.msgContent, chatUsername)) {
          applyAlias(aliases, entry.username, entry.display, 50);
        }
        for (const entry of extractSysmsgMemberEntries(row.msgContent)) {
          applyAlias(aliases, entry.username, entry.display, 35);
        }
        const atUsers = extractAtUsernames(row.msgSource);
        const atNames = extractMentionDisplayNames(toUtf8Text(row.msgContent));
        const pairCount = Math.min(atUsers.length, atNames.length);
        for (let i = 0; i < pairCount; i += 1) {
          applyAlias(aliases, atUsers[i], atNames[i], 30);
        }
      }
    } finally {
      db.close();
    }
  }

  collectCrossDbGroupAliases(chatUsername, aliases, senderByLocalId) {
    const relKeys = this.getMessageDbRelKeys();
    const like = `%${chatUsername}%`;
    for (const relKey of relKeys) {
      const dbPath = this.getDecryptedPath(relKey);
      if (!dbPath) continue;
      const db = this.createDb(dbPath);
      try {
        const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ?').all('table', 'Chat_%');
        for (const tableRow of tables) {
          if (tableRow.name.endsWith('_dels')) continue;
          const columns = this.getTableColumns(db, dbPath, tableRow.name);
          if (!columns.includes('msgContent')) continue;
          const rows = db.prepare(`
            SELECT msgContent
            FROM ${escapeIdent(tableRow.name)}
            WHERE msgContent IS NOT NULL AND msgContent LIKE ?
          `).all(like);
          for (const row of rows) {
            for (const entry of extractReplyDisplayEntries(row.msgContent, chatUsername)) {
              applyAlias(aliases, entry.username, entry.display, 50);
            }
            for (const item of extractRecordSourceItems(row.msgContent, chatUsername)) {
              const rawSender = senderByLocalId.get(item.srcMsgLocalId);
              if (rawSender) {
                applyAlias(aliases, rawSender, item.sourceName, 40);
              }
            }
          }
        }
      } finally {
        db.close();
      }
    }
  }

  buildGroupMemberDisplayMap(chatUsername) {
    const aliases = new Map();
    const roster = this.getGroupRoster(chatUsername);
    for (const [username, display] of roster.displayMap.entries()) {
      applyAlias(aliases, username, display, 10);
    }
    const senderByLocalId = this.buildGroupMessageSenderMap(chatUsername);
    this.collectLocalGroupAliases(chatUsername, aliases);
    this.collectCrossDbGroupAliases(chatUsername, aliases, senderByLocalId);
    return new Map(Array.from(aliases.entries()).map(([username, meta]) => [username, meta.display]));
  }

  getGroupMemberDisplay(chatUsername, memberUsername) {
    const contactDisplay = this.getContactDisplay(memberUsername);
    if (contactDisplay) return contactDisplay;
    if (!this.groupMemberLookup.has(chatUsername)) {
      this.groupMemberLookup.set(chatUsername, this.buildGroupMemberDisplayMap(chatUsername));
    }
    const aliases = this.groupMemberLookup.get(chatUsername);
    return aliases.get(memberUsername) || '';
  }

  getSessionCandidates() {
    if (this.sessionCandidates) return this.sessionCandidates;
    const db = this.openDb(path.join('session', 'session.db'));
    if (!db) throw new Error('无法打开会话库');
    try {
      const rows = db.prepare(`
        SELECT m_nsUserName AS username, m_uUnReadCount AS unread, m_uLastTime AS lastTime, _packed_MMSessionInfo AS sessionInfo
        FROM SessionAbstract
        UNION ALL
        SELECT m_nsUserName AS username, m_uUnReadCount AS unread, m_uLastTime AS lastTime, _packed_MMSessionInfo AS sessionInfo
        FROM SessionAbstractBrand
      `).all();
      const dedup = new Map();
      for (const row of rows) {
        const display = this.getContactDisplay(row.username) || pickSessionDisplay(row.sessionInfo, row.username) || row.username;
        const normalized = {
          username: row.username,
          unread: Number(row.unread || 0),
          lastTime: Number(row.lastTime || 0),
          display,
          sessionInfo: row.sessionInfo,
        };
        const prev = dedup.get(row.username);
        if (!prev || normalized.lastTime > prev.lastTime) {
          dedup.set(row.username, normalized);
        }
      }
      this.sessionCandidates = Array.from(dedup.values()).sort((a, b) => b.lastTime - a.lastTime);
      return this.sessionCandidates;
    } finally {
      db.close();
    }
  }

  resolveChat(input) {
    const target = normalizeText(input);
    if (!target) {
      throw new Error('缺少聊天对象');
    }
    const contacts = this.loadContacts().rows;
    const sessions = this.getSessionCandidates();
    const candidates = new Map();
    const push = (username, meta) => {
      if (!username) return;
      if (!candidates.has(username)) candidates.set(username, { username, sources: new Set(), labels: new Set() });
      const item = candidates.get(username);
      if (meta.source) item.sources.add(meta.source);
      for (const label of meta.labels || []) {
        if (label) item.labels.add(normalizeText(label));
      }
    };
    for (const row of contacts) {
      push(row.username, {
        source: 'contact',
        labels: [row.username, row.nickname, row.remark, row.alias, row.encodeUsername],
      });
    }
    for (const row of sessions) {
      push(row.username, {
        source: 'session',
        labels: [row.username, row.display],
      });
    }
    const exact = [];
    const fuzzy = [];
    for (const item of candidates.values()) {
      const labels = Array.from(item.labels).filter(Boolean);
      const lowered = labels.map((label) => label.toLowerCase());
      const query = target.toLowerCase();
      if (item.username === target || lowered.includes(query)) {
        exact.push(item);
        continue;
      }
      if (item.username.toLowerCase().includes(query) || lowered.some((label) => label.includes(query))) {
        fuzzy.push(item);
      }
    }
    const matches = exact.length ? exact : fuzzy;
    if (matches.length === 0) {
      throw new Error(`找不到聊天对象: ${input}`);
    }
    if (matches.length > 1) {
      const preview = matches.slice(0, 10).map((item) => {
        const best = Array.from(item.labels).find((label) => label && label !== item.username) || item.username;
        return `- ${best} (${item.username})`;
      }).join('\n');
      throw new Error(`匹配到多个聊天对象，请用更精确的名称或直接用 username:\n${preview}`);
    }
    const match = matches[0];
    return this.getSessionCandidates().find((row) => row.username === match.username)
      || this.loadContacts().byUsername.get(match.username)
      || { username: match.username, display: match.username };
  }

  findChatTable(username) {
    if (this.chatLookup.has(username)) return this.chatLookup.get(username);
    const table = `Chat_${md5hex(username)}`;
    const relKeys = this.getMessageDbRelKeys();
    for (const relKey of relKeys) {
      const dbPath = this.getDecryptedPath(relKey);
      if (!dbPath) continue;
      const db = this.createDb(dbPath);
      try {
        const row = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
        if (row) {
          const found = { relKey, dbPath, table };
          this.chatLookup.set(username, found);
          return found;
        }
      } finally {
        db.close();
      }
    }
    this.chatLookup.set(username, null);
    return null;
  }

  parseMessageRow(username, row) {
    const isGroup = username.endsWith('@chatroom');
    let content = normalizeText(row.msgContent);
    let sender = '';
    if (isGroup) {
      const parsed = extractGroupRawSender(content);
      if (parsed.rawSender) {
        sender = this.getGroupMemberDisplay(username, parsed.rawSender) || parsed.rawSender;
        content = parsed.body;
      }
    }
    const normalized = {
      username,
      createTime: Number(row.msgCreateTime || 0),
      messageType: Number(row.messageType || 0),
      direction: Number(row.mesDes || 0),
      sender,
      rawContent: normalizeText(row.msgContent),
      content,
    };
    normalized.kind = classifyMessageType(normalized.messageType, normalized.rawContent);
    normalized.preview = formatMessagePreview({
      messageType: normalized.messageType,
      msgContent: normalized.content,
    });
    return normalized;
  }

  getMessages(username, opts = {}) {
    const location = this.findChatTable(username);
    if (!location) return [];
    const db = this.createDb(location.dbPath);
    try {
      const params = [];
      const where = [];
      if (opts.startTime) {
        where.push('msgCreateTime >= ?');
        params.push(opts.startTime);
      }
      if (opts.endTime) {
        where.push('msgCreateTime <= ?');
        params.push(opts.endTime);
      }
      const sql = `
        SELECT msgCreateTime, msgContent, messageType, mesDes, msgSource
        FROM ${escapeIdent(location.table)}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY msgCreateTime DESC
        LIMIT ?
        OFFSET ?
      `;
      params.push(opts.limit ?? 50, opts.offset ?? 0);
      let rows = db.prepare(sql).all(...params).map((row) => this.parseMessageRow(username, row));
      if (opts.type) {
        rows = rows.filter((row) => matchTypeFilter(row, opts.type));
      }
      return rows.reverse();
    } finally {
      db.close();
    }
  }

  searchMessages(keyword, opts = {}) {
    const like = `%${keyword}%`;
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    const chatArgs = opts.chats || [];
    let chats = [];
    if (chatArgs.length) {
      chats = chatArgs.map((chat) => this.resolveChat(chat));
    } else {
      chats = this.getSessionCandidates().slice(0, 300);
    }
    const hits = [];
    for (const chat of chats) {
      const location = this.findChatTable(chat.username);
      if (!location) continue;
      const db = this.createDb(location.dbPath);
      try {
        const params = [like];
        const where = ['msgContent LIKE ?'];
        if (opts.startTime) {
          where.push('msgCreateTime >= ?');
          params.push(opts.startTime);
        }
        if (opts.endTime) {
          where.push('msgCreateTime <= ?');
          params.push(opts.endTime);
        }
        params.push(Math.min(limit + offset, 200));
        const sql = `
          SELECT msgCreateTime, msgContent, messageType, mesDes, msgSource
          FROM ${escapeIdent(location.table)}
          WHERE ${where.join(' AND ')}
          ORDER BY msgCreateTime DESC
          LIMIT ?
        `;
        let rows = db.prepare(sql).all(...params).map((row) => this.parseMessageRow(chat.username, row));
        if (opts.type) {
          rows = rows.filter((row) => matchTypeFilter(row, opts.type));
        }
        for (const row of rows) {
          hits.push({
            ...row,
            chat: chat.display || chat.username,
            chatUsername: chat.username,
          });
        }
      } finally {
        db.close();
      }
    }
    hits.sort((a, b) => b.createTime - a.createTime);
    return hits.slice(offset, offset + limit);
  }

  getSessions(opts = {}) {
    const rows = this.getSessionCandidates()
      .filter((row) => !opts.unreadOnly || row.unread > 0)
      .slice(0, opts.limit ?? 20)
      .map((row) => ({
        chat: row.display || row.username,
        username: row.username,
        unread: row.unread,
        timestamp: row.lastTime,
        time: formatUnix(row.lastTime),
      }));
    return rows;
  }
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function outputText(value) {
  process.stdout.write(`${value}\n`);
}

function printTopHelp() {
  outputText(`Usage: wechat-cli [OPTIONS] COMMAND [ARGS]...

wechat-cli-macos-compat

Commands:
  init          继续使用原版初始化
  sessions      最近会话列表
  unread        未读会话
  contacts      联系人搜索/详情
  history       聊天记录
  search        消息搜索
  new-messages  增量消息

Global Options:
  --config TEXT  指定 config.json
  --help         显示帮助
  --version      显示版本
`);
}

function renderSessions(rows, title) {
  if (!rows.length) return `${title}: 0 个`;
  return [
    `${title}: ${rows.length} 个`,
    '',
    ...rows.map((row) => `[${row.time}] ${row.chat} (${row.username})${row.unread > 0 ? ` [${row.unread} 未读]` : ''}`),
  ].join('\n');
}

function renderContacts(rows) {
  if (!rows.length) return '没有匹配的联系人';
  return rows.map((row) => {
    const lines = [`${row.display} (${row.username})`];
    if (row.remark) lines.push(`  备注: ${row.remark}`);
    if (row.nickname && row.nickname !== row.display) lines.push(`  昵称: ${row.nickname}`);
    if (row.alias) lines.push(`  微信号: ${row.alias}`);
    return lines.join('\n');
  }).join('\n\n');
}

function resolveSpeakerLabel(target, row) {
  if (row.sender) return row.sender;
  if (row.outgoing) return '我';
  const username = target.chatUsername || target.username || '';
  if (username.endsWith('@chatroom')) return '';
  return target.chat || target.display || target.username || '';
}

function renderHistory(chat, rows) {
  if (!rows.length) return `没有消息: ${chat.display || chat.username}`;
  return rows.map((row) => {
    const prefix = `[${formatUnix(row.createTime)}]`;
    const speaker = resolveSpeakerLabel(chat, row);
    return speaker ? `${prefix} ${speaker}: ${row.preview}` : `${prefix} ${row.preview}`;
  }).join('\n');
}

function renderSearch(rows) {
  if (!rows.length) return '没有搜索结果';
  return rows.map((row) => {
    const speaker = resolveSpeakerLabel(row, row);
    const prefix = `[${formatUnix(row.createTime)}] ${row.chat} (${row.chatUsername})`;
    return speaker ? `${prefix} ${speaker}: ${row.preview}` : `${prefix}: ${row.preview}`;
  }).join('\n');
}

function loadState() {
  return loadJson(STATE_FILE, {});
}

function saveState(state) {
  saveJson(STATE_FILE, state);
}

function runPatched(argv) {
  const global = parseGlobalArgs(argv);
  const rest = global.rest.filter((arg) => arg !== '--help' && arg !== '--version');
  const command = rest[0];
  if (global.version) {
    const pkg = loadJson(path.join(__dirname, '..', 'package.json'), {});
    outputText(pkg.version || '0.1.0');
    return;
  }
  if (!command) {
    printTopHelp();
    return;
  }
  if (global.help && rest.length === 1) {
    printTopHelp();
    return;
  }
  const implemented = new Set(['sessions', 'unread', 'contacts', 'history', 'search', 'new-messages']);
  if (!implemented.has(command)) {
    forwardToOriginal(argv);
    return;
  }
  if (global.help) {
    forwardToOriginal(argv);
    return;
  }
  const { positional, options } = parseCommandArgs(rest.slice(1));
  const app = new App(global.configPath);
  const fmt = options.format === 'text' ? 'text' : 'json';

  if (command === 'sessions') {
    const rows = app.getSessions({ limit: toInt(options.limit, 20) });
    if (fmt === 'json') return outputJson(rows);
    return outputText(renderSessions(rows, '最近会话'));
  }

  if (command === 'unread') {
    const rows = app.getSessions({ limit: toInt(options.limit, 20), unreadOnly: true });
    if (fmt === 'json') return outputJson(rows);
    return outputText(renderSessions(rows, '未读会话'));
  }

  if (command === 'contacts') {
    const limit = toInt(options.limit, 20);
    const detail = normalizeText(options.detail || '');
    const query = normalizeText(options.query || '');
    const rows = app.loadContacts().rows.map((row) => ({
      username: row.username,
      nickname: normalizeText(row.nickname),
      remark: normalizeText(row.remark),
      alias: normalizeText(row.alias),
      encodeUsername: normalizeText(row.encodeUsername),
      type: Number(row.type || 0),
      display: normalizeText(row.remark) || normalizeText(row.nickname) || normalizeText(row.alias) || row.username,
    }));
    let result = rows;
    if (detail) {
      result = rows.filter((row) => [row.username, row.nickname, row.remark, row.alias, row.encodeUsername].includes(detail)).slice(0, 1);
    } else if (query) {
      const q = query.toLowerCase();
      result = rows.filter((row) => [row.username, row.nickname, row.remark, row.alias, row.encodeUsername].some((field) => normalizeText(field).toLowerCase().includes(q))).slice(0, limit);
    } else {
      result = rows.slice(0, limit);
    }
    if (fmt === 'json') return outputJson(result);
    return outputText(renderContacts(result));
  }

  if (command === 'history') {
    const chatInput = positional[0];
    if (!chatInput) throw new Error('用法: wechat-cli history "聊天名" [OPTIONS]');
    const chat = app.resolveChat(chatInput);
    const rows = app.getMessages(chat.username, {
      limit: toInt(options.limit, 50),
      offset: toInt(options.offset, 0),
      startTime: parseTimeInput(options['start-time']),
      endTime: parseTimeInput(options['end-time'], true),
      type: options.type || null,
    }).map((row) => ({
      chat: chat.display || chat.username,
      username: chat.username,
      timestamp: row.createTime,
      time: formatUnix(row.createTime),
      type: row.kind,
      sender: row.sender,
      content: row.preview,
      outgoing: isOutgoingDirection(row.direction),
    }));
    if (fmt === 'json') return outputJson(rows);
    return outputText(renderHistory(chat, rows.map((row) => ({
      createTime: row.timestamp,
      preview: row.content,
      sender: row.sender,
      outgoing: row.outgoing,
    }))));
  }

  if (command === 'search') {
    const keyword = positional[0];
    if (!keyword) throw new Error('用法: wechat-cli search "关键词" [OPTIONS]');
    const rows = app.searchMessages(keyword, {
      chats: toArray(options.chat),
      startTime: parseTimeInput(options['start-time']),
      endTime: parseTimeInput(options['end-time'], true),
      limit: toInt(options.limit, 50),
      offset: toInt(options.offset, 0),
      type: options.type || null,
    }).map((row) => ({
      chat: row.chat,
      username: row.chatUsername,
      timestamp: row.createTime,
      time: formatUnix(row.createTime),
      type: row.kind,
      sender: row.sender,
      content: row.preview,
      outgoing: isOutgoingDirection(row.direction),
    }));
    if (fmt === 'json') return outputJson(rows);
    return outputText(renderSearch(rows.map((row) => ({
      chat: row.chat,
      chatUsername: row.username,
      createTime: row.timestamp,
      sender: row.sender,
      preview: row.content,
      outgoing: row.outgoing,
    }))));
  }

  if (command === 'new-messages') {
    const state = loadState();
    const lastTs = Number(state.lastTs || 0);
    const rows = app.searchMessages('', {
      startTime: lastTs ? lastTs + 1 : Math.floor(Date.now() / 1000) - 86400,
      limit: toInt(options.limit, 100),
      offset: 0,
    }).filter((row) => row.createTime > lastTs);
    const maxTs = rows.reduce((max, row) => Math.max(max, row.createTime), lastTs);
    saveState({ ...state, lastTs: maxTs });
    const normalized = rows.map((row) => ({
      chat: row.chat,
      username: row.chatUsername,
      timestamp: row.createTime,
      time: formatUnix(row.createTime),
      type: row.kind,
      sender: row.sender,
      content: row.preview,
      outgoing: isOutgoingDirection(row.direction),
    }));
    if (fmt === 'json') return outputJson(normalized);
    return outputText(renderSearch(normalized.map((row) => ({
      chat: row.chat,
      chatUsername: row.username,
      createTime: row.timestamp,
      sender: row.sender,
      preview: row.content,
      outgoing: row.outgoing,
    }))));
  }
}

function main() {
  try {
    runPatched(process.argv.slice(2));
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  isOutgoingDirection,
  resolveSpeakerLabel,
  renderHistory,
  renderSearch,
  extractRoomDataMembers,
  extractReplyDisplayEntries,
  extractRecordSourceItems,
  extractSysmsgMemberEntries,
  applyAlias,
};
