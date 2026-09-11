import type { Ref } from "vue";

import { computed } from "vue";

import type { LocalModelPreset, ModelFitLevel, ModelFitResult } from "@/constants/local-models";
import type { HardwareReport } from "@/stores/shard/app-shard";

import {
  LOCAL_MODEL_CATALOG,

} from "@/constants/local-models";

/**
 * 按当前硬件配置过滤本地模型目录，给出每个模型的适配档位。
 *
 * 判定规则：
 *   - 无独显（max_vram_mb = 0）时，vram_mb > 0 的模型按"内存兜底"判定
 *   - 内存 < 模型 ram_gb → unsupported
 *   - 显存 < 模型 vram_mb 且无内存兜底空间 → unsupported
 *   - 显存 ≥ 模型需求 + 1GB 余量 → recommended（featured 同样优先）
 *   - 显存 ≥ 模型需求 → ok
 *   - 显存 < 模型需求但内存 ≥ ram_gb → tight（可跑但慢）
 */
function evaluateFit(model: LocalModelPreset, hw: HardwareReport): ModelFitResult {
  // 内存硬门槛
  if (hw.total_memory_gb < model.ram_gb) {
    return {
      model,
      level: "unsupported",
      reasonKey: "local-models.reason.ramInsufficient",
    };
  }

  // 无显存需求（可纯 CPU）的轻量模型
  if (model.vram_mb === 0) {
    return { model, level: model.featured ? "recommended" : "ok" };
  }

  const vram = hw.max_vram_mb ?? 0;

  // 有独显时按显存分档
  if (vram >= model.vram_mb + 1024) {
    // 显存充裕 + 余量 ≥1GB
    return { model, level: model.featured ? "recommended" : "ok" };
  }
  if (vram >= model.vram_mb) {
    // 刚好够，略紧
    return { model, level: "ok" };
  }
  if (vram > 0 && vram >= model.vram_mb * 0.7) {
    // 显存略缺但接近（≥70%），可跑但会部分走 CPU
    return { model, level: "tight", reasonKey: "local-models.reason.vramTight" };
  }
  // 显存缺口过大
  // 若内存足够大，仍允许 CPU 兜底跑（tight），否则 unsupported
  if (hw.total_memory_gb >= model.ram_gb + 8) {
    return { model, level: "tight", reasonKey: "local-models.reason.cpuFallback" };
  }
  return { model, level: "unsupported", reasonKey: "local-models.reason.vramInsufficient" };
}

/**
 * composable：传入硬件报告 Ref，返回按适配档位分组的模型列表。
 */
export function useHardwareModels(hardwareRef: Ref<HardwareReport>) {
  /** 全部模型 + 适配档位 */
  const allModels = computed<ModelFitResult[]>(() => {
    const hw = hardwareRef.value;
    return LOCAL_MODEL_CATALOG.map(m => evaluateFit(m, hw));
  });

  /** 可安装（推荐 + ok + tight） */
  const installable = computed(() =>
    allModels.value.filter(r => r.level !== "unsupported"),
  );

  /** 不可安装 */
  const unsupported = computed(() =>
    allModels.value.filter(r => r.level === "unsupported"),
  );

  /** 推荐安装（featured 且档位 ≥ ok） */
  const recommended = computed(() =>
    allModels.value.filter(r => (r.model.featured && r.level !== "unsupported") || r.level === "recommended"),
  );

  /** 是否有 N 卡等独显 */
  const hasGpu = computed(() => (hardwareRef.value.max_vram_mb ?? 0) > 0);

  return {
    allModels,
    installable,
    unsupported,
    recommended,
    hasGpu,
  };
}

export type { ModelFitLevel, ModelFitResult };
