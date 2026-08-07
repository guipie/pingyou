import type { AIProvider, AiProviderModels } from '@/stores/shard/provider-shard'

import { decryptString, encryptString } from '@/utils/crypto'
import { safeJsonParse } from '@/utils/safe'

import { BaseRepository } from './db'
import { DbTables } from './dbtables'

class ProviderRepository extends BaseRepository<AIProvider> {
  constructor() {
    super(DbTables.ai_chat_provider) // 指定操作的表名
  }

  // 扩展方法：保存/更新供应商（支持覆盖）
  async saveProvider(provider: AIProvider): Promise<boolean> {
    const db = await this.getDB()
    // 加密 apiKey 后再入库，防止数据库文件泄露导致密钥暴露
    const encryptedApiKey = await encryptString(provider.apiKey ?? '')
    const result = await db.execute(
      `INSERT OR REPLACE INTO ${this.tableName}
        (provider, value, avatar, desc, baseUrl, isCustom, apiKey, isNeedProxy, defaultModel, models, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [provider.provider, provider.value, provider.avatar, provider.desc, provider.baseUrl, provider.isCustom, encryptedApiKey, provider.isNeedProxy, provider.defaultModel, (provider.models ? JSON.stringify(provider.models) : ''), Date.now()],
    )
    return result.rowsAffected > 0
  }

  async getProviders(): Promise<AIProvider[]> {
    const db = await this.getDB()
    const rows = await db.select<any[]>(
      `SELECT * FROM ${this.tableName} ORDER BY timestamp DESC`,
    )
    // 逐行解密 apiKey；对旧版明文数据 decryptString 会原样返回，实现平滑迁移
    const providers = await Promise.all(rows.map(async (row) => {
      const decryptedApiKey = await decryptString(row.apiKey ?? '')
      return {
        ...row,
        apiKey: decryptedApiKey,
        // 使用 safeJsonParse 防止数据库字段损坏导致整批加载崩溃
        models: safeJsonParse<AiProviderModels[] | null>(row.models, null),
      }
    }))
    return providers as AIProvider[]
  }
}
export const providerRep = new ProviderRepository()
