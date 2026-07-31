const { callCloud } = require('./cloud');

const listConversations = (options = {}) => callCloud('chatApi', 'listConversations', options);
const getUnreadSummary = () => callCloud('chatApi', 'getUnreadSummary');
const ensureChatSignal = () => callCloud('chatApi', 'ensureChatSignal');
const listMessages = (conversationId, limit = 30) =>
  callCloud('chatApi', 'listMessages', { conversationId, limit });
const sendMessage = (conversationId, text, extra = {}) =>
  callCloud('chatApi', 'sendMessage', { conversationId, text, ...extra });
const sendVoiceMessage = (conversationId, { voiceFileId, voiceDuration }) =>
  callCloud('chatApi', 'sendMessage', {
    conversationId,
    msgType: 'voice',
    text: '[语音]',
    voiceDuration,
    voiceFileId,
  });
const sendImageMessage = (conversationId, { imageFileId }) =>
  callCloud('chatApi', 'sendMessage', {
    conversationId,
    imageFileId,
    msgType: 'image',
    text: '[图片]',
  });
const listFriends = (options = {}) => callCloud('chatApi', 'listFriends', options);
const listFriendRequests = () => callCloud('chatApi', 'listFriendRequests');
const sendFriendRequest = (publicUserId) => callCloud('chatApi', 'sendFriendRequest', { publicUserId });
const acceptFriendRequest = (requestId) => callCloud('chatApi', 'acceptFriendRequest', { requestId });
const rejectFriendRequest = (requestId) => callCloud('chatApi', 'rejectFriendRequest', { requestId });
const removeFriend = (friendOpenid) => callCloud('chatApi', 'removeFriend', { friendOpenid });
const openDirectChat = (friendOpenid) => callCloud('chatApi', 'openDirectChat', { friendOpenid });
const createGroup = (title, memberOpenids) =>
  callCloud('chatApi', 'createGroup', { memberOpenids, title });

module.exports = {
  acceptFriendRequest,
  createGroup,
  ensureChatSignal,
  getUnreadSummary,
  listConversations,
  listFriendRequests,
  listFriends,
  listMessages,
  openDirectChat,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  sendImageMessage,
  sendMessage,
  sendVoiceMessage,
};
