import type { TauriAIChatMessage } from '@/stores/shard/chat-shard'

import { safeJsonParse } from '@/utils/safe'

import { BaseRepository } from './db'
import { DbTables } from './dbtables'

// 定义消息的 TypeScript 类型接口

class ChatMsgRepository extends BaseRepository<TauriAIChatMessage> {
  constructor() {
    super(DbTables.ai_chat_message) // 指定操作的表名
  }

  // 扩展方法：保存/更新消息（支持覆盖）
  async saveMessage(conversationId: string, msg: TauriAIChatMessage): Promise<boolean> {
    const db = await this.getDB()
    const result = await db.execute(
      `INSERT OR REPLACE INTO ${this.tableName}
      (id, conversation_id, role, question, answer, error, file, options, timestamp, timestamp_answer)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msg.id, conversationId, msg.role, msg.question, msg.answer, (msg.error ? String(msg.error) : ''), (msg.file ? JSON.stringify(msg.file) : ''), (msg.options ? JSON.stringify(msg.options) : ''), msg.timestamp, msg.timestampAnswer],
    )
    return result.rowsAffected > 0
  }

  async deleteMessage(conversationId: string): Promise<boolean> {
    const db = await this.getDB()
    const result = await db.execute(`DELETE FROM ${this.tableName} WHERE conversation_id = $1`, [conversationId])
    return result.rowsAffected > 0
  }

  // 扩展方法：获取某个会话的分页历史记录（最常用）
  async getHistoryByConversationId(
    conversationId: string,
    limit: number = 20,
    beforeTimestamp: number = Date.now(),
  ): Promise<TauriAIChatMessage[]> {
    const db = await this.getDB()
    const rows = await db.select<any[]>(
      `SELECT * FROM ${this.tableName}
       WHERE conversation_id = $1 AND timestamp < $2
       ORDER BY timestamp  DESC
       LIMIT $3`,
      [conversationId, beforeTimestamp, limit],
    )
    // file/options 是 JSON 字符串，需安全解析
    return rows.map(row => ({
      ...row,
      file: safeJsonParse(row.file, undefined),
      options: safeJsonParse(row.options, undefined),
    })) as TauriAIChatMessage[]
  }

  // 扩展方法：搜索聊天记录（按提问/回答内容）
  async searchMessages(keyword: string): Promise<TauriAIChatMessage[]> {
    const db = await this.getDB()
    const rows = await db.select<any[]>(
      `SELECT * FROM ${this.tableName} WHERE question LIKE $1 OR answer LIKE $1 ORDER BY timestamp DESC`,
      [`%${keyword}%`],
    )
    return rows.map(row => ({
      ...row,
      file: safeJsonParse(row.file, undefined),
      options: safeJsonParse(row.options, undefined),
    })) as TauriAIChatMessage[]
  }
}

// 导出单例业务仓库
export const ChatMsgRepo = new ChatMsgRepository()
