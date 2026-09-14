import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { FetchLike, MineruClient } from '../src/client.ts'

/** One stored (uncompressed) ZIP member; enough for the reader under test. */
function storedZip(files: { name: string; text: string }[]): Buffer {
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

interface Route {
  /** Envelope JSON for API paths, raw bytes for the archive URL. */
  json?: unknown
  bytes?: Buffer
}

/** Scripted fetch double: routes by URL + method, never touches the network. */
function scriptedFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: string[]; bodies: string[] } {
  const calls: string[] = []
  const bodies: string[] = []
  return {
    calls,
    bodies,
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (init?.body !== undefined) bodies.push(init.body)
      const hit = Object.entries(routes).find(([key]) => url.endsWith(key))
      if (hit === undefined) throw new Error(`unexpected request: ${url}`)
      const route = hit[1]
      const bytes = route.bytes
      const text = JSON.stringify(route.json ?? {})
      return {
        ok: true,
        status: 200,
        json: async () => route.json ?? {},
        text: async () => text,
        arrayBuffer: async () => {
          if (bytes === undefined) throw new Error(`no bytes for ${url}`)
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        },
      }
    },
  }
}

const envelope = <T>(data: T): unknown => ({ code: 0, msg: 'ok', data })

describe('MineruClient (injected fetch, zero network)', () => {
  it('submits the URL for accurate parsing and returns the task id', async () => {
    const { fetch, calls, bodies } = scriptedFetch({
      '/extract/task': { json: envelope({ task_id: 't1' }) },
    })
    const client = new MineruClient(fetch, 'tok')
    expect(await client.submit('https://example.com/ds.pdf')).toBe('t1')
    expect(calls[0]).toContain('POST')
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ url: 'https://example.com/ds.pdf', model_version: 'vlm' })
  })

  it('polls to state "done" and reads the markdown out of the result archive', async () => {
    const archive = storedZip([
      { name: 'full.md', text: '# NE555P\npin 1 GND\n' },
      { name: 'layout.json', text: '{"pages":8}' },
    ])
    const { fetch, calls } = scriptedFetch({
      '/extract/task': { json: envelope({ task_id: 't1' }) },
      '/extract/task/t1': { json: envelope({ task_id: 't1', state: 'done', full_zip_url: 'https://cdn.example/out.zip', extract_progress: { total_pages: 8 } }) },
      'https://cdn.example/out.zip': { bytes: archive },
    })
    const client = new MineruClient(fetch, 'tok')
    const { fullMd, meta } = await client.run('https://example.com/ds.pdf')
    expect(fullMd).toContain('NE555P')
    expect(meta.state).toBe('done')
    expect(meta.pages).toBe(8)
    expect(meta.archive_files).toEqual(['full.md', 'layout.json'])
    expect(calls.at(-1)).toBe('GET https://cdn.example/out.zip')
  })

  it('polls through running states before finishing', async () => {
    let polls = 0
    const archive = storedZip([{ name: 'full.md', text: '# body' }])
    const reply = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => envelope(data),
      text: async () => JSON.stringify(envelope(data)),
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    const fetch: FetchLike = async (url) => {
      if (url.endsWith('/extract/task')) return reply({ task_id: 't9' })
      if (url.endsWith('/extract/task/t9')) {
        polls += 1
        return reply(polls < 2
          ? { task_id: 't9', state: 'running', extract_progress: { extracted_pages: 1, total_pages: 4 } }
          : { task_id: 't9', state: 'done', full_zip_url: 'https://cdn.example/out.zip' })
      }
      const bytes = archive
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
    }
    const client = new MineruClient(fetch, 'tok', undefined, 5)
    const { fullMd } = await client.run('https://example.com/ds.pdf')
    expect(fullMd).toBe('# body')
    expect(polls).toBe(2)
  })

  it('fails loud on a non-zero envelope code', async () => {
    const { fetch } = scriptedFetch({ '/extract/task': { json: { code: 4020, msg: 'bad token', data: null } } })
    const client = new MineruClient(fetch, 'tok')
    await expect(client.submit('https://example.com/ds.pdf')).rejects.toThrow(/bad token/)
  })

  it('fails loud when no token is configured', async () => {
    const client = new MineruClient(async () => { throw new Error('unreachable') }, undefined)
    await expect(client.submit('https://example.com/ds.pdf')).rejects.toThrow(/token/i)
  })

  it('fails loud on job failure and on a finished job without a usable archive', async () => {
    const failed = scriptedFetch({
      '/extract/task': { json: envelope({ task_id: 't1' }) },
      '/extract/task/t1': { json: envelope({ task_id: 't1', state: 'failed', err_msg: 'parse error' }) },
    })
    await expect(new MineruClient(failed.fetch, 'tok').run('https://example.com/ds.pdf')).rejects.toThrow(/parse error/)

    const noArchive = scriptedFetch({
      '/extract/task': { json: envelope({ task_id: 't2' }) },
      '/extract/task/t2': { json: envelope({ task_id: 't2', state: 'done' }) },
    })
    await expect(new MineruClient(noArchive.fetch, 'tok').run('https://example.com/ds.pdf')).rejects.toThrow(/full_zip_url/)

    const noMarkdown = scriptedFetch({
      '/extract/task': { json: envelope({ task_id: 't3' }) },
      '/extract/task/t3': { json: envelope({ task_id: 't3', state: 'done', full_zip_url: 'https://cdn.example/out.zip' }) },
      'https://cdn.example/out.zip': { bytes: storedZip([{ name: 'layout.json', text: '{}' }]) },
    })
    await expect(new MineruClient(noMarkdown.fetch, 'tok').run('https://example.com/ds.pdf')).rejects.toThrow(/no markdown/)
  })
})
