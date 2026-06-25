<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from 'vue';

import Model3d from '@/utils/model3d';

const props = defineProps<{
  id: string
  path: string
  // isPlay: { type: boolean, default: true }
}>()

// const canvasRef = useTemplateRef('canvas')
const failed = shallowRef(false)
const loading = shallowRef(false)
const model3d = new Model3d()
onMounted(async () => {
  await load()
})
onUnmounted(() => {
  model3d.destroy()
})

async function load() {
  try {
    loading.value = true
    await model3d.load(props.path, props.id)
  } catch (err) {
    failed.value = true
    console.error('加载3d模型出错了,', err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="relative h-38 w-full bg-[--ant-color-fill-quaternary]">
    <canvas
      v-if="props.id"
      :id="props.id"
      class="size-full"
    />
    <div
      v-if="failed"
      class="absolute inset-0 flex items-center justify-center"
    >
      <i class="i-lucide:box text-12 text-primary" />
      <span class="color-error">error</span>
    </div>
    <div
      v-if="loading"
      class="absolute inset-0 flex items-center justify-center"
    >
      <i class="i-lucide:loader animate-spin text-12 text-primary" />
    </div>
  </div>
</template>
