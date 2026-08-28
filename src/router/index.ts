import type { RouteRecordRaw } from "vue-router";

import { createRouter, createWebHashHistory } from "vue-router";

import Main from "../pages/main/index.vue";
// import About from "../pages/preference/components/about/index.vue";
// import General from "../pages/preference/components/general/index.vue";
import ProviderAdd from "../pages/preference/components/provider/add.vue";
// import Shortcut from "../pages/preference/components/shortcut/index.vue";
import Preference from "../pages/preference/index.vue";
import WinChat from "../pages/winchat/index.vue";
import WinMsg from "../pages/winchat/msg.vue";
import { RoutersName } from "./roters.ts";

const routes: Readonly<RouteRecordRaw[]> = [
  {
    path: "/",
    component: Main,
  },
  {
    path: "/preference",
    component: Preference,
  },
  {
    path: "/winchat",
    component: WinChat,
  },
  {
    path: "/winmsg",
    component: WinMsg,
  },
  // {
  //   path: `/${RoutersName.General}`,
  //   name: RoutersName.General,
  //   component: General,
  // },
  // {
  //   path: `/${RoutersName.Shortcut}`,
  //   name: RoutersName.Shortcut,
  //   component: Shortcut,
  // },
  // {
  //   path: `/${RoutersName.About}`,
  //   name: RoutersName.About,
  //   component: About,
  // },
  {
    path: `/${RoutersName.ProviderAdd}`,
    name: RoutersName.ProviderAdd,
    component: ProviderAdd,
  },
];
const router = createRouter({
  // 关键：base 设为 '/'
  history: createWebHashHistory("/"),
  routes,
});

export default router;
