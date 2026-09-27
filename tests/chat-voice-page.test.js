const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../pages/chat/index.js'), 'utf8');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const event = (id) => ({ currentTarget: { dataset: { id, file: 'cloud://untrusted-event-file' } } });
const voice = (id, sender = 'alice') => ({ id, msgType: 'voice', voiceFileId: `cloud://env/chat/voice/${id}.mp3`, fromOpenid: sender });

const createPage = ({ resolveUrl, upload } = {}) => {
  let definition;
  let account = 'bob';
  const calls = { urls: [], clientUrls: 0, audio: [], toasts: [], uploads: [], sends: [], shown: [] };
  const modules = {
    '../../utils/auth': { getSelfOpenid: () => account },
    '../../utils/chat': {
      getVoicePlaybackUrl: async (...args) => {
        calls.urls.push(args);
        return resolveUrl ? resolveUrl(...args) : { url: `https://storage.example/${args[1]}?sign=fresh` };
      },
      sendVoiceMessage: async (...args) => {
        calls.sends.push(args);
        return { message: { id: 'sent', ...args[1] } };
      },
    },
    '../../utils/cloud': {
      resolveCloudFileUrl: async () => { calls.clientUrls++; return ''; },
      uploadFileToCloud: async (...args) => {
        calls.uploads.push(args);
        return upload ? upload(...args) : `cloud://env/${args[1]}`;
      },
    },
    '../../utils/theme': { getStoredThemeClass: () => '' },
    '../../utils/chat-unread': {},
    '../../utils/ai-chat': { AI_CONVERSATION_ID: 'ai-companion', AI_NAME: '小伴' },
    './emoji-data': { EMOJI_LIST: [] },
  };
  vm.runInNewContext(source, {
    Page: value => { definition = value; },
    require: name => modules[name],
    wx: {
      showToast: value => calls.toasts.push(value),
      showLoading() {}, hideLoading() {},
      createInnerAudioContext() {
        const audio = {
          played: 0, stopped: 0, destroyed: 0,
          onEnded(fn) { this.end = fn; },
          onError(fn) { this.error = fn; },
          play() { this.played++; },
          stop() { this.stopped++; },
          destroy() { this.destroyed++; },
        };
        calls.audio.push(audio);
        return audio;
      },
    },
  });
  const page = {
    ...definition,
    data: { ...structuredClone(definition.data), activeId: 'room', myOpenid: 'bob', messages: [voice('one'), voice('two')] },
    _visible: true, _viewGeneration: 1,
    setData(patch, done) { Object.assign(this.data, patch); done?.(); },
    showSentMessage(...args) { calls.shown.push(args); this.data.sending = false; },
  };
  return { page, calls, switchAccount: value => { account = value; page.data.myOpenid = value; } };
};

test('接收者经服务端消息授权获得语音链接，不调用受创建者权限限制的客户端换链', async () => {
  const { page, calls } = createPage();
  await page.playVoice(event('one'));
  assert.deepEqual(calls.urls, [['room', 'one']]);
  assert.equal(calls.clientUrls, 0);
  assert.equal(calls.audio[0].src, 'https://storage.example/one?sign=fresh');
  assert.equal(calls.audio[0].played, 1);
  assert.equal(page.data.playingVoiceId, 'one');
  calls.audio[0].end();
  assert.equal(page.data.playingVoiceId, '');
  assert.equal(calls.audio[0].destroyed, 1);
});

test('重复播放重新申请链接，播放出错后释放资源并可重试', async () => {
  const { page, calls } = createPage();
  await page.playVoice(event('one'));
  calls.audio[0].error();
  assert.equal(page.audioCtx, null);
  assert.equal(calls.audio[0].destroyed, 1);
  assert.equal(calls.toasts.length, 1);
  await page.playVoice(event('one'));
  assert.equal(calls.urls.length, 2);
  assert.equal(calls.audio[1].played, 1);
});

test('连续点不同语音时，只播放最后一次选择，旧回包不会抢占', async () => {
  const one = deferred();
  const two = deferred();
  const { page, calls } = createPage({ resolveUrl: (_room, id) => id === 'one' ? one.promise : two.promise });
  const first = page.playVoice(event('one'));
  const second = page.playVoice(event('two'));
  two.resolve({ url: 'https://storage.example/two' });
  await second;
  one.resolve({ url: 'https://storage.example/one' });
  await first;
  assert.equal(calls.audio.length, 1);
  assert.equal(calls.audio[0].src, 'https://storage.example/two');
  assert.equal(page.data.playingVoiceId, 'two');
});

test('等待期间再次点击相同语音会取消，迟到链接不能自动播放', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ resolveUrl: () => pending.promise });
  const first = page.playVoice(event('one'));
  await page.playVoice(event('one'));
  pending.resolve({ url: 'https://storage.example/one' });
  await first;
  assert.equal(calls.urls.length, 1);
  assert.equal(calls.audio.length, 0);
  assert.equal(page._pendingVoiceId, '');
});

test('切会话、切账号或隐藏后，旧语音授权回包不触发播放或错误提示', async () => {
  for (const transition of ['conversation', 'account', 'hide']) {
    for (const failed of [false, true]) {
      const pending = deferred();
      const { page, calls, switchAccount } = createPage({ resolveUrl: () => pending.promise });
      const playing = page.playVoice(event('one'));
      if (transition === 'conversation') page.data.activeId = 'other';
      if (transition === 'account') switchAccount('carol');
      if (transition === 'hide') { page._visible = false; page.stopVoicePlayback(); }
      if (failed) pending.reject(new Error('private storage error'));
      else pending.resolve({ url: 'https://storage.example/one' });
      await playing;
      assert.equal(calls.audio.length, 0);
      assert.equal(calls.toasts.length, 0);
    }
  }
});

test('旧播放器的迟到结束和错误事件不能清除新的播放状态', async () => {
  const { page, calls } = createPage();
  await page.playVoice(event('one'));
  await page.playVoice(event('two'));
  calls.audio[0].end();
  calls.audio[0].error();
  assert.equal(page.audioCtx, calls.audio[1]);
  assert.equal(page.data.playingVoiceId, 'two');
  assert.equal(calls.audio[0].destroyed, 1);
  assert.equal(calls.toasts.length, 0);
});

test('消息不存在、非语音或AI会话不会请求任意文件授权', async () => {
  const { page, calls } = createPage();
  await page.playVoice(event('unknown'));
  page.data.messages.push({ id: 'text', msgType: 'text' });
  await page.playVoice(event('text'));
  page.data.activeId = 'ai-companion';
  await page.playVoice(event('one'));
  assert.equal(calls.urls.length, 0);
});

test('授权失败与非法URL均显示固定提示，不泄露底层错误或播放不安全地址', async () => {
  for (const resolveUrl of [async () => { throw new Error('private error with signed URL'); }, async () => ({ url: 'http://storage.example/file' })]) {
    const { page, calls } = createPage({ resolveUrl });
    await page.playVoice(event('one'));
    assert.equal(calls.audio.length, 0);
    assert.equal(calls.toasts[0].title, '语音暂时无法播放，请重试');
    assert.equal(page._pendingVoiceId, '');
  }
});

test('新语音上传路径绑定会话和发送者，发送返回后正常展示', async () => {
  const { page, calls } = createPage();
  await page.uploadAndSendVoice('/tmp/voice.mp3', 3);
  assert.match(calls.uploads[0][1], /^chat\/voice\/room\/bob\/\d+-[a-z0-9]+\.mp3$/);
  assert.equal(calls.sends[0][0], 'room');
  assert.equal(calls.sends[0][1].voiceFileId, `cloud://env/${calls.uploads[0][1]}`);
  assert.equal(calls.shown.length, 1);
});

test('语音上传期间切账号，不把上一账号文件发送到新账号', async () => {
  const pending = deferred();
  const { page, calls, switchAccount } = createPage({ upload: () => pending.promise });
  const sending = page.uploadAndSendVoice('/tmp/voice.mp3', 3);
  switchAccount('carol');
  pending.resolve('cloud://env/chat/voice/room/bob/upload.mp3');
  await sending;
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.shown.length, 0);
});
