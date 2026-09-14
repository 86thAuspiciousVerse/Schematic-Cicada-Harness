import { readFileSync } from 'node:fs'

/**
 * Tavily MCP overlay (docs/04 §5.3): datasheet hunting is the one pipeline step
 * where a plain web search is often not enough, because vendor PDFs hide behind
 * search results. Tavily is an OPTIONAL second search channel.
 *
 * Why a generated `--patch` file instead of a row in `cicada-app`'s
 * cordis.patch.yml:
 *  - an `insert:` row in an overlay cannot carry `!!js` (measured: the loader
 *    refuses the tag there, and one bad tag fails the whole profile), so the row
 *    cannot read the environment itself;
 *  - the endpoint URL embeds the credential, which must never enter a tracked
 *    file (AGENTS §1).
 *
 * So the launcher renders the overlay at runtime from `TAVILY_API_KEY` and adds
 * it to the host argv. No key = no file = the product behaves exactly as before.
 */

/** Tavily's Streamable HTTP endpoint; the documented query-parameter form. */
export const TAVILY_MCP_ENDPOINT = 'https://mcp.tavily.com/mcp/'

/** Name of the generated overlay inside the DSH home. */
export const TAVILY_PATCH_FILE = 'tavily.patch.yml'

/**
 * Render the overlay that mounts Tavily as an MCP server.
 *
 * The key is embedded in a URL, so the caller MUST treat both the returned text
 * and the file it writes as credentials: never log them, never commit them.
 * @param apiKey - Tavily API key (`tvly-…`).
 * @returns cordis patch-list YAML text.
 */
export function renderTavilyPatch(apiKey: string): string {
  const url = `${TAVILY_MCP_ENDPOINT}?tavilyApiKey=${encodeURIComponent(apiKey)}`
  return [
    '# GENERATED at launch by cicada-launcher — contains a credential.',
    '# Do not commit, do not paste into logs or chat. Deleting it (or unsetting',
    '# TAVILY_API_KEY) simply removes the optional Tavily search channel.',
    '- insert:',
    '    - id: mcp-tavily',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: streamable-http',
    '        serverName: tavily',
    `        url: '${url}'`,
    '        toolCallTimeoutMs: 120000',
    // Search is a convenience, not a gate: a flaky endpoint must not stop the
    // product from booting (the client retries per its reconnect policy).
    '        failOnStartupError: false',
    '',
  ].join('\n')
}

/** Row id the launcher would insert (also the id a user layer would use). */
export const TAVILY_ROW_ID = 'mcp-tavily'

/**
 * Does a user patch layer already define the Tavily row?
 *
 * A user is free to configure Tavily by hand (the dev profile did exactly that,
 * with `failOnStartupError: true`); inserting a second row with the same id
 * fails the whole plugin tree ("duplicate loader entry id"), so the launcher
 * defers to whatever the user already wrote and only generates the overlay when
 * nobody did.
 * @param files - user patch files to inspect (missing ones are ignored).
 * @param readFile - `readFileSync` override for tests.
 * @returns true when any readable file declares the row id.
 */
export function userLayerDefinesTavily(files: readonly string[], readFile: (path: string) => string = defaultRead): boolean {
  const pattern = new RegExp(`^\\s*-\\s*id:\\s*${TAVILY_ROW_ID}\\s*$`, 'm')
  return files.some((file) => {
    try {
      return pattern.test(readFile(file))
    } catch {
      // Unreadable/absent layer = it cannot declare the row.
      return false
    }
  })
}

/** Default reader, kept out of the signature so tests can inject one. */
function defaultRead(path: string): string {
  return readFileSync(path, 'utf8')
}
