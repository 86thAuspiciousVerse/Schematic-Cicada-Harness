/**
 * MinerU v4 「精准解析」client with injected `fetch` (single-testable, zero
 * network in unit tests). `token` comes from the caller (settings-first, env
 * fallback at the wiring point — see {@link ./index.ts}).
 *
 * Contract per the vendor's v4 doc: `POST /extract/task` with
 * `{url, model_version}` → poll `GET /extract/task/{id}` until `state: "done"`
 * → download `full_zip_url` and read the markdown out of that archive. (An
 * earlier revision of this client waited for a `finish` state and fetched a
 * `/result` markdown endpoint; neither exists, so every extraction polled until
 * its 10-minute timeout.)
 */

/** Submit/poll/extract response envelope of the MinerU v4 HTTP API. */
export interface MineruEnvelope<T> {
  code: number
  msg: string
  data: T
}

export interface MineruSubmitData {
  task_id: string
}

export interface MineruTaskData {
  task_id: string
  /** Vendor states: `waiting` / `running` / `done` / `failed`. */
  state: 'waiting' | 'running' | 'done' | 'failed' | (string & {})
  err_msg?: string
  full_zip_url?: string
  extract_progress?: { extracted_pages?: number; total_pages?: number; start_time?: string }
}

/** What this lane records next to `full.md` for traceability. */
export interface MineruResultData {
  task_id: string
  state: string
  full_zip_url: string
  pages?: number
  archive_files: string[]
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
    arrayBuffer(): Promise<ArrayBuffer>
  }>
}

import { markdownOf, readZip } from './zip.ts'

/** Protocol constants (fixed; not deployment config). */
export const MINERU_BASE_URL = 'https://mineru.net/api/v4'
export const MINERU_SUBMIT_PATH = '/extract/task'
export const MINERU_TASK_PATH = '/extract/task'
/** 精准解析 model: `vlm` (accurate) / `pipeline` (fast) / `MinerU-HTML`. */
export const MINERU_MODEL_VERSION = 'vlm'

/** One MinerU v4 conversion job. */
export class MineruClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly token: string | undefined,
    private readonly baseUrl: string = MINERU_BASE_URL,
    /** Delay between progress polls (injectable so tests do not sleep 5s). */
    private readonly pollIntervalMs = 5000,
  ) {}

  private assertToken(): string {
    if (this.token === undefined || this.token === '') {
      throw new Error('mineru_extract: MinerU token is not configured (settings `mineru.token` or MINERU_TOKEN)')
    }
    return this.token
  }

  private async request<T>(path: string, init?: { method?: string; body?: string }): Promise<MineruEnvelope<T>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.assertToken()}` },
      ...init?.body !== undefined ? { body: init.body } : {},
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { code: -1, msg: text, data: null }
    }
    const envelope = parsed as MineruEnvelope<T>
    if (typeof envelope.code !== 'number' || typeof envelope.msg !== 'string') {
      throw new Error(`mineru_extract: malformed response (status ${response.status})`)
    }
    if (envelope.code !== 0) {
      throw new Error(`mineru_extract: MinerU error ${envelope.code}: ${envelope.msg}`)
    }
    return envelope
  }

  /**
   * Submit a document URL for extraction.
   * @param url - public document URL (the vendor fetches it).
   * @returns the task id to poll.
   */
  async submit(url: string): Promise<string> {
    const envelope = await this.request<MineruSubmitData>(MINERU_SUBMIT_PATH, {
      method: 'POST',
      body: JSON.stringify({ url, model_version: MINERU_MODEL_VERSION }),
    })
    return envelope.data.task_id
  }

  /** Poll a job's state. */
  async poll(taskId: string): Promise<MineruTaskData> {
    const envelope = await this.request<MineruTaskData>(`${MINERU_TASK_PATH}/${taskId}`)
    return envelope.data
  }

  /** Download the result archive of a finished job. */
  private async archive(fullZipUrl: string): Promise<Buffer> {
    // The archive URL is pre-signed by the vendor: no Authorization header.
    const response = await this.fetchImpl(fullZipUrl)
    if (!response.ok) throw new Error(`mineru_extract: result archive download failed (status ${response.status})`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** Read the markdown plus its traceability metadata out of one finished job. */
  private async extract(task: MineruTaskData): Promise<{ fullMd: string; meta: MineruResultData }> {
    const fullZipUrl = task.full_zip_url
    if (fullZipUrl === undefined || fullZipUrl === '') {
      throw new Error('mineru_extract: finished job carries no full_zip_url')
    }
    const entries = readZip(await this.archive(fullZipUrl))
    const markdown = markdownOf(entries)
    if (markdown === undefined) {
      throw new Error(`mineru_extract: result archive carries no markdown (files: ${entries.map((entry) => entry.name).join(', ') || 'none'})`)
    }
    const pages = task.extract_progress?.total_pages
    return {
      fullMd: markdown.data.toString('utf8'),
      meta: {
        task_id: task.task_id,
        state: task.state,
        full_zip_url: fullZipUrl,
        ...pages === undefined ? {} : { pages },
        archive_files: entries.map((entry) => entry.name),
      },
    }
  }

  /**
   * Submit, poll to completion, and read the markdown (bounded wait).
   * @param url - public document URL.
   * @param timeoutMs - overall budget (default 10 minutes).
   * @returns the markdown and its metadata.
   */
  async run(url: string, timeoutMs = 600000): Promise<{ fullMd: string; meta: MineruResultData }> {
    const taskId = await this.submit(url)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const task = await this.poll(taskId)
      if (task.state === 'done' || task.state === 'finish') return this.extract(task)
      if (task.state === 'failed') throw new Error(`mineru_extract: job failed (${task.err_msg ?? 'unknown'})`)
      if (Date.now() > deadline) throw new Error(`mineru_extract: job timed out in state "${task.state}"`)
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
    }
  }
}
