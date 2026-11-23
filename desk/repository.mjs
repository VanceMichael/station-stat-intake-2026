import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createState } from './state.mjs'

// 内存仓储：每个命令边界调用 mutate 时拿到一份草稿，成功后整体替换。
export class MemoryRepository {
  constructor(initial = createState()) {
    this.state = initial
  }

  async read() {
    return this.state
  }

  async mutate(fn) {
    const draft = JSON.parse(JSON.stringify(this.state))
    const result = await fn(draft)
    this.state = draft
    return result
  }
}

// 文件仓储：CLI 每次调用是独立进程，用一个 JSON 文件承载状态，
// 先写临时文件再 rename，保证落盘是原子的。
export class FileRepository {
  constructor(path) {
    this.path = path
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return createState()
      throw error
    }
  }

  async mutate(fn) {
    const state = await this.read()
    const result = await fn(state)
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmp, this.path)
    return result
  }
}
