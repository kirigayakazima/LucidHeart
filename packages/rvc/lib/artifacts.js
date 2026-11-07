import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const day = 86_400_000
const jobName = /^(?:sing_[\w-]+|voice_[a-f0-9-]+)$/
const legacyWork = /^\.work_sayvoice_[\w-]+$/
const songName = /^song(?:_[\w-]+)?\.(?:mp3|wav)$/
const voiceName = /^(?:voice(?:_profile)?|pc_voice|axing_voice|sayvoice)_[\w-]+\.wav$/
const sourceAudio = /^(?:input|dry|input_dry|vocals|no_vocals|accompaniment|voc_new|mix)\.(?:wav|mp3|m4a|flac)$/
const scratchFile = /^(?:chunk_\d+\.wav|(?:dry|voice|output)\.(?:dry\.mp3|result\.json)|manifest\.json|sing\.log|song_[\w-]+\.mp3\.part)$/

// The cache tree is the ledger. Rebuilding it from file metadata also adopts
// pre-upgrade files and avoids an index becoming stale after a crash.
export class Artifacts {
  constructor(root, { maxBytes = 1_500_000_000, maxEntries = 1024 } = {}) {
    this.root = path.resolve(root)
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
    this.active = new Set()
  }

  safeDirectory(dir) {
    try {
      // Android exposes shared storage through a system alias. Allow that
      // alias while refusing links at or below the configured artifact tree.
      const expected = process.platform === 'linux' && dir.startsWith('/sdcard/')
        ? path.join(fs.realpathSync.native('/sdcard'), dir.slice('/sdcard/'.length)) : dir
      return fs.realpathSync.native(dir) === expected && fs.lstatSync(dir).isDirectory()
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  contains(file) {
    const relative = path.relative(this.root, file)
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
  }

  begin(job = `voice_${randomUUID()}`) {
    if (!jobName.test(job)) throw new Error('Invalid RVC artifact job')
    this.sweep()
    fs.mkdirSync(this.root, { recursive: true })
    if (!this.safeDirectory(this.root)) throw new Error('Unsafe RVC artifact root')
    const dir = path.join(this.root, job)
    fs.mkdirSync(dir)
    this.active.add(dir)
    return dir
  }

  id(file) {
    const relative = path.relative(this.root, file)
    return createHash('sha256').update(relative.replaceAll(path.sep, '/')).digest('hex')
  }

  describe(file, type, info = fs.lstatSync(file)) {
    return { artifactId: this.id(file),
      path: file, type, size: info.size, createdAt: info.mtimeMs,
      ttlMs: type === 'song' ? 7 * day : type === 'voice' ? day : 0 }
  }

  scan(dir, depth = 0, directories) {
    if (!this.contains(dir) || !this.safeDirectory(dir) || depth > 6) return []
    const entries = []
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      const info = fs.lstatSync(file, { throwIfNoEntry: false })
      if (info?.isDirectory() && (depth > 0 || jobName.test(name) || legacyWork.test(name))) {
        entries.push(...this.scan(file, depth + 1, directories))
      } else if (info?.isFile() && !info.isSymbolicLink()) {
        let type = 'other'
        if (depth <= 1 && songName.test(name)) type = 'song'
        else if ((depth === 0 && voiceName.test(name)) ||
          (depth === 1 && name === 'voice.wav' && path.basename(dir).startsWith('voice_'))) type = 'voice'
        else if ((depth > 0 || /^(?:dry\.wav|chunk_\d+\.wav)$/.test(name)) &&
          (sourceAudio.test(name) || scratchFile.test(name))) type = 'temporary'
        entries.push(this.describe(file, type, info))
      }
    }
    directories?.push(dir)
    return entries
  }

  remove(file) {
    // Never follow a directory link or unlink a symlink, even if its name looks managed.
    if (!this.contains(file) || !this.safeDirectory(path.dirname(file))) return false
    const info = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!info?.isFile() || info.isSymbolicLink()) return false
    fs.unlinkSync(file)
    for (let dir = path.dirname(file); dir !== this.root; dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir) } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error
        break
      }
    }
    return true
  }

  cleanJob(dir, output, complete) {
    try {
      const directories = []
      for (const entry of this.scan(dir, 1, directories)) {
        if (entry.type === 'temporary' || (!complete && entry.path === output) ||
            (output.endsWith('.mp3') && entry.path === output.replace(/\.mp3$/, '.wav'))) {
          this.remove(entry.path)
        }
      }
      for (const directory of directories) this.removeEmpty(directory)
    } catch (error) {
      console.warn('[@dsh/rvc] 任务临时产物清理失败:', error.message)
    }
  }

  removeEmpty(dir) {
    if (!this.safeDirectory(dir)) return
    try { fs.rmdirSync(dir) } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error
    }
  }

  finish(dir) {
    this.active.delete(dir)
    this.sweep(dir)
  }

  sweep(protectedDir, now = Date.now()) {
    try {
      const entries = this.scan(this.root)
      const managed = entries.filter(entry => entry.type !== 'other')
      const available = managed.filter(entry => {
        const dir = path.join(this.root, path.relative(this.root, entry.path).split(path.sep)[0])
        return dir !== protectedDir && !this.active.has(dir)
      }).sort((a, b) => a.createdAt - b.createdAt)
      let bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
      let count = managed.length
      const removed = new Set()
      const remove = entry => {
        if (removed.has(entry.path)) return
        try {
          if (!this.remove(entry.path)) return
          removed.add(entry.path)
          bytes -= entry.size
          count--
        } catch (error) {
          console.warn('[@dsh/rvc] 产物清理失败:', error.message)
        }
      }
      // Give crash leftovers a grace period for older standalone producers.
      for (const entry of available) {
        if (now - entry.createdAt >= (entry.ttlMs || 60 * 60_000)) remove(entry)
      }
      for (const type of ['song', 'voice']) {
        for (const entry of available) {
          if (bytes <= this.maxBytes && count <= this.maxEntries) return
          if (entry.type === type) remove(entry)
        }
      }
    } catch (error) {
      console.warn('[@dsh/rvc] 产物账本扫描失败:', error.message)
    }
  }
}
