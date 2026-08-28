import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface UserInfo {
  id: string
  email: string
  phone: string
  nickname: string
  plan: "free" | "pro" | "team"
  planExpiresAt?: number
}

export const useUserStore = defineStore("user", () => {
  const user = ref<UserInfo | null>(null);
  const token = ref("");

  const loggedIn = computed(() => !!token.value && !!user.value);
  const displayName = computed(() => user.value?.nickname || user.value?.email || "用户");
  const planLabel = computed(() => {
    const p = user.value?.plan;
    if (p === "pro") return "pro";
    if (p === "team") return "team";
    return "free";
  });

  /** 设置登录状态（从 deep-link 回调或手动调用） */
  function setLogin(data: { user: UserInfo, token: string }) {
    user.value = data.user;
    token.value = data.token;
  }

  /** 登出 */
  function logout() {
    user.value = null;
    token.value = "";
  }

  return {
    user,
    token,
    loggedIn,
    displayName,
    planLabel,
    setLogin,
    logout,
  };
});
