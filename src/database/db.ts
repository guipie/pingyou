import Database from '@tauri-apps/plugin-sql'

import { DbTables } from './dbtables'

/**
 * 1. 数据库管理单例类
 */
export class DBManager {
  private static instance: DBManager | null = null
  private db: Database | null = null
  // 缓存初始化 Promise，避免多个 store 并发调用 getDB 时重复加载/建表
  private initPromise: Promise<Database> | null = null
  private dbName: string = 'sqlite:pingyou.db'

  private constructor() {}

  // 获取单例实例
  public static getInstance(): DBManager {
    if (!DBManager.instance) {
      DBManager.instance = new DBManager()
    }
    return DBManager.instance
  }

  // 初始化数据库连接（并发安全：复用同一个 Promise）
  public async init(): Promise<Database> {
    if (this.db) return this.db
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      try {
        // 自动在用户的 AppData 目录或指定目录创建/加载数据库
        const db = await Database.load(this.dbName)
        this.db = db
        // 在这里可以执行初始化建表逻辑
        await this.initTables()
        return db
      } catch (error) {
        console.error('数据库初始化失败:', error)
        // 失败后重置，允许后续重试
        this.initPromise = null
        throw error
      }
    })()
    return this.initPromise
  }

  // 获取原始数据库连接（供特殊场景使用）
  public async getDB(): Promise<Database> {
    if (!this.db) {
      return await this.init()
    }
    return this.db
  }

  // 内部初始化表结构
  private async initTables() {
    if (!this.db) return
    // 初始化供应商
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${DbTables.ai_chat_provider} (
        provider TEXT PRIMARY KEY,
        value TEXT,
        avatar TEXT,
        desc TEXT,
        baseUrl TEXT,
        isCustom boolean,
        apiKey TEXT,
        isNeedProxy boolean,
        defaultModel TEXT,
        models TEXT,
        timestamp INTEGER
      ) 
    `)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${DbTables.ai_chat_conversation} (
        id TEXT PRIMARY KEY, 
        avatar TEXT,
        title TEXT,
        provider TEXT,
        config TEXT,
        options TEXT,
        timestamp INTEGER
      ) 
    `)
    // 初始化聊天记录表
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${DbTables.ai_chat_message} (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        role TEXT,
        question TEXT,
        answer TEXT,
        error TEXT,
        file TEXT,
        options TEXT,
        timestamp INTEGER,
        timestamp_answer INTEGER
      ) 
    `)
  }
}

/**
 * 2. 通用 CRUD 基类（方便扩展）
 */
export class BaseRepository<T> {
  protected tableName: string

  constructor(tableName: string) {
    this.tableName = tableName
  }

  protected async getDB() {
    return await DBManager.getInstance().getDB()
  }

  // 根据主键查询
  async findById(id: string | number): Promise<T | null> {
    const db = await this.getDB()
    const result = await db.select<T[]>(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id],
    )
    return result.length > 0 ? result[0] : null
  }

  async findByKey(key: string, val: string | number): Promise<T | null> {
    // 白名单校验列名，防止通过 key 拼接制造 SQL 注入
    if (!/^[a-z_]\w*$/i.test(key)) {
      throw new Error(`Invalid column name: ${key}`)
    }
    const db = await this.getDB()
    const result = await db.select<T[]>(
      `SELECT * FROM ${this.tableName} WHERE ${key} = $1`,
      [val],
    )
    return result.length > 0 ? result[0] : null
  }

  // 基础删除
  async deleteById(id: string | number): Promise<boolean> {
    const db = await this.getDB()
    const result = await db.execute(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id],
    )
    return result.rowsAffected > 0
  }

  async deleteByKey(key: string, val: string | number): Promise<boolean> {
    // 白名单校验列名，防止通过 key 拼接制造 SQL 注入（与 findByKey 保持一致）
    if (!/^[a-z_]\w*$/i.test(key)) {
      throw new Error(`Invalid column name: ${key}`)
    }
    const db = await this.getDB()
    const result = await db.execute(
      `DELETE FROM ${this.tableName} WHERE ${key} = $1`,
      [val],
    )
    return result.rowsAffected > 0
  }

  // 基础查询全部
  async findAll(): Promise<T[]> {
    const db = await this.getDB()
    return await db.select<T[]>(`SELECT * FROM ${this.tableName}`)
  }

  // 在事务中执行多个写操作，保证原子性；任一步失败则回滚
  async runInTransaction(actions: Array<(db: Database) => Promise<unknown>>): Promise<void> {
    const db = await this.getDB()
    await db.execute('BEGIN TRANSACTION')
    try {
      for (const action of actions) {
        await action(db)
      }
      await db.execute('COMMIT')
    } catch (err) {
      try {
        await db.execute('ROLLBACK')
      } catch (rollbackErr) {
        console.error('[runInTransaction] 回滚失败:', rollbackErr)
      }
      throw err
    }
  }
}
