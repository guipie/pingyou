import { defineStore } from 'pinia'
import { ref } from 'vue'

import { DefaultProviders } from '@/constants/provider'
import { providerRep } from '@/database/provider-repository'

import type { AIProvider, AiProviderModels } from './shard/provider-shard'

export const useProviderStore = defineStore('provider', () => {
  const stateProviders = ref<AIProvider[]>([])
  // 首次启动时数据库为空，将内置默认供应商写入数据库；
  // 已有用户数据库中可能缺少部分内置供应商（旧版本仅在内存中合并默认值），此处补齐缺失项实现平滑迁移。
  // 运行时数据源统一为数据库，不再每次重置为静态默认值，避免用户删除的内置供应商被复活。
  const initDbProviders = async () => {
    try {
      const dbProviders = await providerRep.getProviders()
      const existNames = new Set(dbProviders.map(p => p.provider))
      let seeded = false
      for (const def of DefaultProviders) {
        if (!existNames.has(def.provider)) {
          await providerRep.saveProvider(def)
          seeded = true
        }
      }
      stateProviders.value = seeded ? await providerRep.getProviders() : dbProviders
    } catch (err) {
      console.error('初始化供应商数据失败:', err)
      // 数据库读取失败时回退到内置默认值，保证 UI 可用
      stateProviders.value = [...DefaultProviders]
    }
  }

  const updateProvider = (provider: AIProvider) => {
    const existProviderIndex = stateProviders.value.findIndex(p => p.provider === provider.provider)
    if (existProviderIndex >= 0) {
      stateProviders.value.splice(existProviderIndex, 1, provider)
    } else {
      stateProviders.value.push(provider)
    }
    providerRep.saveProvider(provider)
  }
  const updateProviderModels = (providerStr: string, model: AiProviderModels) => {
    const existProviderIndex = stateProviders.value.findIndex(p => p.provider === providerStr)
    if (existProviderIndex >= 0) {
      const editProvider = stateProviders.value[existProviderIndex]
      editProvider.models = editProvider.models || []
      editProvider.models.push(model)
      updateProvider(editProvider)
    }
  }
  // // 设置token
  // const setProviderToken = (provider: string, token: string) => {
  //   const providerIndex = providerState.value.aiProviders.findIndex(p => p.provider === provider)
  //   if (providerIndex === -1) return
  //   providerState.value.aiProviders[providerIndex].apiKey = token
  //   if (provider === providerState.value.curProvider.provider)
  //     providerState.value.curProvider.apiKey = token
  //   providerRep.saveProvider(providerState.value.aiProviders[providerIndex])
  // }

  const addProvider = (provider: AIProvider) => {
    // 统一以 provider 字段匹配（与数据库主键一致），避免与 updateProvider 匹配键不一致导致重复/误覆盖
    const existIndex = stateProviders.value.findIndex(p => p.provider === provider.provider)
    if (existIndex >= 0) {
      stateProviders.value[existIndex] = provider
    } else {
      stateProviders.value.push(provider)
    }
    providerRep.saveProvider(provider)
  }

  const removeProvider = (provider: string) => {
    const existIndex = stateProviders.value.findIndex(p => p.provider === provider)
    if (existIndex >= 0) {
      stateProviders.value.splice(existIndex, 1)
      providerRep.deleteByKey('provider', provider)
    }
  }

  return {
    stateProviders,
    initDbProviders,
    updateProvider,
    updateProviderModels,
    addProvider,
    removeProvider,
  }
})
