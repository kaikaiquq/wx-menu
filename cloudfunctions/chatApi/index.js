const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ data, ok: true });
const fail = (code, message, details) => ({ code, details, message, ok: false });
const now = () => db.serverDate();
const isNotFound = (error) =>
  error?.errCode === -1 || String(error?.message || '').toLowerCase().includes('not exist');

const isCollectionMissing = (error) => {
  const message = String(error?.message || error || '');
  return (
    error?.errCode === -502005 ||
    message.includes('collection not exists') ||
    message.includes('Db or Table not exist') ||
    message.includes('DATABASE_COLLECTION_NOT_EXIST')
  );
};

const pairKey = (a, b) => [a, b].sort().join('_');

const getUser = async (openid) => {
  try {
    return (await db.collection('users').doc(openid).get()).data;
  } catch (error) {
    if (isNotFound(error)) throw Object.assign(new Error('请先登录'), { code: 'UNAUTHORIZED' });
    throw error;
  }
};

const publicProfile = (user) => ({
  avatarFileId: user.avatarFileId || '',
  gender: user.gender || '',
  nickname: user.nickname || '用户',
  publicUserId: user.publicUserId || '',
});

const attachAvatarUrls = async (profiles) => {
  const list = (profiles || []).map((item) => ({ ...item, avatarUrl: item.avatarUrl || '' }));
  const fileList = [
    ...new Set(list.map((item) => item.avatarFileId).filter((id) => id && id.startsWith('cloud://'))),
  ];
  if (!fileList.length) return list;
  try {
    const { fileList: result } = await cloud.getTempFileURL({ fileList });
    const map = {};
    (result || []).forEach((item) => {
      if (item.fileID && item.tempFileURL && (!item.status || item.status === 0)) {
        map[item.fileID] = item.tempFileURL;
      }
    });
    return list.map((item) => ({ ...item, avatarUrl: map[item.avatarFileId] || item.avatarUrl || '' }));
  } catch (error) {
    console.warn('attachAvatarUrls', error.message || error);
    return list;
  }
};

const loadUsersByOpenids = async (openids = [], { withAvatars = true } = {}) => {
  const unique = [...new Set(openids.filter(Boolean))];
  const users = await Promise.all(
    unique.map(async (openid) => {
      try {
        const data = (await db.collection('users').doc(openid).get()).data;
        return { openid, avatarUrl: '', ...publicProfile(data) };
      } catch (error) {
        return { openid, avatarFileId: '', avatarUrl: '', gender: '', nickname: '未知用户', publicUserId: '' };
      }
    }),
  );
  if (!withAvatars) return users;
  return attachAvatarUrls(users);
};

const findUserByPublicId = async (publicUserId) => {
  const id = String(publicUserId || '').trim().toLowerCase();
  if (!id || id.length < 6) return null;
  const result = await db.collection('users').where({ publicUserId: id }).limit(1).get();
  return result.data[0] || null;
};

const assertConversationMember = async (conversationId, openid) => {
  const conversation = (await db.collection('conversations').doc(conversationId).get()).data;
  if (!conversation.memberOpenids?.includes(openid)) {
    throw Object.assign(new Error('没有访问该会话的权限'), { code: 'FORBIDDEN' });
  }
  return conversation;
};

const ensureCoupleConversation = async (openid, user) => {
  if (!user.coupleId) return null;
  let couple;
  try {
    couple = (await db.collection('couples').doc(user.coupleId).get()).data;
  } catch (error) {
    return null;
  }
  if (couple.status !== 'active' || !couple.members?.includes(openid) || couple.members.length < 2) {
    return null;
  }

  const existing = await db
    .collection('conversations')
    .where({ coupleId: user.coupleId, type: 'couple' })
    .limit(1)
    .get();
  if (existing.data[0]) return existing.data[0];

  const partnerOpenid = couple.members.find((id) => id !== openid);
  const created = {
    coupleId: user.coupleId,
    createdAt: now(),
    createdBy: openid,
    directKey: pairKey(openid, partnerOpenid),
    lastMessageAt: now(),
    lastMessageFrom: '',
    lastMessageText: '',
    memberOpenids: couple.members.slice(0, 2),
    title: '和 TA',
    type: 'couple',
    updatedAt: now(),
  };
  const addResult = await db.collection('conversations').add({ data: created });
  return { _id: addResult._id, ...created };
};

const ensureDirectConversation = async (openid, friendOpenid) => {
  const key = pairKey(openid, friendOpenid);
  const existing = await db.collection('conversations').where({ directKey: key, type: 'direct' }).limit(1).get();
  if (existing.data[0]) return existing.data[0];
  const created = {
    coupleId: null,
    createdAt: now(),
    createdBy: openid,
    directKey: key,
    lastMessageAt: now(),
    lastMessageFrom: '',
    lastMessageText: '',
    memberOpenids: [openid, friendOpenid],
    title: '',
    type: 'direct',
    updatedAt: now(),
  };
  const addResult = await db.collection('conversations').add({ data: created });
  return { _id: addResult._id, ...created };
};

const PLACEHOLDER_PREVIEWS = new Set([
  '开始和 TA 聊天吧',
  '你们已成为好友，打个招呼吧',
]);

const sanitizePreview = (text = '') => {
  const value = String(text || '').trim();
  if (!value || PLACEHOLDER_PREVIEWS.has(value)) return '';
  return value;
};

const formatConversation = async (conversation, openid, userMap) => {
  const members = (conversation.memberOpenids || [])
    .map((id) => userMap[id] || { openid: id, nickname: '用户', avatarUrl: '' })
    .map((member) => ({
      avatarUrl: member.avatarUrl || '',
      gender: member.gender || '',
      nickname: member.nickname || '用户',
      openid: member.openid,
      publicUserId: member.publicUserId || '',
    }));
  const others = members.filter((member) => member.openid !== openid);
  let title = conversation.title || '';
  if (conversation.type === 'couple') {
    title = others[0]?.nickname ? `♡ ${others[0].nickname}` : '♡ 和 TA';
  } else if (conversation.type === 'direct') {
    title = others[0]?.nickname || '好友';
  } else if (!title) {
    title = others.map((member) => member.nickname).filter(Boolean).slice(0, 3).join('、') || '群聊';
  }
  return {
    id: conversation._id,
    isCouple: conversation.type === 'couple',
    lastMessageAt: conversation.lastMessageAt,
    lastMessageText: sanitizePreview(conversation.lastMessageText),
    memberCount: members.length,
    members,
    peer: others[0] || null,
    title,
    type: conversation.type,
    unreadCount: Math.max(0, Number(conversation.unreadBy?.[openid] || 0)),
  };
};

const listConversations = async (openid, event = {}) => {
  // 进页默认不换头像临时链，避免 getTempFileURL 拖慢首屏
  const withAvatars = event.includeAvatars === true;
  const user = await getUser(openid);

  let result = await db.collection('conversations').where({ memberOpenids: openid }).limit(50).get();
  const hasCoupleChat = (result.data || []).some((item) => item.type === 'couple');
  if (!hasCoupleChat && user.coupleId) {
    await ensureCoupleConversation(openid, user);
    result = await db.collection('conversations').where({ memberOpenids: openid }).limit(50).get();
  }

  const openids = [...new Set(result.data.flatMap((item) => item.memberOpenids || []))];
  const profiles = await loadUsersByOpenids(openids, { withAvatars });
  const userMap = Object.fromEntries(profiles.map((item) => [item.openid, item]));

  const conversations = await Promise.all(result.data.map((item) => formatConversation(item, openid, userMap)));
  conversations.sort((a, b) => {
    if (a.isCouple && !b.isCouple) return -1;
    if (!a.isCouple && b.isCouple) return 1;
    const at = new Date(a.lastMessageAt || 0).getTime();
    const bt = new Date(b.lastMessageAt || 0).getTime();
    return bt - at;
  });
  return ok({ conversations });
};

const listMessages = async (openid, event) => {
  const conversationId = String(event.conversationId || '');
  if (!conversationId) return fail('INVALID_PARAMS', '缺少会话');
  await assertConversationMember(conversationId, openid);
  const limit = Math.max(1, Math.min(50, Number(event.limit) || 30));
  const result = await db.collection('messages').where({ conversationId }).limit(100).get();
  const messages = result.data
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
    .slice(-limit)
    .map((item) => {
      const hasVoice = Boolean(item.voiceFileId) || item.type === 'voice';
      const hasImage = Boolean(item.imageFileId) || item.type === 'image';
      const msgType = hasVoice ? 'voice' : hasImage ? 'image' : 'text';
      return {
        createdAt: item.createdAt,
        fromNickname: item.fromNickname || '',
        fromOpenid: item.fromOpenid,
        id: item._id,
        imageFileId: item.imageFileId || '',
        isMine: item.fromOpenid === openid,
        msgType,
        text: item.text || '',
        type: msgType,
        voiceDuration: Number(item.voiceDuration || 0),
        voiceFileId: item.voiceFileId || '',
      };
    });

  // 打开会话即视为已读，清零未读角标
  try {
    await db.collection('conversations').doc(conversationId).update({
      data: {
        [`readAtBy.${openid}`]: now(),
        [`unreadBy.${openid}`]: 0,
        updatedAt: now(),
      },
    });
  } catch (error) {
    console.warn('mark conversation read failed', error.message || error);
  }

  return ok({ messages });
};

const sendMessage = async (openid, event) => {
  const conversationId = String(event.conversationId || '');
  if (!conversationId) return fail('INVALID_PARAMS', '缺少会话');

  const rawType = String(event.msgType || 'text');
  const msgType = rawType === 'voice' || rawType === 'image' ? rawType : 'text';
  let text = String(event.text || '').trim().slice(0, 500);
  let voiceFileId = '';
  let voiceDuration = 0;
  let imageFileId = '';

  if (msgType === 'voice') {
    voiceFileId = String(event.voiceFileId || '').trim();
    voiceDuration = Math.max(1, Math.min(60, Math.round(Number(event.voiceDuration) || 1)));
    if (!voiceFileId.startsWith('cloud://')) {
      return fail('INVALID_PARAMS', '语音文件无效');
    }
    text = text || '[语音]';
  } else if (msgType === 'image') {
    imageFileId = String(event.imageFileId || '').trim();
    if (!imageFileId.startsWith('cloud://')) {
      return fail('INVALID_PARAMS', '图片文件无效');
    }
    text = text || '[图片]';
  } else if (!text) {
    return fail('INVALID_PARAMS', '消息不能为空');
  }

  const conversation = await assertConversationMember(conversationId, openid);
  const user = await getUser(openid);
  const nickname = user.nickname || '用户';
  const message = {
    conversationId,
    createdAt: now(),
    fromNickname: nickname,
    fromOpenid: openid,
    imageFileId: msgType === 'image' ? imageFileId : '',
    text,
    type: msgType,
    voiceDuration: msgType === 'voice' ? voiceDuration : 0,
    voiceFileId: msgType === 'voice' ? voiceFileId : '',
  };
  const addResult = await db.collection('messages').add({ data: message });
  const unreadUpdates = {};
  (conversation.memberOpenids || []).forEach((memberOpenid) => {
    if (memberOpenid && memberOpenid !== openid) {
      unreadUpdates[`unreadBy.${memberOpenid}`] = _.inc(1);
    }
  });
  const preview =
    msgType === 'voice'
      ? `[语音] ${voiceDuration}"`
      : msgType === 'image'
        ? '[图片]'
        : text.slice(0, 80);
  await db.collection('conversations').doc(conversationId).update({
    data: {
      lastMessageAt: now(),
      lastMessageFrom: openid,
      lastMessageText: preview,
      updatedAt: now(),
      ...unreadUpdates,
    },
  });
  await notifyChatSignals(conversation.memberOpenids || [], conversationId, openid);
  return ok({
    message: {
      createdAt: new Date().toISOString(),
      fromNickname: nickname,
      fromOpenid: openid,
      id: addResult._id,
      imageFileId: msgType === 'image' ? imageFileId : '',
      isMine: true,
      msgType,
      text,
      type: msgType,
      voiceDuration: msgType === 'voice' ? voiceDuration : 0,
      voiceFileId: msgType === 'voice' ? voiceFileId : '',
    },
    conversationId,
    type: conversation.type,
  });
};

const notifyChatSignals = async (memberOpenids, conversationId, exceptOpenid) => {
  const targets = [...new Set((memberOpenids || []).filter((id) => id && id !== exceptOpenid))];
  await Promise.all(
    targets.map(async (memberOpenid) => {
      try {
        await db.collection('chatSignals').doc(memberOpenid).update({
          data: {
            bump: _.inc(1),
            conversationId,
            updatedAt: now(),
          },
        });
      } catch (error) {
        try {
          await db.collection('chatSignals').doc(memberOpenid).set({
            data: {
              bump: 1,
              conversationId,
              updatedAt: now(),
            },
          });
        } catch (setError) {
          console.warn('notifyChatSignals failed', memberOpenid, setError.message || setError);
        }
      }
    }),
  );
};

/** 确保当前用户有可 watch 的信标文档（不存在则创建；集合未建时软失败） */
const ensureChatSignal = async (openid) => {
  if (!openid) return ok({ created: false, skipped: true });
  try {
    await db.collection('chatSignals').doc(openid).get();
    return ok({ created: false });
  } catch (error) {
    if (isCollectionMissing(error)) {
      console.warn('chatSignals 集合不存在，跳过信标初始化');
      return ok({ created: false, missingCollection: true });
    }
    if (!isNotFound(error)) {
      console.warn('ensureChatSignal get failed', error.message || error);
      return ok({ created: false, skipped: true });
    }
    try {
      await db.collection('chatSignals').doc(openid).set({
        data: {
          bump: 0,
          conversationId: '',
          updatedAt: now(),
        },
      });
      return ok({ created: true });
    } catch (setError) {
      if (isCollectionMissing(setError)) {
        console.warn('chatSignals 集合不存在，跳过信标初始化');
        return ok({ created: false, missingCollection: true });
      }
      console.warn('ensureChatSignal set failed', setError.message || setError);
      return ok({ created: false, skipped: true });
    }
  }
};

/** 轻量未读汇总：给 Tab 角标 / 前台轮询用（不依赖 chatSignals） */
const getUnreadSummary = async (openid) => {
  // 信标可选；失败不影响未读角标
  try {
    await ensureChatSignal(openid);
  } catch (error) {
    console.warn('ensureChatSignal ignored', error.message || error);
  }
  const result = await db.collection('conversations').where({ memberOpenids: openid }).limit(50).get();
  let total = 0;
  const byId = {};
  (result.data || []).forEach((item) => {
    const count = Math.max(0, Number(item.unreadBy?.[openid] || 0));
    byId[item._id] = count;
    total += count;
  });
  return ok({ byId, total });
};

const listFriends = async (openid, event = {}) => {
  const withAvatars = event.includeAvatars !== false;
  const result = await db
    .collection('friendships')
    .where({ memberOpenids: openid, status: 'active' })
    .limit(100)
    .get();
  const friendOpenids = result.data
    .map((item) => (item.memberOpenids || []).find((id) => id !== openid))
    .filter(Boolean);
  const profiles = await loadUsersByOpenids(friendOpenids, { withAvatars });
  return ok({
    friends: profiles.map((item) => ({
      avatarUrl: item.avatarUrl || '',
      friendshipId: result.data.find((row) => row.memberOpenids?.includes(item.openid))?._id || '',
      gender: item.gender || '',
      nickname: item.nickname,
      openid: item.openid,
      publicUserId: item.publicUserId,
    })),
  });
};

const listFriendRequests = async (openid) => {
  const [incomingRaw, outgoingRaw] = await Promise.all([
    db.collection('friendRequests').where({ toOpenid: openid }).limit(50).get(),
    db.collection('friendRequests').where({ fromOpenid: openid }).limit(50).get(),
  ]);
  const incoming = incomingRaw.data
    .filter((item) => item.status === 'pending')
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const outgoing = outgoingRaw.data
    .filter((item) => item.status === 'pending')
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const openids = [
    ...new Set([
      ...incoming.map((item) => item.fromOpenid),
      ...outgoing.map((item) => item.toOpenid),
    ]),
  ];
  const profiles = await loadUsersByOpenids(openids);
  const map = Object.fromEntries(profiles.map((item) => [item.openid, item]));
  return ok({
    incoming: incoming.map((item) => ({
      createdAt: item.createdAt,
      from: map[item.fromOpenid] || { nickname: '用户', openid: item.fromOpenid },
      id: item._id,
    })),
    outgoing: outgoing.map((item) => ({
      createdAt: item.createdAt,
      id: item._id,
      to: map[item.toOpenid] || { nickname: '用户', openid: item.toOpenid },
    })),
  });
};

const sendFriendRequest = async (openid, event) => {
  const publicUserId = String(event.publicUserId || '').trim().toLowerCase();
  const target = await findUserByPublicId(publicUserId);
  if (!target) return fail('USER_NOT_FOUND', '找不到该用户，请确认对方 ID');
  if (target._id === openid) return fail('INVALID_TARGET', '不能添加自己为好友');

  const key = pairKey(openid, target._id);
  const friendship = await db.collection('friendships').where({ pairKey: key, status: 'active' }).limit(1).get();
  if (friendship.data[0]) return fail('ALREADY_FRIENDS', '你们已经是好友了');

  const pending = await db
    .collection('friendRequests')
    .where({ fromOpenid: openid, status: 'pending', toOpenid: target._id })
    .limit(1)
    .get();
  if (pending.data[0]) return fail('REQUEST_EXISTS', '已发送过好友申请');

  const reverse = await db
    .collection('friendRequests')
    .where({ fromOpenid: target._id, status: 'pending', toOpenid: openid })
    .limit(1)
    .get();
  if (reverse.data[0]) {
    // 对方已申请过，直接互通
    return acceptFriendRequest(openid, { requestId: reverse.data[0]._id });
  }

  await db.collection('friendRequests').add({
    data: {
      createdAt: now(),
      fromOpenid: openid,
      status: 'pending',
      toOpenid: target._id,
      updatedAt: now(),
    },
  });
  return ok({ sent: true });
};

const acceptFriendRequest = async (openid, event) => {
  const requestId = String(event.requestId || '');
  if (!requestId) return fail('INVALID_PARAMS', '缺少申请');
  const request = (await db.collection('friendRequests').doc(requestId).get()).data;
  if (request.toOpenid !== openid) return fail('FORBIDDEN', '只能处理发给自己的申请');
  if (request.status !== 'pending') return fail('INVALID_STATUS', '该申请已处理');

  const key = pairKey(request.fromOpenid, request.toOpenid);
  await db.collection('friendRequests').doc(requestId).update({
    data: { status: 'accepted', updatedAt: now() },
  });

  const existing = await db.collection('friendships').where({ pairKey: key }).limit(1).get();
  if (!existing.data[0]) {
    await db.collection('friendships').add({
      data: {
        createdAt: now(),
        memberOpenids: [request.fromOpenid, request.toOpenid],
        pairKey: key,
        status: 'active',
        updatedAt: now(),
      },
    });
  } else if (existing.data[0].status !== 'active') {
    await db.collection('friendships').doc(existing.data[0]._id).update({
      data: { status: 'active', updatedAt: now() },
    });
  }

  const conversation = await ensureDirectConversation(openid, request.fromOpenid);
  return ok({ conversationId: conversation._id, accepted: true });
};

const rejectFriendRequest = async (openid, event) => {
  const requestId = String(event.requestId || '');
  const request = (await db.collection('friendRequests').doc(requestId).get()).data;
  if (request.toOpenid !== openid) return fail('FORBIDDEN', '只能处理发给自己的申请');
  await db.collection('friendRequests').doc(requestId).update({
    data: { status: 'rejected', updatedAt: now() },
  });
  return ok({ rejected: true });
};

const removeFriend = async (openid, event) => {
  const friendOpenid = String(event.friendOpenid || '');
  if (!friendOpenid) return fail('INVALID_PARAMS', '缺少好友');
  const key = pairKey(openid, friendOpenid);
  const friendship = await db.collection('friendships').where({ pairKey: key, status: 'active' }).limit(1).get();
  if (!friendship.data[0]) return fail('NOT_FRIENDS', '你们还不是好友');
  await db.collection('friendships').doc(friendship.data[0]._id).update({
    data: { status: 'removed', updatedAt: now() },
  });
  return ok({ removed: true });
};

const openDirectChat = async (openid, event) => {
  const friendOpenid = String(event.friendOpenid || '');
  if (!friendOpenid) return fail('INVALID_PARAMS', '缺少好友');
  const key = pairKey(openid, friendOpenid);
  const friendship = await db.collection('friendships').where({ pairKey: key, status: 'active' }).limit(1).get();
  if (!friendship.data[0]) return fail('NOT_FRIENDS', '只能与好友发起私聊');
  const conversation = await ensureDirectConversation(openid, friendOpenid);
  return ok({ conversationId: conversation._id });
};

const createGroup = async (openid, event) => {
  const title = String(event.title || '').trim().slice(0, 20) || '群聊';
  const memberOpenids = [...new Set([openid, ...(Array.isArray(event.memberOpenids) ? event.memberOpenids : [])])]
    .filter(Boolean)
    .slice(0, 20);
  if (memberOpenids.length < 3) return fail('INVALID_PARAMS', '群聊至少需要自己和两位好友');

  const friendships = await db
    .collection('friendships')
    .where({ memberOpenids: openid, status: 'active' })
    .limit(100)
    .get();
  const friendSet = new Set(
    friendships.data.flatMap((item) => (item.memberOpenids || []).filter((id) => id !== openid)),
  );
  const invalid = memberOpenids.filter((id) => id !== openid && !friendSet.has(id));
  if (invalid.length) return fail('NOT_FRIENDS', '只能邀请好友进群');

  const created = {
    coupleId: null,
    createdAt: now(),
    createdBy: openid,
    directKey: null,
    lastMessageAt: now(),
    lastMessageFrom: openid,
    lastMessageText: '群聊已创建',
    memberOpenids,
    title,
    type: 'group',
    updatedAt: now(),
  };
  const addResult = await db.collection('conversations').add({ data: created });
  const user = await getUser(openid);
  await db.collection('messages').add({
    data: {
      conversationId: addResult._id,
      createdAt: now(),
      fromNickname: '系统',
      fromOpenid: 'system',
      text: `${user.nickname || '用户'} 创建了群聊「${title}」`,
    },
  });
  return ok({ conversationId: addResult._id });
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action === 'listConversations') return listConversations(OPENID, event);
    if (event.action === 'listMessages') return listMessages(OPENID, event);
    if (event.action === 'sendMessage') return sendMessage(OPENID, event);
    if (event.action === 'getUnreadSummary') return getUnreadSummary(OPENID);
    if (event.action === 'ensureChatSignal') return ensureChatSignal(OPENID);
    if (event.action === 'listFriends') return listFriends(OPENID, event);
    if (event.action === 'listFriendRequests') return listFriendRequests(OPENID);
    if (event.action === 'sendFriendRequest') return sendFriendRequest(OPENID, event);
    if (event.action === 'acceptFriendRequest') return acceptFriendRequest(OPENID, event);
    if (event.action === 'rejectFriendRequest') return rejectFriendRequest(OPENID, event);
    if (event.action === 'removeFriend') return removeFriend(OPENID, event);
    if (event.action === 'openDirectChat') return openDirectChat(OPENID, event);
    if (event.action === 'createGroup') return createGroup(OPENID, event);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('chatApi error', error.code || error.message);
    if (error.errCode === -502005 || String(error.message).includes('collection not exists')) {
      return fail(
        'COLLECTION_REQUIRED',
        '请先创建 conversations / messages / friendships / friendRequests / chatSignals 集合',
      );
    }
    return fail(error.code || 'SERVER_ERROR', error.message || '聊天服务暂时不可用');
  }
};
