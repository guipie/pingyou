<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { remove } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'
import { Card, Masonry, message, Popconfirm } from 'antdv-next'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model, ModelEngine } from '@/stores/model'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { join } from '@/utils/path'

import BehaviorModal from './components/behavior-modal/index.vue'
import FloatMenu from './components/float-menu/index.vue'
import Preview3d from './components/preview-3d/index.vue'
// import Upload from './components/upload/index.vue'

const catStore = useCatStore()
const modelStore = useModelStore()
const { t } = useI18n()
const openBehaviorModal = ref(false)
const curType = ref<ModelEngine | 'all'>('all')
// const live2dModels = computed(() => modelStore.models.filter(item => item.engine === 'live2d'))
// const model3dModels = computed(() => modelStore.models.filter(item => item.engine === '3d'))

function getMasonryItems(models: Model[]) {
  // 按模型 id 字典序排序（注释修正：原注释"随机排序"有误）
  // 创建副本再排序，避免原地修改 store 中的 models 数组导致数据污染
  return [...models].sort((a, b) => a.id.localeCompare(b.id)).map(item => ({
    key: item.id,
    data: item,
  }))
}
function handleToggle(nextModel: Model) {
  if (modelStore.currentModel?.id === nextModel.id) return

  modelStore.modelReady = false
  modelStore.currentModel = nextModel
}

async function handleDelete(item: Model) {
  const { id, path } = item

  try {
    await remove(path, { recursive: true })

    message.success(t('pages.preference.model.hints.deleteSuccess'))
  } catch (error) {
    message.error(String(error))
  } finally {
    modelStore.models = modelStore.models.filter(item => item.id !== id)

    // 删除后若当前模型被清空，回退到列表首项；列表为空时置为 undefined，避免访问 undefined 的属性
    if (id === modelStore.currentModel?.id) {
      modelStore.currentModel = modelStore.models[0]
    }
  }
}

async function handleOpenFolder(path: string) {
  try {
    await openPath(path)
  } catch (error) {
    message.error(String(error))
  }
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <section class="flex flex-col gap-4">
      <div class="flex gap-4">
        <div class="flex items-center gap-2 text-base font-medium">
          <span>{{ t('pages.preference.model.title') }}</span>
          <span class="color-gray-5 text-sm">{{ t('pages.preference.model.labels.tips') }}</span>
        </div>
        <div class="flex-1" />
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
          :class="{ 'text-info': curType === 'live2d' }"
          @click="curType = 'live2d'"
        >
          <i class="i-lucide:layers-2" />
          <span>live2D</span>
        </div>
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
          :class="{ 'text-info': curType === '3d' }"
          @click="curType = '3d'"
        >
          <i class="i-lucide:box" />
          <span>3D</span>
        </div>
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"

          @click="curType = 'all'"
        >
          <i class="i-lucide:refresh-ccw" />
        </div>
      </div>
      <Masonry
        :columns="{ xs: 3, lg: 4, xxl: 6 }"
        :gutter="16"
        :items="getMasonryItems(modelStore.models)"
      >
        <template #itemRender="{ data }">
          <Card
            v-if="data.engine === 'live2d'"
            v-show="(curType === 'all' || curType === 'live2d')"
            :classes="{
              actions: `[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)`,
            }"
            hoverable
            size="small"
            @click="handleToggle(data)"
          >
            <template #cover>
              <img
                alt="Live2D"
                class="h-38 w-full object-cover p-3"
                :src="convertFileSrc(join(data.path, 'resources', 'cover.png'))"
              >
            </template>

            <template #actions>
              <i
                class="i-lucide:circle-check"
                :class="{ 'text-success': data.id === modelStore.currentModel?.id }"
              />

              <i
                v-if="catStore.model.behavior && modelStore.currentModel?.id === data.id"
                class="i-lucide:smile"
                @click.stop="openBehaviorModal = true"
              />

              <i
                class="i-lucide:folder-open"
                @click.stop="handleOpenFolder(data.path)"
              />

              <template v-if="!data.isPreset">
                <Popconfirm
                  :description="$t('pages.preference.model.hints.deleteModel')"
                  placement="topRight"
                  :title="$t('pages.preference.model.labels.deleteModel')"
                  @confirm="handleDelete(data)"
                >
                  <i
                    class="i-lucide:trash-2"
                    @click.stop
                  />
                </Popconfirm>
              </template>
            </template>
          </Card>

          <Card
            v-if="data.engine === '3d'"
            v-show="(curType === 'all' || curType === '3d')"
            :classes="{
              actions: `[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)`,
            }"
            hoverable
            size="small"
            @click="handleToggle(data)"
          >
            <template #cover>
              <Preview3d
                :id="data.id"
                :key="data.id"
                :path="data.path"
              />
            </template>

            <template #actions>
              <i
                class="i-lucide:circle-check"
                :class="{ 'text-success': data.id === modelStore.currentModel?.id }"
              />

              <i
                class="i-lucide:play"
              />

              <template v-if="!data.isPreset">
                <Popconfirm
                  :description="$t('pages.preference.model.hints.deleteModel')"
                  placement="topRight"
                  :title="$t('pages.preference.model.labels.deleteModel')"
                  @confirm="handleDelete(data)"
                >
                  <i
                    class="i-lucide:trash-2"
                    @click.stop
                  />
                </Popconfirm>
              </template>
            </template>
          </Card>
        </template>
      </Masonry>
    </section>
    <!-- <Upload class="min-h-40" /> -->
  </div>

  <FloatMenu />

  <BehaviorModal
    v-if="catStore.model.behavior"
    v-model="openBehaviorModal"
  />
</template>
