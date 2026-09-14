import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { markdownOf, readZip } from '../src/zip.ts'

/** Build a ZIP with the given members (deflated when that is smaller). */
function zipOf(files: { name: string; text: string }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.text, 'utf8')
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

describe('MinerU result archive reader', () => {
  it('reads deflated and stored members', () => {
    const archive = zipOf([
      { name: 'full.md', text: '# NE555P\n'.repeat(40) },
      { name: 'images/page-1.png', text: 'x' },
      { name: 'layout.json', text: '{"pages":1}' },
    ])
    const entries = readZip(archive)
    expect(entries.map((entry) => entry.name)).toEqual(['full.md', 'images/page-1.png', 'layout.json'])
    expect(entries[0]?.data.toString('utf8')).toContain('# NE555P')
    expect(entries[2]?.data.toString('utf8')).toBe('{"pages":1}')
  })

  it('picks full.md, then the largest markdown member', () => {
    expect(markdownOf(readZip(zipOf([{ name: 'doc.md', text: 'a'.repeat(500) }, { name: 'full.md', text: 'short' }])))?.name).toBe('full.md')
    expect(markdownOf(readZip(zipOf([{ name: 'a.md', text: 'aaa' }, { name: 'b.md', text: 'b'.repeat(50) }])))?.name).toBe('b.md')
    expect(markdownOf(readZip(zipOf([{ name: 'layout.json', text: '{}' }])))).toBeUndefined()
  })

  it('fails loud on a non-ZIP payload and on Zip64 markers', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/not a ZIP/)
    const archive = zipOf([{ name: 'full.md', text: 'x' }])
    archive.writeUInt32LE(0xffffffff, archive.length - 22 + 16)
    expect(() => readZip(archive)).toThrow(/Zip64/)
  })
})
