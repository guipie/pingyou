import type { TauriAIConversation } from '@/stores/shard/chat-shard'

import { decryptString, encryptString } from '@/utils/crypto'
import { safeJsonParse } from '@/utils/safe'

import { BaseRepository } from './db'
import { DbTables } from './dbtables'

// 定义消息的 TypeScript 类型接口

class ConversationRepository extends BaseRepository<TauriAIConversation> {
  constructor() {
    super(DbTables.ai_chat_conversation) // 指定操作的表名
  }

  // 扩展方法：保存/更新会话（支持覆盖）
  async saveConversation(conversation: TauriAIConversation): Promise<boolean> {
    const db = await this.getDB()
    // 加密会话内嵌 provider 的 apiKey，防止数据库文件泄露
    let providerJson = ''
    if (conversation.provider) {
      const providerCopy = { ...conversation.provider }
      providerCopy.apiKey = await encryptString(providerCopy.apiKey ?? '')
      providerJson = JSON.stringify(providerCopy)
    }
    const result = await db.execute(
      `INSERT OR REPLACE INTO ${this.tableName}
      (id,avatar, title,provider,config,options, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [conversation.id, conversation.avatar, conversation.title, providerJson, (conversation.config ? JSON.stringify(conversation.config) : ''), (conversation.options ? JSON.stringify(conversation.options) : ''), conversation.timestamp || Date.now()],
    )
    return result.rowsAffected > 0
  }

  // 获取会话列表
  async getConversations(): Promise<TauriAIConversation[]> {
    const db = await this.getDB()
    // 注意：这里先断言为 any[] 或者包含 string 类型的中间类型，因为数据库返回的是原始行
    const rows = await db.select<any[]>(
      `SELECT * FROM ${this.tableName} ORDER BY timestamp DESC`,
    )
    return await Promise.all(rows.map(async row => ({
      ...row,
      provider: await this.decryptProviderApiKey(safeJsonParse(row.provider, null)),
      config: safeJsonParse(row.config, null),
      options: safeJsonParse(row.options, null),
    }))) as TauriAIConversation[]
  }

  // 扩展方法：按标题搜索会话
  async searchConversations(
    keywords: string,
    limit: number = 20,
    beforeTimestamp: number = Date.now(),
  ): Promise<TauriAIConversation[]> {
    const db = await this.getDB()
    // 查询早于某个时间点、标题包含关键词的 X 条会话，按时间倒序
    const rows = await db.select<any[]>(
      `SELECT * FROM ${this.tableName}
       WHERE title LIKE $1 AND timestamp < $2
       ORDER BY timestamp DESC
       LIMIT $3`,
      [`%${keywords}%`, beforeTimestamp, limit],
    )
    return await Promise.all(rows.map(async row => ({
      ...row,
      provider: await this.decryptProviderApiKey(safeJsonParse(row.provider, null)),
      config: safeJsonParse(row.config, null),
      options: safeJsonParse(row.options, null),
    }))) as TauriAIConversation[]
  }

  // 解密 provider 中的 apiKey；对旧版明文数据原样返回，实现平滑迁移
  private async decryptProviderApiKey(provider: any): Promise<any> {
    if (!provider || typeof provider !== 'object') return provider
    if (provider.apiKey) {
      provider.apiKey = await decryptString(provider.apiKey)
    }
    return provider
  }
}

// 导出单例业务仓库
export const ConversationRepo = new ConversationRepository()
