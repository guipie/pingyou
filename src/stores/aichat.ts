import { defineStore } from "pinia";
import { ref } from "vue";

import { ChatMsgRepo } from "@/database/chat-msg-repository";
import { ConversationRepo } from "@/database/conversation-repository";
import { DbTables } from "@/database/dbtables";

import type { TauriAIChatMessage, TauriAIConversation } from "./shard/chat-shard";
import type { AIProvider } from "./shard/provider-shard";

import { addConversationDb, initConversations } from "./shard/chat-shard";

export const useChatStore = defineStore("chat", () => {
  const conversations = ref<TauriAIConversation[]>([]);
  const currentConversation = ref<TauriAIConversation | null>(null);
  // 防止 initStore 被并发调用导致数据重复/丢失
  let initPromise: Promise<void> | null = null;

  const initStore = async () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const data = await initConversations();
        conversations.value = data.sort((a, b) => b.timestamp - a.timestamp);
      } catch (error) {
        console.error("Failed to initialize conversations:", error);
        conversations.value = [];
      }
    })();
    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  };

  const updateConversation = (conver: TauriAIConversation) => {
    const converIndex = conversations.value.findIndex(item => item.id === conver.id);
    if (converIndex >= 0) {
      conversations.value[converIndex] = conver;
      ConversationRepo.saveConversation(conver);
    }
    // 仅当操作的是当前会话时才同步 currentConversation，避免置顶/改 provider 时切走当前会话
    if (currentConversation.value?.id === conver.id) {
      currentConversation.value = conver;
    }
  };
  const addConversation = async (id?: string) => {
    // 已存在相同 id 的会话则直接复用，避免重复创建/覆盖
    const exist = id ? conversations.value.find(item => item.id === id) : undefined;
    if (exist) return exist;
    const con = await addConversationDb(undefined, id);
    conversations.value.push(con);
    return con;
  };
  const delConversation = async (id: string) => {
    // 使用事务保证会话与消息删除的原子性，避免产生孤儿记录
    try {
      await ConversationRepo.runInTransaction([
        async (db) => {
          await db.execute(`DELETE FROM ${DbTables.ai_chat_conversation} WHERE id = $1`, [id]);
        },
        async (db) => {
          await db.execute(`DELETE FROM ${DbTables.ai_chat_message} WHERE conversation_id = $1`, [id]);
        },
      ]);
      conversations.value = conversations.value.filter(conver => conver.id !== id);
      if (currentConversation.value?.id === id)
        currentConversation.value = null;
    } catch (err) {
      console.error("删除会话失败:", err);
    }
  };
  // 设置当前会话
  const setCurrentConversation = (conversation: string | TauriAIConversation) => {
    const target = typeof conversation === "string"
      ? conversations.value.find(conver => conver.id === conversation)
      : conversation;
    if (!target) return;
    currentConversation.value = target;
    if (!target.messages || target.messages.length === 0) {
      ChatMsgRepo.getHistoryByConversationId(target.id).then((res) => {
        target.messages = res.reverse();
      });
    }
  };
  // 置顶
  const pinConversation = (id: string) => {
    const converIndex = conversations.value.findIndex(item => item.id === id);
    if (converIndex >= 0) {
      const conver = conversations.value[converIndex];
      conver.options = conver.options || {};
      conver.options.isPinned = !conver.options.isPinned;
      conversations.value[converIndex] = conver;
      updateConversation(conver);
    }
  };
  // 设置会话provider
  const setConversationProvider = (provider: AIProvider, conversationId?: string) => {
    const converIndex = conversations.value.findIndex(item => item.id === conversationId);
    if (converIndex >= 0) {
      const conver = conversations.value[converIndex];
      conver.provider = provider;
      conversations.value[converIndex] = conver;
      updateConversation(conver);
    } else {
      for (const conver of conversations.value) {
        if (conver.provider.provider === provider.provider) {
          conver.provider = provider;
          updateConversation(conver);
          break;
        }
      }
    }
  };
  const addChatMsg = (conversationId: string, msg: TauriAIChatMessage, persist: boolean = true) => {
    // 定位目标会话：优先按 conversationId，否则回退到当前会话
    const target = conversations.value.find(conver => conver.id === conversationId) ?? currentConversation.value;
    if (!target) return;
    if (!target.messages) {
      target.messages = [];
    }
    const existIndex = target.messages.findIndex(item => item.id === msg.id);
    if (existIndex >= 0) {
      target.messages[existIndex] = { ...target.messages[existIndex], ...msg };
    } else {
      target.messages.push(msg);
    }
    // persist=false 用于流式中间态，避免逐 chunk 高频写库
    if (persist) ChatMsgRepo.saveMessage(conversationId, msg);
  };
  const clearChatMsg = (conversationId?: string) => {
    if (!conversationId) return;
    const conversation = conversations.value.find(conver => conver.id === conversationId);
    if (conversation) {
      conversation.messages = [];
      ConversationRepo.saveConversation(conversation);
    }
    ChatMsgRepo.deleteMessage(conversationId);
  };
  return { currentConversation, conversations, initStore, delConversation, addConversation, addChatMsg, updateConversation, clearChatMessages: clearChatMsg, pinConversation, setCurrentConversation, setConversationProvider };
});
