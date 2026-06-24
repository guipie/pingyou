<script setup lang="ts">
import type {
  Group,
  Material,
  Texture,
} from 'three'

import { convertFileSrc } from '@tauri-apps/api/core'
import {
  AmbientLight,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { onMounted, onUnmounted, shallowRef, useTemplateRef } from 'vue'

import model3d from '@/utils/model3d'

interface Model3dConfig {
  file?: string
  targetHeight?: number
  camera?: {
    fov?: number
    position?: [number, number, number]
  }
  model?: {
    position?: [number, number, number]
    rotation?: [number, number, number]
    scale?: number
  }
}

interface LoadedGltf {
  scene: Group
  parser: {
    json: {
      materials?: Array<{
        extensions?: {
          KHR_materials_pbrSpecularGlossiness?: {
            diffuseTexture?: {
              index: number
            }
          }
        }
      }>
    }
    associations: Map<object, { materials?: number }>
    getDependency: (type: 'texture', index: number) => Promise<Texture>
  }
}

const props = defineProps<{
  path: string
}>()

const canvasRef = useTemplateRef('canvas')
const failed = shallowRef(false)
let renderer: WebGLRenderer | null = null
let scene: Scene | null = null
let camera: PerspectiveCamera | null = null
let model: Group | null = null
let frameId = 0
const clock = new Clock()

onMounted(load)
onUnmounted(destroy)

async function load() {
  const canvas = canvasRef.value

  if (!canvas) return

  try {
    const configs = await model3d.loadConfigs()
    const file = find(configs, { path: props.path })

    if (!file) throw new Error('3D model file not found')

    renderer = new WebGLRenderer({ alpha: true, antialias: true, canvas })
    renderer.setClearColor(new Color(0x000000), 0)
    renderer.setPixelRatio(devicePixelRatio)

    scene = new Scene()
    camera = new PerspectiveCamera(config.camera?.fov ?? 35, 1, 0.1, 100)
    camera.position.set(...(config.camera?.position ?? [0, 1.35, 5]))
    scene.add(new AmbientLight(0xFFFFFF, 1.8))

    const light = new DirectionalLight(0xFFFFFF, 2.2)
    light.position.set(2, 4, 5)
    scene.add(light)

    model = await loadGltf(file)
    scene.add(model)
    fitModel(config)
    resize()
    startLoop()
  } catch {
    failed.value = true
  }
}

function loadGltf(path: string) {
  const loader = new GLTFLoader()

  return new Promise<Group>((resolve, reject) => {
    loader.load(
      convertFileSrc(path),
      async (gltf) => {
        await applySpecGlossDiffuseTextures(gltf as LoadedGltf)

        resolve(gltf.scene)
      },
      undefined,
      reject,
    )
  })
}

async function applySpecGlossDiffuseTextures(gltf: LoadedGltf) {
  const textureCache = new Map<number, Texture>()
  const pending: Array<Promise<void>> = []

  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return

    const materials = Array.isArray(object.material) ? object.material : [object.material]

    for (const material of materials) {
      pending.push(applySpecGlossDiffuseTexture(gltf, material, textureCache))
    }
  })

  await Promise.all(pending)
}

async function applySpecGlossDiffuseTexture(
  gltf: LoadedGltf,
  material: Material,
  textureCache: Map<number, Texture>,
) {
  const materialIndex = gltf.parser.associations.get(material)?.materials
  const materialDef = materialIndex === undefined ? undefined : gltf.parser.json.materials?.[materialIndex]
  const diffuseTexture = materialDef?.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture

  if (!diffuseTexture) return

  let texture = textureCache.get(diffuseTexture.index)

  if (!texture) {
    texture = await gltf.parser.getDependency('texture', diffuseTexture.index)
    texture.colorSpace = SRGBColorSpace
    textureCache.set(diffuseTexture.index, texture)
  }

  if (material instanceof MeshStandardMaterial) {
    material.map = texture
    material.color.set(0xFFFFFF)
    material.needsUpdate = true
  }
}
function fitModel(config: Model3dConfig) {
  if (!model) return

  const box = new Box3().setFromObject(model)
  const size = box.getSize(new Vector3())
  const center = box.getCenter(new Vector3())
  const targetHeight = config.targetHeight ?? 2.6
  const scale = size.y ? targetHeight / size.y : 1

  model.position.sub(center)
  model.scale.setScalar(scale * (config.model?.scale ?? 1))
  model.position.y += targetHeight / 2 - 0.05

  if (config.model?.position) {
    model.position.add(new Vector3(...config.model.position))
  }

  if (config.model?.rotation) {
    model.rotation.set(...config.model.rotation)
  }
}

function resize() {
  const canvas = canvasRef.value

  if (!canvas || !renderer || !camera) return

  const { width, height } = canvas.getBoundingClientRect()

  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height, false)
}

function startLoop() {
  clock.start()

  const render = () => {
    frameId = requestAnimationFrame(render)

    if (!renderer || !scene || !camera || !model) return

    const elapsed = clock.elapsedTime

    model.rotation.y += 0.006
    model.position.y += Math.sin(elapsed * 2) * 0.0008
    renderer.render(scene, camera)
  }

  frameId = requestAnimationFrame(render)
}

function destroy() {
  if (frameId) {
    cancelAnimationFrame(frameId)
  }

  model?.traverse((object) => {
    if (!(object instanceof Mesh)) return

    object.geometry.dispose()
  })
  renderer?.dispose()
}
</script>

<template>
  <div class="relative h-38 w-full bg-[--ant-color-fill-quaternary]">
    <canvas
      ref="canvas"
      class="size-full"
    />

    <div
      v-if="failed"
      class="absolute inset-0 flex items-center justify-center"
    >
      <i class="i-lucide:box text-12 text-primary" />
    </div>
  </div>
</template>
