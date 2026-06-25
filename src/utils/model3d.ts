import type { PhysicalPosition } from '@tauri-apps/api/dpi'
import type {
  AnimationClip,
  Material,
  Object3D,
  Object3DEventMap,
  Texture,
} from 'three'

import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'
import { readTextFile } from '@tauri-apps/plugin-fs'
import JSON5 from 'json5'
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Euler,
  Group,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import type { ModelSize } from '@/composables/useModel'

import { getCursorMonitor } from '@/utils/monitor'

import { getFileName, join } from './path'

interface LoadResult {
  width: number
  height: number
  motions: Record<string, never[]>
  expressions: never[]
}

interface Model3dConfig {
  file?: string
  // width?: number
  // height?: number
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
  nodes?: {
    head?: string
    leftHand?: string
    rightHand?: string
  }
}

interface ModelControls {
  head?: Object3D
  leftHand?: Object3D
  rightHand?: Object3D
  basePosition: Vector3
  baseQuaternion: Quaternion
  baseScale: Vector3
  headBaseQuaternion?: Quaternion
  leftHandBasePosition?: Vector3
  rightHandBasePosition?: Vector3
}

const DEFAULT_MODEL_SIZE = {
  width: 420,
  height: 560,
}

interface LoadedGltf {
  scene: Group
  animations: AnimationClip[]
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

const NODE_NAME_PATTERNS = {
  head: [/head/i, /neck/i, /tou/i],
  leftHand: [/lefthand/i, /left.*hand/i, /hand.*l/i, /l_?hand/i, /zuo.*shou/i],
  rightHand: [/righthand/i, /right.*hand/i, /hand.*r/i, /r_?hand/i, /you.*shou/i],
}

class Model3d {
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: PerspectiveCamera | null = null
  public model: Group | null = null
  private controls: ModelControls | null = null
  public config: Model3dConfig = {}
  private mixer: AnimationMixer | null = null
  private frameId = 0
  private clock = new Clock()
  private maxFPS = 60
  private lastFrameAt = 0
  private leftPressed = false
  private rightPressed = false
  private lookTarget = new Vector3()
  private stickTilt = new Vector2()
  // 实例化赋值
  // constructor(inModel:Group,config:) {
  //   this.config = config
  //   this.model = inModel
  // }
  private initRenderer(canvasId?: string) {
    if (this.renderer) return

    const canvas = document.getElementById(canvasId ?? 'model3dCanvas') as HTMLCanvasElement

    this.renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      canvas,
    })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setPixelRatio(devicePixelRatio)
    this.renderer.setClearColor(new Color(0x000000), 0)

    this.scene = new Scene()
    this.camera = new PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100)
    this.camera.position.set(0, 1.4, 5)

    const ambient = new AmbientLight(0xFFFFFF, 1.8)
    const keyLight = new DirectionalLight(0xFFFFFF, 2.2)
    keyLight.position.set(2, 4, 5)

    this.scene.add(ambient, keyLight)
  }

  public async load(path: string, canvasId?: string): Promise<LoadResult> {
    this.config = await this.loadConfig(path) ?? {}
    this.initRenderer(canvasId)
    this.destroyModel()

    // this.config = await this.loadConfigs(path)

    // const file = await this.findModelFile(path, this.config)

    this.model = await this.load3DModel(path)
    this.scene?.add(this.model)
    this.fitModel()
    this.bindControls()
    this.resizeModel(DEFAULT_MODEL_SIZE)
    this.startLoop()

    return {
      width: DEFAULT_MODEL_SIZE.width,
      height: DEFAULT_MODEL_SIZE.height,
      motions: {},
      expressions: [],
    }
  }

  public async loadConfigs() {
    const path = await resolveResource('assets/models/model3d')
    const configPath = join(path, 'model3d.json')
    try {
      return JSON5.parse(await readTextFile(configPath)) as Model3dConfig[]
    } catch {
      return []
    }
  }

  public async loadConfig(path: string) {
    const file = await getFileName(path)
    const configs = await this.loadConfigs()
    try {
      return configs.find(config => config.file === file) ?? null
    } catch {
      return null
    }
  }

  public isBinary3d(path: string) {
    return path.toLowerCase().endsWith('.glb') || path.toLowerCase().endsWith('.vrm')
  }

  // private async findModelFile(path: string, config: Model3dConfig) {
  //   if (config.file) return join(path, config.file)

  //   const files = await this.findModelFiles(path)

  //   return files[0] ?? ''
  // }

  // private async findModelFiles(path: string): Promise<string[]> {
  //   const entries = await readDir(path).catch(() => [])
  //   const files: string[] = []

  //   for (const entry of entries) {
  //     const entryPath = join(path, entry.name)

  //     if (entry.isDirectory) {
  //       files.push(...await this.findModelFiles(entryPath))
  //     } else if (/\.(?:glb|gltf|vrm)$/i.test(entry.name)) {
  //       files.push(entryPath)
  //     }
  //   }

  //   return files.sort((a, b) => {
  //     const aIsBinary = a.toLowerCase().endsWith('.glb') || a.toLowerCase().endsWith('.vrm')
  //     const bIsBinary = b.toLowerCase().endsWith('.glb') || b.toLowerCase().endsWith('.vrm')

  //     return Number(bIsBinary) - Number(aIsBinary)
  //   })
  // }
  public async load3DModel(path: string) {
    const isFbx = path.toLowerCase().endsWith('.fbx')
    if (isFbx) {
      return await this.loadFbx(path) ?? this.createFallbackModel()
    } else {
      return await this.loadGltf(path) ?? this.createFallbackModel()
    }
  }

  private loadGltf(path: string) {
    const loader = new GLTFLoader()

    return new Promise<Group>((resolve, reject) => {
      loader.load(
        convertFileSrc(path),
        async (gltf) => {
          const root = gltf.scene

          await this.applySpecGlossDiffuseTextures(gltf as LoadedGltf)

          if (gltf.animations[0]) {
            this.mixer = new AnimationMixer(root)
            this.mixer.clipAction(gltf.animations[0]).play()
          }

          resolve(root)
        },
        undefined,
        reject,
      )
    })
  }

  /**
   * 加载 FBX 模型的方法
   * @param path 模型文件的完整路径或名称（例如: 'models/fbx/Samba Dancing.fbx' 或传递 asset 拼装）
   */
  private loadFbx(path: string): Promise<Group<Object3DEventMap>> {
    const manager = new LoadingManager()
    const loader = new FBXLoader(manager)
    return new Promise((resolve, reject) => {
      loader.load(
        convertFileSrc(path),
        (group) => {
          // 1. 清理并销毁旧模型（垃圾回收，防止内存泄漏）
          if (this.model) {
            this.model.traverse((child: any) => {
              if (child.isSkinnedMesh) {
                child.skeleton.dispose()
              }
              if (child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material]
                materials.forEach((material: any) => {
                  if (material.map) material.map.dispose()
                  material.dispose()
                })
              }
              if (child.geometry) {
                child.geometry.dispose()
              }
            })
            // 从场景中移除旧的（如果需要在方法内部管理场景，可加上这句：this.scene.remove(this.object);）
          }

          // 2. 赋予新对象
          // this.model = group;

          // 3. 处理缩放 (提取路径中的关键字来匹配你的 scales 规则)
          // 示例：如果是 'models/fbx/warrior/Warrior.fbx'，匹配 'warrior/Warrior'
          const scales = new Map<string, number>()
          scales.set('warrior/Warrior', 100)
          scales.set('archer/ArcherRi01', 100)
          scales.set('stanford-bunny', 0.001)
          scales.set('Head_69', 100)
          const matchKey = Object.keys(Object.fromEntries(scales)).find(key => path.includes(key))
          const scale = matchKey ? scales.get(matchKey) : 1
          group.scale.setScalar(scale || 1)

          // 4. 处理动画 Mixer
          if (group.animations && group.animations.length) {
            this.mixer = new AnimationMixer(group)
            const action = this.mixer.clipAction(group.animations[0])
            action.play()
          } else {
            this.mixer = null
          }

          // 5. 处理阴影与 GUI Morph 变形目标（GUI 部分可选，根据你类中是否有 guiMorphsFolder 决定）
          // if (this.guiMorphsFolder) {
          //     this.guiMorphsFolder.children.forEach((child: any) => child.destroy());
          //     this.guiMorphsFolder.hide();
          // }

          group.traverse((child: any) => {
            if (child.isMesh) {
              child.castShadow = true
              child.receiveShadow = true

              // if (child.morphTargetDictionary && this.guiMorphsFolder) {
              //     this.guiMorphsFolder.show();
              //     const meshFolder = this.guiMorphsFolder.addFolder(child.name || child.uuid);
              //     Object.keys(child.morphTargetDictionary).forEach((key) => {
              //         meshFolder.add(child.morphTargetInfluences, child.morphTargetDictionary[key], 0, 1, 0.01);
              //     });
              // }
            }
          })

          // 6. 成功返回模型对象
          resolve(group as Group<Object3DEventMap>)
        },
        // 进度回调（可选）
        (xhr) => {
          console.warn(`${xhr.loaded / xhr.total * 100}% loaded`)
        },
        // 失败回调
        (error) => {
          console.error('An error happened while loading FBX:', error)
          reject(error)
        },
      )
    })
  }

  private async applySpecGlossDiffuseTextures(gltf: LoadedGltf) {
    const textureCache = new Map<number, Texture>()
    const pending: Array<Promise<void>> = []

    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return

      const materials = Array.isArray(object.material) ? object.material : [object.material]

      for (const material of materials) {
        pending.push(this.applySpecGlossDiffuseTexture(gltf, material, textureCache))
      }
    })

    await Promise.all(pending)
  }

  private async applySpecGlossDiffuseTexture(
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

  private createFallbackModel() {
    const root = new Group()
    const material = new MeshStandardMaterial({ color: 0xF4B183, roughness: 0.55 })
    const accent = new MeshStandardMaterial({ color: 0x5B6EE1, roughness: 0.5 })
    const dark = new MeshStandardMaterial({ color: 0x2F3542, roughness: 0.65 })

    const body = new Mesh(new SphereGeometry(0.72, 48, 32), material)
    body.name = 'body'
    body.scale.set(0.82, 1.16, 0.62)
    body.position.y = 0.45

    const head = new Mesh(new SphereGeometry(0.58, 48, 32), material)
    head.name = 'head'
    head.position.y = 1.45

    const leftHand = new Mesh(new SphereGeometry(0.2, 32, 20), accent)
    leftHand.name = 'leftHand'
    leftHand.position.set(-0.58, 0.72, 0.2)

    const rightHand = leftHand.clone()
    rightHand.name = 'rightHand'
    rightHand.position.x = 0.58

    const leftEye = new Mesh(new SphereGeometry(0.045, 16, 12), dark)
    leftEye.position.set(-0.19, 1.55, 0.52)

    const rightEye = leftEye.clone()
    rightEye.position.x = 0.19

    root.add(body, head, leftHand, rightHand, leftEye, rightEye)
    root.userData.head = head
    root.userData.leftHand = leftHand
    root.userData.rightHand = rightHand

    return root
  }

  public fitModel() {
    if (!this.model || !this.camera) return

    // 1. 获取模型的真实包围盒与尺寸
    const box = new Box3().setFromObject(this.model)
    const size = box.getSize(new Vector3())
    // const center = box.getCenter(new Vector3())

    // console.log('模型原始大小 size:', size)
    // console.log('模型原始中心 center:', center)

    // 2. 计算缩放比：根据配置的 targetHeight（默认2.0）自适应缩放到合适的大小
    const targetHeight = this.config.targetHeight ?? 2.0
    // 如果模型高度有效，缩放比 = 期望高度 / 实际高度
    let scale = size.y ? targetHeight / size.y : 1

    // 叠加上 json 配置文件里自定义的 model.scale
    scale *= (this.config.model?.scale ?? 1)
    this.model.scale.setScalar(scale)

    // 3. 重新对齐位置（让模型的底部/脚底，对准世界坐标系的 Y = 0 附近）
    // 这样无论模型原始是一百米还是一米，缩放后其脚底都在原点，方便 Pingyou 做各种动作
    this.model.position.set(0, 0, 0) // 先归零

    // 核心对齐公式：将模型挪到原点，并让脚底着地
    // 模型缩放后的实际最低点是 (box.min.y * scale)，我们要把它抬到 0
    this.model.position.y = -box.min.y * scale

    // 4. 应用配置文件（json）中的 model.position 偏移
    if (this.config.model?.position) {
      this.model.position.add(new Vector3(...this.config.model.position))
    }

    // 5. 应用配置文件中的 model.rotation 旋转
    if (this.config.model?.rotation) {
      this.model.rotation.set(...this.config.model.rotation)
    }

    // 6. 应用配置文件中的相机参数
    if (this.config.camera?.fov) {
      this.camera.fov = this.config.camera.fov
    }

    if (this.config.camera?.position) {
      this.camera.position.set(...this.config.camera.position)
    }

    // 重新计算相机的投影矩阵
    this.camera.updateProjectionMatrix()

    // console.log('自适应调整后模型位置:', this.model.position)
    // console.log('自适应调整后模型缩放:', this.model.scale)
  }

  private bindControls() {
    if (!this.model) return

    const configuredNodes = this.config.nodes ?? {}
    const head = this.findNode(configuredNodes.head, NODE_NAME_PATTERNS.head)
    const leftHand = this.findNode(configuredNodes.leftHand, NODE_NAME_PATTERNS.leftHand)
    const rightHand = this.findNode(configuredNodes.rightHand, NODE_NAME_PATTERNS.rightHand)

    this.controls = {
      head,
      leftHand,
      rightHand,
      basePosition: this.model.position.clone(),
      baseQuaternion: this.model.quaternion.clone(),
      baseScale: this.model.scale.clone(),
      headBaseQuaternion: head?.quaternion.clone(),
      leftHandBasePosition: leftHand?.position.clone(),
      rightHandBasePosition: rightHand?.position.clone(),
    }
  }

  private findNode(configuredName: string | undefined, patterns: RegExp[]) {
    if (!this.model) return

    let matched: Object3D | undefined

    this.model.traverse((object) => {
      if (matched) return

      if (configuredName && object.name === configuredName) {
        matched = object

        return
      }

      if (!configuredName && patterns.some(pattern => pattern.test(object.name))) {
        matched = object
      }
    })

    return matched
  }

  public destroy() {
    this.stopLoop()
    this.destroyModel()
    this.clear()
  }

  private destroyModel() {
    if (!this.model) return

    this.scene?.remove(this.model)
    this.model.traverse((object) => {
      if (!(object instanceof Mesh)) return

      object.geometry.dispose()
    })
    this.model = null
    this.controls = null
    this.mixer = null
    this.leftPressed = false
    this.rightPressed = false
    this.lookTarget.set(0, 0, 0)
    this.stickTilt.set(0, 0)
  }

  private clear() {
    if (!this.renderer || !this.scene || !this.camera) return

    this.renderer.clear(true, true, true)
    this.renderer.render(this.scene, this.camera)
  }

  public resizeModel(_modelSize?: ModelSize) {
    if (!this.renderer || !this.camera) return

    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight, false)
  }

  public setHandPressed(isLeft = true, pressed = true) {
    if (isLeft) {
      this.leftPressed = pressed
    } else {
      this.rightPressed = pressed
    }
  }

  public setMousePressed(key: string, pressed = true) {
    this.setHandPressed(key === 'Left', pressed)
  }

  public async setMousePosition(cursorPoint: PhysicalPosition) {
    const monitor = await getCursorMonitor(cursorPoint)

    if (!monitor) return

    const { size, position } = monitor
    const x = ((cursorPoint.x - position.x) / size.width - 0.5) * 2
    const y = ((cursorPoint.y - position.y) / size.height - 0.5) * 2

    this.lookTarget.set(x, -y, 0)
  }

  public setAxis(id: string, value: number) {
    if (!this.model) return

    if (id.endsWith('LX')) this.stickTilt.x = value
    if (id.endsWith('LY')) this.stickTilt.y = value
    if (id.endsWith('RX')) this.lookTarget.x = value
    if (id.endsWith('RY')) this.lookTarget.y = -value
  }

  public setMaxFPS(fps: number) {
    this.maxFPS = fps
  }

  private startLoop() {
    this.stopLoop()
    this.clock.start()

    const render = (time: number) => {
      this.frameId = requestAnimationFrame(render)

      if (this.maxFPS > 0 && time - this.lastFrameAt < 1000 / this.maxFPS) return

      this.lastFrameAt = time
      this.tick()
    }

    this.frameId = requestAnimationFrame(render)
  }

  private stopLoop() {
    if (!this.frameId) return

    cancelAnimationFrame(this.frameId)
    this.frameId = 0
  }

  private tick() {
    if (!this.renderer || !this.scene || !this.camera || !this.model) return

    const delta = this.clock.getDelta()
    const elapsed = this.clock.elapsedTime
    const controls = this.controls
    const head = controls?.head ?? this.model.userData.head as Object3D | undefined
    const leftHand = controls?.leftHand ?? this.model.userData.leftHand as Object3D | undefined
    const rightHand = controls?.rightHand ?? this.model.userData.rightHand as Object3D | undefined
    const inputStrength = Number(this.leftPressed || this.rightPressed)

    this.mixer?.update(delta)

    if (controls) {
      this.model.position.lerp(
        controls.basePosition.clone().add(new Vector3(0, Math.sin(elapsed * 2) * 0.025 - inputStrength * 0.035, 0)),
        0.1,
      )
      this.model.scale.lerp(
        controls.baseScale.clone().multiply(new Vector3(1 + inputStrength * 0.018, 1 - inputStrength * 0.018, 1 + inputStrength * 0.018)),
        0.12,
      )
      this.model.quaternion.slerp(
        controls.baseQuaternion.clone().multiply(
          new Quaternion().setFromEuler(new Euler(
            this.stickTilt.y * 0.12,
            this.lookTarget.x * 0.25,
            this.stickTilt.x * -0.14 + (Number(this.rightPressed) - Number(this.leftPressed)) * 0.05,
          )),
        ),
        0.08,
      )
    }

    if (head) {
      head.quaternion.slerp(
        (controls?.headBaseQuaternion ?? new Quaternion()).clone().multiply(
          new Quaternion().setFromEuler(new Euler(this.lookTarget.y * 0.16, this.lookTarget.x * 0.2, 0)),
        ),
        0.1,
      )
    }

    if (leftHand && controls?.leftHandBasePosition) {
      leftHand.position.lerp(
        controls.leftHandBasePosition.clone().add(new Vector3(0, this.leftPressed ? -0.18 : Math.sin(elapsed * 3) * 0.025, 0.04)),
        0.18,
      )
    }

    if (rightHand && controls?.rightHandBasePosition) {
      rightHand.position.lerp(
        controls.rightHandBasePosition.clone().add(new Vector3(0, this.rightPressed ? -0.18 : Math.sin(elapsed * 3 + 1) * 0.025, 0.04)),
        0.18,
      )
    }

    this.renderer.render(this.scene, this.camera)
  }
}

// const model3d = new Model3d()

export default Model3d
