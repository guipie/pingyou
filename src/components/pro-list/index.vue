<script setup lang="ts">
import { Flex } from 'antdv-next'

const { title } = defineProps<{
  title: string
}>()
</script>

<template>
  <Flex
    class="not-last:mb-4"
    gap="small"
    vertical
  >
    <div
      class="flex justify-between"
      data-tauri-drag-region
    >
      <div class="text-4 font-medium">
        {{ title }}
      </div>
      <!-- right-slot   -->
      <slot name="right" />
    </div>

    <Flex
      gap="middle"
      vertical
    >
      <slot />
    </Flex>
  </FLex>
</template>
