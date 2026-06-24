<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { remove } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'
import { Card, Masonry, message, Popconfirm } from 'antdv-next'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model } from '@/stores/model'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { join } from '@/utils/path'

import BehaviorModal from './components/behavior-modal/index.vue'
import FloatMenu from './components/float-menu/index.vue'
import Preview3d from './components/preview-3d/index.vue'
import Upload from './components/upload/index.vue'

const catStore = useCatStore()
const modelStore = useModelStore()
const { t } = useI18n()
const openBehaviorModal = ref(false)

const live2dModels = computed(() => modelStore.models.filter(item => item.engine === 'live2d'))
const model3dModels = computed(() => modelStore.models.filter(item => item.engine === '3d'))

function getMasonryItems(models: Model[]) {
  return models.map(item => ({
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
    <Upload class="min-h-40" />

    <section class="flex flex-col gap-3">
      <div class="flex items-center gap-2 font-medium text-base">
        <i class="i-lucide:layers-2 text-primary" />
        <span>Live2D</span>
      </div>

      <Masonry
        :columns="{ xs: 3, lg: 4, xxl: 6 }"
        :gutter="16"
        :items="getMasonryItems(live2dModels)"
      >
        <template #itemRender="{ data }">
          <Card
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
                class="h-38 w-full object-cover"
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
        </template>
      </Masonry>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex items-center gap-2 font-medium text-base">
        <i class="i-lucide:box text-primary" />
        <span>3D</span>
      </div>

      <Masonry
        :columns="{ xs: 3, lg: 4, xxl: 6 }"
        :gutter="16"
        :items="getMasonryItems(model3dModels)"
      >
        <template #itemRender="{ data }">
          <Card
            :classes="{
              actions: `[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)`,
            }"
            hoverable
            size="small"
            @click="handleToggle(data)"
          >
            <template #cover>
              <Preview3d :path="data.path" />
            </template>

            <template #actions>
              <i
                class="i-lucide:circle-check"
                :class="{ 'text-success': data.id === modelStore.currentModel?.id }"
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
        </template>
      </Masonry>
    </section>
  </div>

  <FloatMenu />

  <BehaviorModal
    v-if="catStore.model.behavior"
    v-model="openBehaviorModal"
  />
</template>
