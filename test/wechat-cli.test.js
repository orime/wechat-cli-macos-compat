const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCliExports() {
  const file = path.join(__dirname, '..', 'bin', 'wechat-cli.js');
  const source = fs.readFileSync(file, 'utf8');
  const wrapped = `${source}\nmodule.exports = { isOutgoingDirection, resolveSpeakerLabel, renderHistory, renderSearch, extractRoomDataMembers, extractReplyDisplayEntries, extractRecordSourceItems, extractSysmsgMemberEntries, applyAlias };`;
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

function normalizeVmValue(value) {
  return JSON.parse(JSON.stringify(value));
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

test('应从 RoomData 中提取群成员和少量可用的 DisplayName', () => {
  const { extractRoomDataMembers } = loadCliExports();
  const sessionInfo = Buffer.from(`
    header bytes
    <RoomData>
      <Member UserName="q12345656000"><Flag>8193</Flag></Member>
      <Member UserName="wxid_lof17r43wzoa21"><DisplayName><![CDATA[孤松雨露树均沾]]></DisplayName></Member>
      <Member UserName="wxid_sb3cudb940nv22"><DisplayName>在下好方ᓚᘏᙧ</DisplayName></Member>
    </RoomData>
    trailer bytes
  `, 'utf8');

  const result = extractRoomDataMembers(sessionInfo);

  assert.deepEqual(
    normalizeVmValue(result.members),
    ['q12345656000', 'wxid_lof17r43wzoa21', 'wxid_sb3cudb940nv22'],
  );
  assert.equal(result.displayMap.get('q12345656000'), undefined);
  assert.equal(result.displayMap.get('wxid_lof17r43wzoa21'), '孤松雨露树均沾');
  assert.equal(result.displayMap.get('wxid_sb3cudb940nv22'), '在下好方ᓚᘏᙧ');
});

test('应从 reply XML 中提取群内被引用消息的 chatusr 和 displayname', () => {
  const { extractReplyDisplayEntries } = loadCliExports();
  const xml = `
    <msg>
      <appmsg>
        <refermsg>
          <type>1</type>
          <content>test</content>
          <displayname>Jason Statham</displayname>
          <chatusr>wxid_toonmiona6m521</chatusr>
          <fromusr>58311197963@chatroom</fromusr>
        </refermsg>
      </appmsg>
    </msg>
  `;

  assert.deepEqual(
    normalizeVmValue(extractReplyDisplayEntries(xml, '58311197963@chatroom')),
    [{ username: 'wxid_toonmiona6m521', display: 'Jason Statham' }],
  );
});

test('应从 recorditem 中提取源群消息 localId 和 sourcename', () => {
  const { extractRecordSourceItems } = loadCliExports();
  const xml = `
    <msg>
      <recorditem>
        <datalist>
          <dataitem dataid="abc">
            <sourcename>泫晨懿然</sourcename>
            <srcChatname>58311197963@chatroom</srcChatname>
            <srcMsgLocalid>19263</srcMsgLocalid>
          </dataitem>
        </datalist>
      </recorditem>
    </msg>
  `;

  assert.deepEqual(
    normalizeVmValue(extractRecordSourceItems(xml, '58311197963@chatroom')),
    [{ sourceName: '泫晨懿然', srcMsgLocalId: 19263 }],
  );
});

test('应从邀请入群系统消息里提取 username 和 nickname', () => {
  const { extractSysmsgMemberEntries } = loadCliExports();
  const xml = `
    <sysmsg type="sysmsgtemplate">
      <sysmsgtemplate>
        <content_template type="tmpl_type_profile">
          <link_list>
            <link name="names" type="link_profile">
              <memberlist>
                <member>
                  <username><![CDATA[wxid_b5xlahscnp2822]]></username>
                  <nickname><![CDATA[生来彷徨]]></nickname>
                </member>
              </memberlist>
            </link>
          </link_list>
        </content_template>
      </sysmsgtemplate>
    </sysmsg>
  `;

  assert.deepEqual(
    normalizeVmValue(extractSysmsgMemberEntries(xml)),
    [{ username: 'wxid_b5xlahscnp2822', display: '生来彷徨' }],
  );
});

test('更高优先级的别名来源应覆盖低优先级来源', () => {
  const { applyAlias } = loadCliExports();
  const aliases = new Map();

  applyAlias(aliases, 'q12345656000', '群资料旧昵称', 10);
  applyAlias(aliases, 'q12345656000', '泫晨懿然', 40);

  assert.deepEqual(normalizeVmValue(aliases.get('q12345656000')), {
    display: '泫晨懿然',
    priority: 40,
  });
});
