import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { resolveResource } from '@tauri-apps/api/path'
import { filter, find } from 'es-toolkit/compat'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import Model3d from '@/utils/model3d'
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
  const model3d = new Model3d()
  const init = async () => {
    const modelsPath = await resolveResource('assets/models')

    const nextModels = filter(models.value, { isPreset: false }).map(model => ({
      ...model,
      engine: model.engine ?? 'live2d',
    }))
    const presetModels = filter(models.value, { isPreset: true })

    const modesLive2d: ModelMode[] = ['gamepad', 'keyboard', 'standard']

    for (const mode of modesLive2d) {
      const matched = find(presetModels, { mode })
      nextModels.unshift({
        id: matched?.id ?? nanoid(),
        mode,
        engine: 'live2d',
        isPreset: true,
        path: join(modelsPath, mode),
      })
    }
    // 加载model 3 d下所有glb文件
    const configs = await model3d.loadConfigs()
    for (const c of configs) {
      if (c.file && /\.(?:glb|gltf|vrm|fbx)$/i.test(c.file)) {
        nextModels.unshift({
          id: c.file,
          mode: 'model3d',
          engine: '3d',
          isPreset: true,
          path: join(modelsPath, 'model3d', c.file!),
        })
      }
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
