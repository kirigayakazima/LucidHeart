import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const defaultRoot = '/root/.dsh/evolution'
export class InputError extends Error {}
export function check(condition, message) {
  if (!condition) throw new InputError(message)
}
export function text(value, label, max = 500) {
  check(typeof value === 'string' && value.trim() && [...value].length <= max, `${label} 格式无效`)
  return value.trim()
}
export function encode(value, max = 16_384) {
  const encoded = JSON.stringify(value)
  check(encoded && Buffer.byteLength(encoded) <= max, 'JSON 超出大小限制')
  return encoded
}
export function openDb(root, name, schema) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path.join(root, name + '.sqlite'))
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;')
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
