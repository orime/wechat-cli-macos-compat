const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCliExports() {
  const file = path.join(__dirname, '..', 'bin', 'wechat-cli.js');
  const source = fs.readFileSync(file, 'utf8');
  const wrapped = `${source}\nmodule.exports = { isOutgoingDirection, resolveSpeakerLabel, renderHistory, renderSearch };`;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    __dirname: path.dirname(file),
    __filename: file,
    process: {
      ...process,
      argv: ['node', file],
      exit(code) {
        throw new Error(`process.exit:${code}`);
      },
    },
    console: { log() {}, error() {}, warn() {} },
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  try {
    vm.runInNewContext(wrapped, sandbox, { filename: file });
  } catch (error) {
    if (!String(error.message || error).startsWith('process.exit:')) throw error;
  }
  return sandbox.module.exports;
}

test('mesDes 方向位应把 0 识别为我发出，1 识别为对方发来', () => {
  const { isOutgoingDirection } = loadCliExports();
  assert.equal(typeof isOutgoingDirection, 'function');
  assert.equal(isOutgoingDirection(0), true);
  assert.equal(isOutgoingDirection(1), false);
});

test('私聊文本输出应明确区分 我 和 对方', () => {
  const { renderHistory } = loadCliExports();
  const chat = { username: 'feiniaoluck1121', display: '小白李强' };
  const output = renderHistory(chat, [
    { createTime: 1775662142, preview: '你直接装就完事了呀', sender: '', outgoing: true },
    { createTime: 1775662187, preview: '你直接装应该没啥坑如果版本比较高的话', sender: '', outgoing: false },
  ]);
  assert.match(output, /\] 我: 你直接装就完事了呀/);
  assert.match(output, /\] 小白李强: 你直接装应该没啥坑如果版本比较高的话/);
});

test('群聊文本输出应优先显示群成员名，自己发言显示 我', () => {
  const { renderSearch } = loadCliExports();
  const output = renderSearch([
    {
      chat: 'Ai-n8n学术交流群',
      chatUsername: '58311197963@chatroom',
      createTime: 1775662456,
      sender: '某成员',
      preview: '容易被封吧',
      outgoing: false,
    },
    {
      chat: 'Ai-n8n学术交流群',
      chatUsername: '58311197963@chatroom',
      createTime: 1775662654,
      sender: '',
      preview: '这个工具价值极高',
      outgoing: true,
    },
  ]);
  assert.match(output, /Ai-n8n学术交流群 .* 某成员: 容易被封吧/);
  assert.match(output, /Ai-n8n学术交流群 .* 我: 这个工具价值极高/);
});
