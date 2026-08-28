<script setup lang="ts">
import { storeToRefs } from "pinia";
import { watch } from "vue";
import { useI18n } from "vue-i18n";

import ProListItem from "@/components/pro-list-item/index.vue";
import ProList from "@/components/pro-list/index.vue";
import Shortcut from "@/components/shortcut/index.vue";
import { useKeyPress } from "@/composables/useKeyPress";
import { WINDOW_LABEL } from "@/constants";
import { toggleWindowVisible } from "@/plugins/window";
import { useCatStore } from "@/stores/cat";
import { useGeneralStore } from "@/stores/general";
import { useShortcutStore } from "@/stores/shortcut.ts";

const shortcutStore = useShortcutStore();
const { t } = useI18n();
const { visibleCat, visiblePreference, mirrorMode, penetrable, alwaysOnTop, messageInput } = storeToRefs(shortcutStore);
const catStore = useCatStore();

const generalStore = useGeneralStore();

useKeyPress(visibleCat, () => {
  catStore.window.visible = !catStore.window.visible;
});

useKeyPress(visiblePreference, () => {
  toggleWindowVisible(WINDOW_LABEL.PREFERENCE);
});

useKeyPress(mirrorMode, () => {
  catStore.model.mirror = !catStore.model.mirror;
});

useKeyPress(penetrable, () => {
  catStore.window.passThrough = !catStore.window.passThrough;
});

useKeyPress(alwaysOnTop, () => {
  catStore.window.alwaysOnTop = !catStore.window.alwaysOnTop;
});

useKeyPress(messageInput, () => {
  catStore.window.messageInput = !catStore.window.messageInput;
});

watch(() => generalStore.appearance.isDark, (value) => {
  if (value) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}, { immediate: true });
</script>

<template>
  <div
    id="shortcut"
    class="py-2"
  >
    <ProList :title="$t('pages.preference.shortcut.title')">
      <ProListItem
        :description="$t('pages.preference.shortcut.hints.toggleCat')"
        :title="$t('pages.preference.shortcut.labels.toggleCat')"
      >
        <Shortcut v-model="shortcutStore.visibleCat" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.shortcut.hints.togglePreferences')"
        :title="$t('pages.preference.shortcut.labels.togglePreferences')"
      >
        <Shortcut v-model="shortcutStore.visiblePreference" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.shortcut.hints.mirrorMode')"
        :title="$t('pages.preference.shortcut.labels.mirrorMode')"
      >
        <Shortcut v-model="shortcutStore.mirrorMode" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.shortcut.hints.passThrough')"
        :title="$t('pages.preference.shortcut.labels.passThrough')"
      >
        <Shortcut v-model="shortcutStore.penetrable" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.shortcut.hints.alwaysOnTop')"
        :title="$t('pages.preference.shortcut.labels.alwaysOnTop')"
      >
        <Shortcut v-model="shortcutStore.alwaysOnTop" />
      </ProListItem>

      <ProListItem
        :description="t('pages.preference.shortcut.hints.openMessageBox')"
        :title="t('pages.preference.shortcut.labels.openMessageBox')"
      >
        <Shortcut v-model="shortcutStore.messageInput" />
      </ProListItem>
    </ProList>
  </div>
</template>
