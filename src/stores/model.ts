import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { resolveResource } from '@tauri-apps/api/path'
import { filter, find } from 'es-toolkit/compat'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import { join } from '@/utils/path'

export type ModelEngine = 'live2d' | '3d'
export type ModelMode = 'standard' | 'keyboard' | 'gamepad' | 'model3d'

export interface Model {
  id: string
  path: string
  mode: ModelMode
  engine: ModelEngine
  isPreset: boolean
}

export const useModelStore = defineStore('model', () => {
  const modelReady = ref(true)
  const models = ref<Model[]>([])
  const currentModel = ref<Model>()
  const supportKeys = reactive<Record<string, string>>({})
  const pressedKeys = reactive<Record<string, string>>({})
  const currentMotions = ref<Array<[string, MotionInfo[]]>>([])
  const currentExpressions = ref<ExpressionInfo[]>([])
  const shortcuts = reactive<Record<string, string>>({})

  const init = async () => {
    const modelsPath = await resolveResource('assets/models')

    const nextModels = filter(models.value, { isPreset: false }).map(model => ({
      ...model,
      engine: model.engine ?? 'live2d',
    }))
    const presetModels = filter(models.value, { isPreset: true })

    const modes: ModelMode[] = ['model3d', 'gamepad', 'keyboard', 'standard']

    for (const mode of modes) {
      const matched = find(presetModels, { mode })
      nextModels.unshift({
        id: matched?.id ?? nanoid(),
        mode,
        engine: mode === 'model3d' ? '3d' : 'live2d',
        isPreset: true,
        path: join(modelsPath, mode),
      })
    }

    const matched = find(nextModels, { id: currentModel.value?.id })
    currentModel.value = matched ?? nextModels[0]
    console.warn('所有模型：', models.value)

    models.value = nextModels
  }

  return {
    modelReady,
    models,
    currentModel,
    supportKeys,
    pressedKeys,
    currentMotions,
    currentExpressions,
    shortcuts,
    init,
  }
}, {
  tauri: {
    filterKeys: ['supportKeys', 'pressedKeys'],
  },
})
