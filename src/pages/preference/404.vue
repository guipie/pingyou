<script setup lang="ts">
import { useRouteSettingStore } from '@/stores/route-setting'

const routeStore = useRouteSettingStore()
</script>

<template>
  <section class="bg-white dark:bg-gray-900">
    <div class="mx-auto max-w-screen-xl px-4 py-8 lg:px-6 lg:py-16">
      <div class="mx-auto max-w-screen-sm text-center">
        <h1 class="text-primary-600 dark:text-primary-500 mb-4 text-7xl font-extrabold tracking-tight lg:text-9xl">
          404
        </h1>
        <p class="mb-4 text-3xl text-gray-900 font-bold tracking-tight md:text-4xl dark:text-white">
          Something's missing.
        </p>
        <p class="mb-4 text-gray-500 font-light text-lg dark:text-gray-400">
          Sorry, we can't find that page. You'll find lots to explore on the home page.
        </p>
        <a
          class="bg-primary-600 hover:bg-primary-800 focus:ring-primary-300 dark:focus:ring-primary-900 my-4 inline-flex px-5 py-2.5 text-center text-white font-medium text-sm rounded-lg focus:outline-none focus:ring-4"
          href="#"
          @click="routeStore.backHome()"
        >Back to Homepage</a>
      </div>
    </div>
  </section>
</template>

<style scoped>

</style>
