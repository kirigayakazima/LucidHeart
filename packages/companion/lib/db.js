import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const defaultDataDir = '/root/.dsh/companion'

export function openDb(root, name, schema) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path.join(root, name + '.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
    db.exec(schema)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export class InputError extends Error {}

export function requireThat(condition, message) {
  if (!condition) throw new InputError(message)
}

export function str(value, name, max = 500) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} 格式无效`)
  return value.trim()
}

export function object(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), '需要 JSON 对象')
  return value
}

export function json(value) {
  const encoded = JSON.stringify(value ?? null)
  requireThat(encoded && Buffer.byteLength(encoded) <= 65_536, 'JSON 数据过大')
  return encoded
}
