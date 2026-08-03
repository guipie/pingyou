<script setup lang="ts">
import { Avatar } from 'antdv-next'
import { computed, ref } from 'vue'

const props = defineProps<{
  text?: string
  url?: string
  icon?: string
  cusStyle?: string
}>()
const imgUrl = ref(props.url ? (props.url.startsWith('@/') ? props.url.replace(/^@\//, '/src/') : props.url) : null)
function parseStyleString(styleStr?: string): Record<string, string> {
  if (!styleStr) return {}
  const styleObj: Record<string, string> = {}
  styleStr.split(';').forEach((item) => {
    const [key, value] = item.split(':')
    if (key && value) {
      // 处理 key 为 kebab-case 的情况，可选：转为 camelCase
      styleObj[key.trim()] = value.trim()
    }
  })
  return styleObj
}

// 3. 合并默认样式和传入的字符串样式
const mergedStyle = computed(() => ({
  verticalAlign: 'middle',
  ...parseStyleString(props.cusStyle),
}))

function loadError() {
  imgUrl.value = '/aipingyou-tm.png'
  return true
}
</script>

<template>
  <i
    v-if="icon && icon.startsWith('i-')"
    class="inline-block h-16 w-16 text-5"
    :class="icon"
    :style="mergedStyle"
  />
  <Avatar
    v-else-if="text"
    :gap="1"
    size="large"
    style=" background-color: #f56a00;vertical-align: middle "
    :style="mergedStyle"
  >
    {{ text }}
  </Avatar>
  <Avatar
    v-else
    class="h-16 w-16"
    fit="contain"
    :gap="1"
    shape="square"
    :src="imgUrl"
    :style="mergedStyle"
    @on-error="loadError"
  />
</template>

 <style scoped>

 </style>
