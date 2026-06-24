import type { PhysicalPosition } from '@tauri-apps/api/dpi'
import type {
  AnimationClip,
  Material,
  Object3D,
  Texture,
} from 'three'

import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import type { ModelSize } from '@/composables/useModel'

import { getCursorMonitor } from '@/utils/monitor'

import { join } from './path'

interface LoadResult {
  width: number
  height: number
  motions: Record<string, never[]>
  expressions: never[]
}

interface Model3dConfig {
  file?: string
  width?: number
  height?: number
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
  private model: Group | null = null
  private controls: ModelControls | null = null
  private config: Model3dConfig = {}
  private mixer: AnimationMixer | null = null
  private frameId = 0
  private clock = new Clock()
  private maxFPS = 60
  private lastFrameAt = 0
  private leftPressed = false
  private rightPressed = false
  private lookTarget = new Vector3()
  private stickTilt = new Vector2()

  private initRenderer() {
    if (this.renderer) return

    const canvas = document.getElementById('model3dCanvas') as HTMLCanvasElement

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

  public async load(path: string): Promise<LoadResult> {
    this.initRenderer()
    this.destroyModel()

    // this.config = await this.loadConfigs(path)

    const file = await this.findModelFile(path, this.config)

    this.model = file ? await this.loadGltf(file) : this.createFallbackModel()
    this.scene?.add(this.model)
    this.fitModel()
    this.bindControls()
    this.resizeModel(DEFAULT_MODEL_SIZE)
    this.startLoop()

    return {
      width: this.config.width ?? DEFAULT_MODEL_SIZE.width,
      height: this.config.height ?? DEFAULT_MODEL_SIZE.height,
      motions: {},
      expressions: [],
    }
  }

  public async loadConfigs(path: string) {
    const configPath = join(path, 'model3d.json')

    try {
      return JSON5.parse(await readTextFile(configPath)) as Model3dConfig[]
    } catch {
      return []
    }
  }

  public isBinary3d(path: string) {
    return path.toLowerCase().endsWith('.glb') || path.toLowerCase().endsWith('.vrm')
  }

  private async findModelFile(path: string, config: Model3dConfig) {
    if (config.file) return join(path, config.file)

    const files = await this.findModelFiles(path)

    return files[0] ?? ''
  }

  private async findModelFiles(path: string): Promise<string[]> {
    const entries = await readDir(path).catch(() => [])
    const files: string[] = []

    for (const entry of entries) {
      const entryPath = join(path, entry.name)

      if (entry.isDirectory) {
        files.push(...await this.findModelFiles(entryPath))
      } else if (/\.(?:glb|gltf|vrm)$/i.test(entry.name)) {
        files.push(entryPath)
      }
    }

    return files.sort((a, b) => {
      const aIsBinary = a.toLowerCase().endsWith('.glb') || a.toLowerCase().endsWith('.vrm')
      const bIsBinary = b.toLowerCase().endsWith('.glb') || b.toLowerCase().endsWith('.vrm')

      return Number(bIsBinary) - Number(aIsBinary)
    })
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

  private fitModel() {
    if (!this.model || !this.camera) return

    const box = new Box3().setFromObject(this.model)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    const targetHeight = this.config.targetHeight ?? 2.6
    const scale = size.y ? targetHeight / size.y : 1

    this.model.position.sub(center)
    this.model.scale.setScalar(scale * (this.config.model?.scale ?? 1))
    this.model.position.y += targetHeight / 2 - 0.05

    if (this.config.model?.position) {
      this.model.position.add(new Vector3(...this.config.model.position))
    }

    if (this.config.model?.rotation) {
      this.model.rotation.set(...this.config.model.rotation)
    }

    if (this.config.camera?.fov) {
      this.camera.fov = this.config.camera.fov
      this.camera.updateProjectionMatrix()
    }

    if (this.config.camera?.position) {
      this.camera.position.set(...this.config.camera.position)
    }
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

const model3d = new Model3d()

export default model3d
