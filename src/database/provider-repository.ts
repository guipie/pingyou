import type { AIProvider } from '@/stores/shard/provider-shard'

import { BaseRepository } from './db'
import { DbTables } from './dbtables'

class ProviderRepository extends BaseRepository<AIProvider> {
  constructor() {
    super(DbTables.ai_chat_provider) // 指定操作的表名
  }

  // 扩展方法：保存/更新消息（支持覆盖）
  async saveProvider(conversation: AIProvider): Promise<boolean> {
    const db = await this.getDB()
    const result = await db.execute(
      `INSERT OR REPLACE INTO ${this.tableName} 
        (provider, value, avatar, desc, baseUrl, isCustom, apiKey, isNeedProxy, defaultModel, models, timestamp) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [conversation.provider, conversation.value, conversation.avatar, conversation.desc, conversation.baseUrl, conversation.isCustom, conversation.apiKey, conversation.isNeedProxy, conversation.defaultModel, (conversation.models ? JSON.stringify(conversation.models) : ''), Date.now()],
    )
    return result.rowsAffected > 0
  }

  async getProviders(): Promise<AIProvider[]> {
    const db = await this.getDB()
    // 注意：这里先断言为 any[] 或者包含 string 类型的中间类型，因为数据库返回的是原始行
    const rows = await db.select<any[]>(
      `SELECT * FROM ${this.tableName} ORDER BY timestamp DESC`,
    )
    return rows.map(row => ({
      ...row,
      // 将 JSON 字符串映射回对象
      models: row.models ? JSON.parse(row.models) : null,
    })) as AIProvider[]
  }
}
export const providerRep = new ProviderRepository()
