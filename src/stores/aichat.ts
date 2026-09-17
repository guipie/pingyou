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
  /**
   * 悬浮输入窗（winchat）当前对话的会话 id。
   * 从屏友卡片的聊天按钮进入时会被设为该屏友的模型 id，因此每只屏友拥有独立会话；
   * 为空时回退到「当前台上屏友」，保持旧的快捷键行为不变。
   */
  const activeChatId = ref("");
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
  /**
   * 按 id 取会话：内存里没有就回数据库捞一次。
   *
   * conversations 已不再参与跨窗口同步（见文件末尾 store 选项），
   * 所以别的窗口（winchat / winmsg）很可能没加载过某个会话。
   * 这种情况必须从库里补齐，**绝不能走 addConversation** —— 那会走
   * `INSERT OR REPLACE`，用默认标题/默认模型把已有会话原地覆盖掉。
   */
  const loadConversation = async (id: string) => {
    const exist = conversations.value.find(item => item.id === id);
    if (exist) return exist;
    const fromDb = await ConversationRepo.getConversationById(id);
    if (fromDb) {
      conversations.value.push(fromDb);
      return fromDb;
    }
    return undefined;
  };
  /**
   * 确保某只屏友（以模型 id 为会话 id）拥有自己的会话。
   * 已存在则顺带刷新头像（换了立绘时同步），否则新建并写入屏友头像。
   */
  const ensureModelConversation = async (modelId: string, avatar?: string) => {
    const exist = await loadConversation(modelId);
    if (exist) {
      if (avatar && exist.avatar !== avatar) {
        exist.avatar = avatar;
        updateConversation(exist);
      }
      return exist;
    }
    const con = await addConversation(modelId);
    if (con && avatar) {
      con.avatar = avatar;
      updateConversation(con);
    }
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
  return { activeChatId, currentConversation, conversations, initStore, delConversation, addConversation, ensureModelConversation, loadConversation, addChatMsg, updateConversation, clearChatMessages: clearChatMsg, pinConversation, setCurrentConversation, setConversationProvider };
}, {
  /**
   * conversations 是「数据库承载」的数据集，不能参与 tauri-store 的跨窗口状态同步。
   *
   * @tauri-store/pinia 默认 sync=true，会把整个 $state 做「最后写入者获胜」的同步；
   * 更糟的是 BaseStore.processChangeQueue 在 patchSelf 前会 unwatch、之后才 watch，
   * 所以一旦被别的窗口用旧列表覆盖，本地不会再把正确状态顶回去 —— 回滚会「粘住」。
   * 表现就是：右键删除会话后左栏还留着，刷新（重新读库）才消失。
   *
   * 把 conversations 排除掉后：每个窗口各自从数据库加载列表，删除即时生效；
   * 而 activeChatId / currentConversation 仍然同步，悬浮输入窗照旧知道在跟谁说话。
   */
  tauri: {
    filterKeys: ["conversations"],
    filterKeysStrategy: "omit",
  },
});
