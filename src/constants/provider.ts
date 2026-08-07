import type { AIProvider } from '@/stores/shard/provider-shard'

/**
 * 内置默认供应商列表（仅作为首次启动时写入数据库的种子数据）。
 * 运行时的供应商数据统一从数据库读取，不再依赖此静态常量。
 *
 * 注意：此文件是代码常量，不是数据文件；数据存储统一落在 SQLite。
 */
export const DefaultProviders: AIProvider[] = [
  {
    provider: '深度求索',
    value: 'deepseek',
    avatar: '@/assets/images/deepseek.png',
    desc: 'deepseek是专注于大语言模型研发的AI企业，致力于提升模型在垂直领域的性能与应用',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    isCustom: false,
    isNeedProxy: false,
    defaultModel: 'deepseek-v4-flash',
    models: [
      {
        name: 'DeepSeek-V4-Flash',
        desc: 'DeepSeek-V4-Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        name: 'DeepSeek-V4-PRO',
        desc: '',
        modelId: 'deepseek-v4-pro',
      },
    ],
  },
  {
    provider: '字节跳动',
    value: '豆包',
    avatar: '@/assets/images/doubao.png',
    desc: '字节跳动是国际科技企业，涉足短视频平台与AI技术开发',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    isCustom: false,
    isNeedProxy: false,
    defaultModel: 'doubao-pro-32k',
    models: [
      { name: 'Doubao-pro-32k', desc: '', modelId: 'doubao-pro-32k' },
      { name: 'Doubao-pro-128k', desc: '', modelId: 'doubao-pro-128k' },
      { name: 'Doubao-lite-32k', desc: '', modelId: 'doubao-lite-32k' },
    ],
  },
  {
    provider: '阿里巴巴',
    value: '千问',
    avatar: '@/assets/images/qwen.png',
    desc: '阿里巴巴是中国知名电商与科技集团，在人工智能、云计算等领域提供广泛服务',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    isCustom: false,
    isNeedProxy: false,
    defaultModel: 'qwen-plus',
    models: [
      { name: 'Qwen-Plus', desc: '', modelId: 'qwen-plus' },
      { name: 'Qwen-Turbo', desc: '', modelId: 'qwen-turbo' },
      { name: 'Qwen-Max', desc: '', modelId: 'qwen-max' },
    ],
  },
  {
    provider: 'google',
    value: 'gemin',
    avatar: '@/assets/images/google.png',
    desc: 'google是全球知名科技公司，在搜索引擎和人工智能领域积累深厚，开发多种先进AI模型',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    isCustom: false,
    isNeedProxy: true,
    defaultModel: 'gemini-1.5-flash',
    models: [
      { name: 'Gemini-1.5-Flash', desc: '', modelId: 'gemini-1.5-flash' },
      { name: 'Gemini-1.5-Pro', desc: '', modelId: 'gemini-1.5-pro' },
    ],
  },
  {
    provider: 'openai',
    value: 'chatgpt',
    avatar: 'i-arcticons:openai-chatgpt',
    desc: 'openai是全球瞩目的AI公司，开发了ChatGPT等先进大语言模型',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    isCustom: false,
    isNeedProxy: true,
    defaultModel: 'gpt-4o-mini',
    models: [
      { name: 'GPT-4o-mini', desc: '', modelId: 'gpt-4o-mini' },
      { name: 'GPT-4o', desc: '', modelId: 'gpt-4o' },
    ],
  },
  {
    provider: 'anthropic',
    value: 'claude',
    avatar: '@/assets/images/claude.png',
    desc: 'anthropic是重视AI安全性与伦理的公司，开发了Claude等先进大语言模型',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    isCustom: false,
    isNeedProxy: true,
    defaultModel: 'claude-3-5-sonnet-20241022',
    models: [
      { name: 'Claude-3.5-Sonnet', desc: '', modelId: 'claude-3-5-sonnet-20241022' },
      { name: 'Claude-3.5-Haiku', desc: '', modelId: 'claude-3-5-haiku-20241022' },
    ],
  },
  {
    provider: '智谱ai',
    value: '智谱',
    avatar: '@/assets/images/chatglm.png',
    desc: '智谱AI是中国AI企业，专注于大语言模型与知识图谱融合技术研发',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    isCustom: false,
    isNeedProxy: false,
    defaultModel: 'glm-4-flash',
    models: [
      { name: 'GLM-4-Flash', desc: '', modelId: 'glm-4-flash' },
      { name: 'GLM-4', desc: '', modelId: 'glm-4' },
      { name: 'GLM-4-Air', desc: '', modelId: 'glm-4-air' },
    ],
  },
  {
    provider: '月之暗面',
    value: 'moonshot',
    avatar: '@/assets/images/moonshot.png',
    desc: '月之暗面是中国AI初创公司，主要从事高性能大语言模型的开发与应用',
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    isCustom: false,
    isNeedProxy: false,
    defaultModel: 'moonshot-v1-8k',
    models: [
      { name: 'Moonshot-v1-8k', desc: '', modelId: 'moonshot-v1-8k' },
      { name: 'Moonshot-v1-32k', desc: '', modelId: 'moonshot-v1-32k' },
      { name: 'Moonshot-v1-128k', desc: '', modelId: 'moonshot-v1-128k' },
    ],
  },
  {
    provider: 'Minimax',
    value: 'minimax',
    avatar: '@/assets/images/minimax.png',
    desc: 'minimax是专注于AI技术研发的企业，推动大语言模型与对话式AI的应用',
    baseUrl: 'https://api.minimax.chat/v1/v1/chat/completions',
    isCustom: false,
    isNeedProxy: false,
    defaultModel: 'abab6.5-chat',
    models: [
      { name: 'abab6.5-chat', desc: '', modelId: 'abab6.5-chat' },
      { name: 'abab6.5s-chat', desc: '', modelId: 'abab6.5s-chat' },
    ],
  },
]
