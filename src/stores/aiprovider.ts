import { defineStore } from 'pinia'
import { ref } from 'vue'

import { DataProviders } from '@/assets/data/provider'
import { providerRep } from '@/database/provider-repository'

import type { AIProvider, AiProviderModels } from './shard/provider-shard'

export const useProviderStore = defineStore('provider', () => {
  const stateProviders = ref<AIProvider[]>(DataProviders)
  const initDbProviders = () => {
    stateProviders.value = DataProviders
    providerRep.getProviders().then((providers) => {
      for (let index = 0; index < providers.length; index++) {
        const p = providers[index]
        const existIndex = stateProviders.value.findIndex(x => x.provider === p.provider)
        if (existIndex >= 0) {
          stateProviders.value.splice(existIndex, 1, p)
        } else {
          stateProviders.value.push(p)
        }
      }
    })
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
