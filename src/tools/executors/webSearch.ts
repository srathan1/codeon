import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor'

/** Default maximum number of results to return */
const DEFAULT_MAX_RESULTS = 10

/** Maximum allowed maxResults value */
const MAX_ALLOWED_RESULTS = 50

/** Request timeout in milliseconds */
const TIMEOUT_MS = 30_000

/**
 * A single search result (normalised across all providers).
 */
interface SearchResult {
    title: string
    url: string
    snippet: string
}

// ---------------------------------------------------------------------------
// Configuration — read from VS Code settings or environment variables
// ---------------------------------------------------------------------------

interface SearchConfig {
    /** Ordered list of providers to try. First successful one wins. */
    providerOrder: string[]
    /** Brave Search API key (free tier: 2000 queries/month) */
    braveApiKey?: string
    /** Serper (Google) API key */
    serperApiKey?: string
    /** SearXNG instance URL (self-hosted or public) */
    searxngUrl?: string
}

function loadSearchConfig(): SearchConfig {
    // Layer 1: Environment variables (highest priority)
    const braveApiKeyEnv = process.env.BRAVE_SEARCH_API_KEY || ''
    const serperApiKeyEnv = process.env.SERPER_API_KEY || ''
    const searxngUrlEnv = process.env.SEARXNG_URL || ''
    const providerEnv = process.env.SEARCH_PROVIDER || ''

    // Layer 2: VS Code settings (fallback)
    let braveApiKeySetting = ''
    let serperApiKeySetting = ''
    let searxngUrlSetting = ''
    let providerSetting = ''

    try {
        const config = vscode.workspace.getConfiguration('codeon')
        braveApiKeySetting = config.get<string>('braveSearchApiKey') || ''
        serperApiKeySetting = config.get<string>('serperApiKey') || ''
        searxngUrlSetting = config.get<string>('searxngUrl') || ''
        providerSetting = config.get<string>('searchProvider') || ''
    } catch {
        // Not running in VS Code context (e.g., tests)
    }

    // Env vars override VS Code settings
    const braveApiKey = braveApiKeyEnv || braveApiKeySetting
    const serperApiKey = serperApiKeyEnv || serperApiKeySetting
    const searxngUrl = searxngUrlEnv || searxngUrlSetting
    const providerOverride = providerEnv || providerSetting

    if (providerOverride) {
        return {
            providerOrder: providerOverride.split(',').map(s => s.trim()).filter(Boolean),
            braveApiKey: braveApiKey || undefined,
            serperApiKey: serperApiKey || undefined,
            searxngUrl: searxngUrl || undefined,
        }
    }

    // Auto-detect: build provider order from available keys
    const available: string[] = []
    if (braveApiKey) available.push('brave')
    if (serperApiKey) available.push('serper')
    if (searxngUrl) available.push('searxng')
    // DDG is always available as last resort (no key needed)
    available.push('duckduckgo')

    return {
        providerOrder: available,
        braveApiKey: braveApiKey || undefined,
        serperApiKey: serperApiKey || undefined,
        searxngUrl: searxngUrl || undefined,
    }
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

type SearchProvider = (query: string, maxResults: number, config: SearchConfig) => Promise<SearchResult[]>

/**
 * Brave Search API — free tier available at https://api.brave.com/search/v1/web
 * Returns clean JSON with no scraping needed.
 */
async function searchBrave(query: string, maxResults: number, config: SearchConfig): Promise<SearchResult[]> {
    if (!config.braveApiKey) throw new Error('MISSING_API_KEY: BRAVE_SEARCH_API_KEY is required for Brave Search')

    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(maxResults, 20)))

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
        const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': config.braveApiKey!,
            },
        })

        if (!response.ok) {
            throw new Error(`HTTP_${response.status}: ${response.statusText}`)
        }

        const data = await response.json()
        const results: SearchResult[] = []

        for (const item of (data.web?.results || []).slice(0, maxResults)) {
            results.push({
                title: item.title || 'Untitled',
                url: item.url || '',
                snippet: item.description || '',
            })
        }

        return results
    } finally {
        clearTimeout(timeoutId)
    }
}

/**
 * Serper (Google Search API wrapper) — https://serper.dev
 * Returns Google search results as JSON.
 */
async function searchSerper(query: string, maxResults: number, config: SearchConfig): Promise<SearchResult[]> {
    if (!config.serperApiKey) throw new Error('MISSING_API_KEY: SERPER_API_KEY is required for Serper (Google) search')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
        const response = await fetch('https://google.serper.dev/search', {
            signal: controller.signal,
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-API-KEY': config.serperApiKey!,
            },
            body: JSON.stringify({
                q: query,
                num: Math.min(maxResults, 10),
            }),
        })

        if (!response.ok) {
            throw new Error(`HTTP_${response.status}: ${response.statusText}`)
        }

        const data = await response.json()
        const results: SearchResult[] = []

        for (const item of (data.organic || []).slice(0, maxResults)) {
            results.push({
                title: item.title || 'Untitled',
                url: item.link || '',
                snippet: item.snippet || '',
            })
        }

        return results
    } finally {
        clearTimeout(timeoutId)
    }
}

/**
 * SearXNG — self-hosted metasearch engine.
 * Supports JSON output when enabled on the instance.
 */
async function searchSearXNG(query: string, maxResults: number, config: SearchConfig): Promise<SearchResult[]> {
    if (!config.searxngUrl) throw new Error('MISSING_CONFIG: SEARXNG_URL is required for SearXNG search')

    let baseUrl = config.searxngUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&number_of_results=${Math.min(maxResults, 20)}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' },
        })

        if (!response.ok) {
            throw new Error(`HTTP_${response.status}: ${response.statusText}`)
        }

        const data = await response.json()
        const results: SearchResult[] = []

        for (const item of (data.results || []).slice(0, maxResults)) {
            results.push({
                title: item.title || 'Untitled',
                url: item.url || '',
                snippet: item.content || '',
            })
        }

        return results
    } finally {
        clearTimeout(timeoutId)
    }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML search (legacy fallback — no API key needed but fragile)
// ---------------------------------------------------------------------------

const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/'

function extractBody(html: string): string {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
    if (bodyMatch) return bodyMatch[1]
    const htmlTag = html.match(/<html[^>]*>([\s\S]*)<\/html>/i)
    if (htmlTag) return htmlTag[1]
    return html
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function stripTags(html: string): string {
    let text = html.replace(/<[^>]+>/g, ' ')
    text = decodeHtmlEntities(text)
    text = text.replace(/\s+/g, ' ').trim()
    return text
}

function parseDdgResults(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = []
    const body = extractBody(html)

    const resultRegex = /<div\s+class="result"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|hr)/gi

    let match: RegExpExecArray | null
    while ((match = resultRegex.exec(body)) && results.length < maxResults) {
        const resultHtml = match[1]

        let title = ''
        let url = ''

        const linkMatch = resultHtml.match(/<a\s+class="result__a"[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i)
        if (linkMatch) {
            url = linkMatch[1]
            title = stripTags(linkMatch[2])
        } else {
            const lnMatch = resultHtml.match(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i)
            if (lnMatch) {
                url = lnMatch[1]
                title = stripTags(lnMatch[2])
            }
        }

        let snippet = ''
        const snippetMatch = resultHtml.match(/<a\s+class="snippet"[^>]*>([\s\S]*?)<\/a>/i)
        if (snippetMatch) {
            snippet = stripTags(snippetMatch[1])
        } else {
            const snippetDivMatch = resultHtml.match(/class="snippet"[^>]*>([\s\S]*?)(?:<\/(?:a|div)>|$)/i)
            if (snippetDivMatch) {
                snippet = stripTags(snippetDivMatch[1])
            }
        }

        if (!url && !title) continue

        if (url.startsWith('/')) {
            const rdMatch = url.match(/[?&]rd=([^&]+)/)
            if (rdMatch) {
                url = decodeURIComponent(rdMatch[1])
            }
        }

        if (url.includes('duckduckgo.com/') && !url.includes('//')) continue
        if (url.includes('abstract.html')) continue

        results.push({ title, url, snippet })
    }

    return results.slice(0, maxResults)
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    const encodedQuery = encodeURIComponent(query)
    const searchUrl = `${DDG_SEARCH_URL}?q=${encodedQuery}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
        const response = await fetch(searchUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
            },
        })

        if (!response.ok) {
            throw new Error(`HTTP_${response.status}: ${response.statusText}`)
        }

        const html = await response.text()

        // Check if DDG returned a CAPTCHA / blocked page
        if (html.includes('DC:LABelframe') ||
            html.includes('Just a moment') ||
            html.includes('Enable JavaScript and cookies to continue') ||
            (html.includes('security check') && html.includes('Cloudflare'))) {
            throw new Error('BLOCKED_BY_DDG')
        }

        return parseDdgResults(html, maxResults)
    } finally {
        clearTimeout(timeoutId)
    }
}

// ---------------------------------------------------------------------------
// Provider registry and fallback chain
// ---------------------------------------------------------------------------

const PROVIDERS: Record<string, SearchProvider> = {
    brave: searchBrave,
    serper: searchSerper,
    searxng: searchSearXNG,
    duckduckgo: searchDuckDuckGo,
}

/**
 * Execute search through the configured provider chain until one returns results.
 * Collects errors from each failed provider to report to the user.
 */
async function searchWithFallback(query: string, maxResults: number, config: SearchConfig): Promise<{ results: SearchResult[]; errors: string[]; usedProvider: string }> {
    const errors: string[] = []
    const providersToTry = config.providerOrder.length > 0 ? config.providerOrder : ['duckduckgo']

    for (const providerName of providersToTry) {
        const providerFn = PROVIDERS[providerName]
        if (!providerFn) {
            errors.push(`${providerName}: unknown provider`)
            continue
        }

        try {
            const results = await providerFn(query, maxResults, config)
            if (results.length > 0) {
                return { results, errors, usedProvider: providerName }
            }
            errors.push(`${providerName}: no results returned`)
        } catch (e) {
            const msg = (e as Error).message
            errors.push(`${providerName}: ${msg}`)
        }
    }

    return { results: [], errors, usedProvider: '(none)' }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatResults(query: string, results: SearchResult[], usedProvider: string): string {
    if (results.length === 0) {
        return `No results found for query: "${query}"\n\nTip: Try rephrasing your search query or use more specific keywords.`
    }

    const lines: string[] = [
        `Search results for: "${query}" (${results.length} results, via ${usedProvider})`,
        '',
    ]

    for (let i = 0; i < results.length; i++) {
        const r = results[i]
        lines.push(`[${i + 1}] ${r.title || 'Untitled'}`)
        lines.push(`    URL: ${r.url || 'N/A'}`)
        if (r.snippet) {
            lines.push(`    ${r.snippet}`)
        }
        lines.push('')
    }

    // Include raw JSON for programmatic consumption
    const jsonOutput = JSON.stringify(results, null, 2)
    lines.push('--- Raw JSON ---')
    lines.push(jsonOutput)

    return lines.join('\n')
}

function formatErrors(query: string, errors: string[]): string {
    return [
        `No results found for query: "${query}"`,
        '',
        'All search providers failed:',
        ...errors.map(e => `  - ${e}`),
        '',
        'To configure a working search provider:',
        '  1. Set BRAVE_SEARCH_API_KEY env var (free at https://api.brave.com)',
        '  2. Or set SERPER_API_KEY env var (free tier at https://serper.dev)',
        '  3. Or set SEARXNG_URL env var (self-hosted or public instance)',
        '  4. Or set SEARCH_PROVIDER=brave,serper,duckduckgo to control order',
    ].join('\n')
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Search the public web using a pluggable provider system.
 *
 * Providers (in default priority order):
 * 1. Brave Search API (BRAVE_SEARCH_API_KEY) — reliable, free tier available
 * 2. Serper / Google (SERPER_API_KEY) — Google results via API
 * 3. SearXNG (SEARXNG_URL) — self-hosted metasearch
 * 4. DuckDuckGo HTML (no key) — legacy fallback, fragile
 *
 * Configure via environment variables or setSearchConfig().
 */
export class WebSearchExecutor implements ToolExecutor {
    public name = 'web_search'
    private _config?: SearchConfig

    /** Override config programmatically (e.g., from VS Code settings) */
    public setSearchConfig(config: Partial<SearchConfig>): void {
        const current = this._config || loadSearchConfig()
        this._config = { ...current, ...config }
        // Rebuild provider order if individual fields changed
        if (!this._config.providerOrder || this._config.providerOrder.length === 0) {
            const available: string[] = []
            if (this._config.braveApiKey) available.push('brave')
            if (this._config.serperApiKey) available.push('serper')
            if (this._config.searxngUrl) available.push('searxng')
            available.push('duckduckgo')
            this._config.providerOrder = available
        }
    }

    /**
     * Execute the web_search tool.
     *
     * @param args - `{ query: string, maxResults?: number }`
     */
    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const query = String(args.query || '').trim()

        if (!query) {
            return { success: false, output: '', error: 'MISSING_PARAMETER: query is required' }
        }

        let maxResults: number
        if (args.maxResults !== undefined) {
            maxResults = Number(args.maxResults)
            if (!Number.isInteger(maxResults) || maxResults < 1) {
                maxResults = DEFAULT_MAX_RESULTS
            }
        } else {
            maxResults = DEFAULT_MAX_RESULTS
        }
        maxResults = Math.min(maxResults, MAX_ALLOWED_RESULTS)

        const config = this._config || loadSearchConfig()

        try {
            const { results, errors, usedProvider } = await searchWithFallback(query, maxResults, config)

            if (results.length > 0) {
                return { success: true, output: formatResults(query, results, usedProvider) }
            }

            return { success: true, output: formatErrors(query, errors) }
        } catch (e) {
            const err = e as Error
            return {
                success: false,
                output: '',
                error: buildErrorMessage(err.message),
            }
        }
    }
}

/**
 * Build a user-friendly error message based on the failure mode.
 */
function buildErrorMessage(rawError: string): string {
    if (rawError.includes('abort') || rawError.includes('timeout')) {
        return `SEARCH_FAILED: Request timed out after ${TIMEOUT_MS / 1000}s. Check your network connection.`
    }

    return `SEARCH_FAILED: ${rawError}`
}
