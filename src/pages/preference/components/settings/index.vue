<script setup lang="ts">
import { Divider, Flex, InputNumber, Slider, SpaceAddon, SpaceCompact, Switch } from "antdv-next";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import ProListItem from "@/components/pro-list-item/index.vue";
import ProList from "@/components/pro-list/index.vue";
import { useCatStore } from "@/stores/cat";
import { isWindows } from "@/utils/platform";

import About from "./about/index.vue";
import General from "./general/index.vue";
import Shortcut from "./shortcut/index.vue";

const catStore = useCatStore();
const activeAnchor = ref("pysz");
let scrollContainer: HTMLElement | null = null;
const { t } = useI18n();
const anchorItems = [
  {
    key: "pysz",
    title: t("pages.preference.cat.labels.modelSettings"),
  },
  {
    key: "cksz",
    title: t("pages.preference.cat.labels.windowSettings"),
  },
  {
    key: "ygsz",
    title: t("pages.preference.general.labels.appSettings"),
  },
  {
    key: "wgsz",
    title: t("pages.preference.general.labels.appearanceSettings"),
  },
  {
    key: "shortcut",
    title: t("pages.preference.shortcut.title"),
  },
  {
    key: "about",
    title: t("pages.preference.about.labels.aboutApp"),
  },
];

function scrollToSection(id: string) {
  const element = document.getElementById(id);
  // activeAnchor.value = id;
  if (element && scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const scrollTop = scrollContainer.scrollTop;
    const offsetTop = elementRect.top - containerRect.top + scrollTop;

    scrollContainer.scrollTo({
      top: offsetTop,
      behavior: "smooth",
    });
  }
}

function handleScroll() {
  if (!scrollContainer) return;

  const sections = anchorItems.map(item => ({
    id: item.key,
    element: document.getElementById(item.key),
  }));

  const containerRect = scrollContainer.getBoundingClientRect();

  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (section.element) {
      const rect = section.element.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top;
      if (relativeTop <= 100) {
        activeAnchor.value = section.id;
        break;
      }
    }
  }
}

onMounted(() => {
  scrollContainer = document.querySelector("#settings") as HTMLElement;
  if (scrollContainer) {
    scrollContainer.addEventListener("scroll", handleScroll);
  }
});

onBeforeUnmount(() => {
  if (scrollContainer) {
    scrollContainer.removeEventListener("scroll", handleScroll);
  }
});
</script>

<template>
  <div class="anchor-nav">
    <div
      v-for="item in anchorItems"
      :key="item.key"
      class="anchor-item"
      :class="{ active: activeAnchor === item.key }"
      @click="scrollToSection(item.key)"
    >
      {{ item.title }}
    </div>
  </div>
  <div class="absolute left-165px top-24px">
    <div
      id="pysz"
      class="py-2"
    >
      <ProList
        :title="$t('pages.preference.cat.labels.modelSettings')"
      >
        <ProListItem
          :description="$t('pages.preference.cat.hints.mirrorMode')"
          :title="$t('pages.preference.cat.labels.mirrorMode')"
        >
          <Switch v-model:checked="catStore.model.mirror" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.mouseMirror')"
          :title="$t('pages.preference.cat.labels.mouseMirror')"
        >
          <Switch v-model:checked="catStore.model.mouseMirror" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.ignoreMouse')"
          :title="$t('pages.preference.cat.labels.ignoreMouse')"
        >
          <Switch v-model:checked="catStore.model.ignoreMouse" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.motionSound')"
          :title="$t('pages.preference.cat.labels.motionSound')"
        >
          <Switch v-model:checked="catStore.model.motionSound" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.behavior')"
          :title="$t('pages.preference.cat.labels.behavior')"
        >
          <Switch v-model:checked="catStore.model.behavior" />
        </ProListItem>

        <ProListItem
          v-if="isWindows"
          :description="$t('pages.preference.cat.hints.autoReleaseDelay')"
          :title="$t('pages.preference.cat.labels.autoReleaseDelay')"
        >
          <SpaceCompact>
            <InputNumber
              v-model:value="catStore.model.autoReleaseDelay"
              class="w-20"
            />

            <SpaceAddon>s</SpaceAddon>
          </SpaceCompact>
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.maxFPS')"
          :title="$t('pages.preference.cat.labels.maxFPS')"
        >
          <InputNumber
            v-model:value="catStore.model.maxFPS"
            class="w-20"
            :min="0"
          />
        </ProListItem>
      </ProList>
    </div>
    <div
      id="cksz"
      class="py-2"
    >
      <ProList
        :title="$t('pages.preference.cat.labels.windowSettings')"
      >
        <ProListItem
          :description="$t('pages.preference.cat.hints.passThrough')"
          :title="$t('pages.preference.cat.labels.passThrough')"
        >
          <Switch v-model:checked="catStore.window.passThrough" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.alwaysOnTop')"
          :title="$t('pages.preference.cat.labels.alwaysOnTop')"
        >
          <Switch v-model:checked="catStore.window.alwaysOnTop" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.hideOnHover')"
          :title="$t('pages.preference.cat.labels.hideOnHover')"
        >
          <Flex align="center">
            <Switch v-model:checked="catStore.window.hideOnHover" />

            <Flex
              align="center"
              class="overflow-hidden transition-all"
              :class="[catStore.window.hideOnHover ? 'w-28 opacity-100' : 'w-0 opacity-0']"
            >
              <Divider type="vertical" />

              <SpaceCompact>
                <InputNumber
                  v-model:value="catStore.window.hideOnHoverDelay"
                  class="w-16"
                  :min="0"
                />

                <SpaceAddon>s</SpaceAddon>
              </SpaceCompact>
            </Flex>
          </Flex>
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.keepInScreen')"
          :title="$t('pages.preference.cat.labels.keepInScreen')"
        >
          <Switch v-model:checked="catStore.window.keepInScreen" />
        </ProListItem>

        <ProListItem
          :description="$t('pages.preference.cat.hints.windowSize')"
          :title="$t('pages.preference.cat.labels.windowSize')"
        >
          <SpaceCompact>
            <InputNumber
              v-model:value="catStore.window.scale"
              class="w-20"
              :max="500"
              :min="1"
            />

            <SpaceAddon>%</SpaceAddon>
          </SpaceCompact>
        </ProListItem>

        <ProListItem :title="$t('pages.preference.cat.labels.windowRadius')">
          <SpaceCompact>
            <InputNumber
              v-model:value="catStore.window.radius"
              class="w-20"
              :min="0"
            />

            <SpaceAddon>%</SpaceAddon>
          </SpaceCompact>
        </ProListItem>

        <ProListItem
          :title="$t('pages.preference.cat.labels.opacity')"
          vertical
        >
          <Slider
            v-model:value="catStore.window.opacity"
            class="m-0!"
            :max="100"
            :min="10"
            :tooltip="{
              formatter(value) {
                return `${value}%`
              },
            }"
          />
        </ProListItem>
      </ProList>
    </div>
    <General />
    <Shortcut />
    <About />
  </div>
</template>

<style scoped>
.anchor-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 120px;
  padding: 12px 16px;
  border-left: 1px solid #e8e8e8;
  height: fit-content;
  max-width: 120px;
  position: sticky;
  top: 0px;
  left: 0px;
  z-index: 10000;
}
.anchor-item {
  padding: 8px 12px;
  font-size: 14px;
  color: #666;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.3s ease;
  position: relative;
}

.anchor-item:hover {
  color: #1890ff;
}

.anchor-item.active {
  color: #1890ff;
  font-weight: 500;
}

.anchor-item.active::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 20px;
  background-color: #1890ff;
  border-radius: 1px;
}
</style>
