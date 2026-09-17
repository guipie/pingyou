<script setup lang="ts">
/**
 * 「正在输入 / 思考中」的三点跳动动画。
 * 纯 CSS 关键帧，不依赖任何状态，颜色跟随 text-secondary。
 */
withDefaults(defineProps<{ label?: string }>(), { label: "" });
</script>

<template>
  <span class="typing-dots inline-flex items-center gap-1.5">
    <span
      v-if="label"
      class="typing-dots__label"
    >{{ label }}</span>
    <span class="typing-dots__dots">
      <i /><i /><i />
    </span>
  </span>
</template>

<style scoped>
.typing-dots__label {
  font-size: 13px;
  color: var(--ant-color-text-tertiary);
}

.typing-dots__dots {
  display: inline-flex;
  align-items: flex-end;
  gap: 3px;
  height: 12px;
}

.typing-dots__dots i {
  width: 5px;
  height: 5px;
  background: var(--ant-color-text-tertiary);
  border-radius: 50%;
  animation: typing-bounce 1.2s infinite ease-in-out;
}

.typing-dots__dots i:nth-child(2) {
  animation-delay: 0.18s;
}

.typing-dots__dots i:nth-child(3) {
  animation-delay: 0.36s;
}

@keyframes typing-bounce {
  0%,
  70%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }

  35% {
    opacity: 1;
    transform: translateY(-4px);
  }
}
</style>
