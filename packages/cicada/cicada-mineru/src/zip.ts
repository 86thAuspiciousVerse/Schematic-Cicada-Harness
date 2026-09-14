/**
 * Minimal ZIP reader for the MinerU result archive (stored + deflate entries).
 *
 * Deliberately dependency-free: this lane needs one text file out of an archive
 * produced by one trusted service, and pulling in a zip dependency would change
 * this package's dependency footprint for that single read. Sizes and offsets
 * come from the central directory, so entries written with a streaming data
 * descriptor (zeroed local header) still resolve; Zip64 archives fail loud
 * instead of returning wrong bytes.
 */

import { inflateRawSync } from 'node:zlib'

/** One archive member. */
export interface ZipEntry {
  /** Path inside the archive (`images/x.png`, `full.md`, …). */
  name: string
  data: Buffer
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff
/** EOCD is at most 22 bytes + a 64 KiB comment. */
const MAX_EOCD_SEARCH = 22 + 0xffff

/** Offset of the end-of-central-directory record, or undefined when absent. */
function findEocd(buffer: Buffer): number | undefined {
  const from = Math.max(0, buffer.length - MAX_EOCD_SEARCH)
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at
  }
  return undefined
}

/**
 * Read every member of a ZIP archive.
 * @param buffer - the complete archive bytes.
 * @returns members in central-directory order.
 * @throws when the archive is truncated, Zip64, or uses an unsupported method.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer)
  if (eocd === undefined) throw new Error('mineru_extract: result archive is not a ZIP file')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === ZIP64_MARKER || count === 0xffff) {
    throw new Error('mineru_extract: Zip64 result archives are not supported')
  }
  const entries: ZipEntry[] = []
  let at = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error('mineru_extract: corrupt ZIP central directory')
    }
    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    if (compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new Error('mineru_extract: Zip64 result archives are not supported')
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`mineru_extract: corrupt ZIP entry header for ${name}`)
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (name.endsWith('/')) continue
    if (method === 0) entries.push({ name, data: Buffer.from(raw) })
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) })
    else throw new Error(`mineru_extract: unsupported ZIP compression method ${method} for ${name}`)
  }
  return entries
}

/**
 * The markdown member of a MinerU archive: `full.md` when present, otherwise the
 * largest `.md` entry (the document body).
 * @param entries - archive members.
 * @returns the chosen member, or undefined when the archive carries no markdown.
 */
export function markdownOf(entries: ZipEntry[]): ZipEntry | undefined {
  const markdown = entries.filter((entry) => entry.name.toLowerCase().endsWith('.md'))
  if (markdown.length === 0) return undefined
  return markdown.find((entry) => entry.name.toLowerCase().endsWith('full.md'))
    ?? markdown.reduce((best, entry) => (entry.data.length > best.data.length ? entry : best))
}
