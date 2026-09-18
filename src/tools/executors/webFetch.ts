import * as dns from 'dns'
import * as net from 'net'
import { ToolExecutor, ToolResult } from '../toolExecutor'

/** Maximum response body size: 5 MB */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/** Maximum number of redirects to follow */
const MAX_REDIRECTS = 5

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// SSRF protection — private / reserved / cloud-metadata address ranges
// ---------------------------------------------------------------------------

/**
 * Pre-computed CIDR entries for SSRF protection.
 * Each entry is a [networkPrefixBits, maskAsBigInt] pair so we can do fast bitwise checks.
 */
interface CidrEntry {
    /** Number of prefix bits (e.g. 8 for /8) */
    prefixLen: number
    /** Network address as BigInt (host-order bytes converted) */
    network: bigint
}

/** IPv4 private / reserved ranges */
const IPV4_BLOCKLIST: CidrEntry[] = [
    makeCidr('10.0.0.0', 8),
    makeCidr('172.16.0.0', 12),
    makeCidr('192.168.0.0', 16),
    makeCidr('127.0.0.0', 8),
    makeCidr('169.254.0.0', 16), // link-local
    makeCidr('0.0.0.0', 8),      // current network
    makeCidr('100.64.0.0', 10),  // carrier-grade NAT
    makeCidr('198.18.0.0', 15),  // benchmarking
    makeCidr('224.0.0.0', 4),    // multicast + reserved
]

/** IPv6 private / reserved ranges */
const IPV6_BLOCKLIST: CidrEntry[] = [
    makeCidr6('::1', 128),         // loopback
    makeCidr6('fc00::', 7),        // unique local + global unicast (ULA)
    makeCidr6('fe80::', 10),       // link-local
    makeCidr6('::', 128),          // unspecified
    makeCidr6('ff00::', 8),        // multicast
]

/** Known cloud metadata hostnames (case-insensitive substring match) */
const CLOUD_METADATA_HOSTNAMES = [
    '169.254.169.254',
    'metadata.google.internal',
    'instance-data.preset-env.io',
    'vault.hashicorp.com',
]

/**
 * Build a CidrEntry from dotted-quad string and prefix length.
 */
function makeCidr(addr: string, prefixLen: number): CidrEntry {
    const parts = addr.split('.').map(Number)
    const ipNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
    return { prefixLen, network: BigInt(ipNum) }
}

/**
 * Build a CidrEntry from an IPv6 string and prefix length.
 */
function makeCidr6(addr: string, prefixLen: number): CidrEntry {
    const expanded = expandIPv6(addr)
    let n = 0n
    for (const chunk of expanded) {
        n = (n << 16n) | BigInt(chunk)
    }
    return { prefixLen, network: n }
}

/** Expand a short IPv6 notation into 8 groups of hex numbers. */
function expandIPv6(addr: string): number[] {
    let result = addr.split(':')
    if (result.includes('')) {
        // :: expansion
        const left = result.indexOf('')
        const right = result.lastIndexOf('')
        const missing = 8 - (result.length - (right - left))
        const filler = Array(missing).fill('0')
        result.splice(left, right - left + 1, ...filler)
    }
    return result.map(h => parseInt(h, 16))
}

/**
 * Check whether an IPv4 address falls into any blocked range.
 */
function isIpv4Blocked(ip: string): boolean {
    const parts = ip.split('.').map(Number)
    const ipNum = BigInt((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3])
    for (const entry of IPV4_BLOCKLIST) {
        const mask = ~(0n << BigInt(entry.prefixLen)) & ((1n << 32n) - 1n)
        if ((ipNum & mask) === entry.network) return true
    }
    return false
}

/**
 * Check whether an IPv6 address falls into any blocked range.
 */
function isIpv6Blocked(ip: string): boolean {
    const expanded = expandIPv6(ip)
    let ipNum = 0n
    for (const chunk of expanded) {
        ipNum = (ipNum << 16n) | BigInt(chunk)
    }
    for (const entry of IPV6_BLOCKLIST) {
        const mask = ~(0n << BigInt(entry.prefixLen)) & ((1n << 128n) - 1n)
        if ((ipNum & mask) === entry.network) return true
    }
    return false
}

/**
 * Determine if a hostname resolves to a private or otherwise forbidden address.
 * Performs DNS lookup and checks every returned address.
 */
async function isForbiddenHost(hostname: string): Promise<boolean> {
    // Check well-known cloud metadata hostnames first (no DNS needed)
    const lower = hostname.toLowerCase()
    if (CLOUD_METADATA_HOSTNAMES.some(h => lower === h || lower.endsWith('.' + h))) {
        return true
    }

    // Block localhost variants
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
        return true
    }

    try {
        const addresses = await new Promise<string[]>((resolve, reject) => {
            // Try both IPv4 and IPv6
            const timers: NodeJS.Timeout[] = []
            let settled = false
            const results: string[] = []

            function done() {
                if (!settled) {
                    settled = true
                    timers.forEach(t => clearTimeout(t))
                    resolve(results)
                }
            }

            // IPv4
            const t4 = setTimeout(() => {
                if (!settled) { settled = true; timers.forEach(t => clearTimeout(t)); resolve([]) }
            }, 5000)
            timers.push(t4)

            net.isIP('0.0.0.0') // warm-up

            dns.lookup(hostname, { all: true }, (err: Error | null, addresses: dns.LookupAddress[]) => {
                if (err) {
                    // If DNS fails, we allow it — the actual fetch will fail anyway
                    done()
                    return
                }
                for (const a of addresses) results.push(a.address)
                done()
            })
        })

        for (const addr of addresses) {
            const version = net.isIP(addr)
            if (version === 4 && isIpv4Blocked(addr)) return true
            if (version === 6 && isIpv6Blocked(addr)) return true
        }
    } catch {
        // DNS resolution error — let the fetch fail naturally
    }

    return false
}

// ---------------------------------------------------------------------------
// HTML → plain-text helper
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and normalise whitespace to produce readable plain text.
 */
function htmlToPlainText(html: string): string {
    // Remove script and style blocks
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '')

    // Replace common block-level tags with newlines
    text = text.replace(/<(?:br|hr|div|p|li|h[1-6]|table|tr|ul|ol|blockquote|pre|section|article|header|footer|nav)[^>]*>/gi, '\n')
    text = text.replace(/<\/(?:div|p|li|h[1-6]|table|tr|ul|ol|blockquote|pre|section|article|header|footer|nav)>/gi, '\n')

    // Strip remaining tags
    text = text.replace(/<[a-zA-Z][^>]*>/g, '')

    // Decode common HTML entities
    text = text.replace(/&nbsp;/g, ' ')
    text = text.replace(/&lt;/g, '<')
    text = text.replace(/&gt;/g, '>')
    text = text.replace(/&amp;/g, '&')
    text = text.replace(/&quot;/g, '"')
    text = text.replace(/&#39;/g, "'")

    // Normalise whitespace
    text = text.replace(/\r\n/g, '\n')
    text = text.replace(/[ \t]+/g, ' ')
    text = text.replace(/\n{3,}/g, '\n\n')
    text = text.trim()

    return text
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return its content as markdown/plain text.
 *
 * Features:
 * - Content negotiation (prefers text/markdown, falls back to HTML → plain text)
 * - SSRF protection (blocks private/reserved IPs and cloud metadata endpoints)
 * - Max 5 redirects, 5 MB response limit, 30 s timeout
 */
export class WebFetchExecutor implements ToolExecutor {
    public name = 'web_fetch'

    /**
     * Execute the web_fetch tool.
     *
     * @param args - `{ url: string, format?: string }`
     *   `format` can be "markdown", "html", or "text" (default "markdown")
     */
    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const urlString = String(args.url || '').trim()
        const format = String(args.format || 'markdown').toLowerCase()

        if (!urlString) {
            return { success: false, output: '', error: 'MISSING_PARAMETER: url is required' }
        }

        // Validate URL structure
        let parsedUrl: URL
        try {
            parsedUrl = new URL(urlString)
        } catch {
            return { success: false, output: '', error: `INVALID_URL: '${urlString}' is not a valid URL` }
        }

        // Only allow http/https
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return {
                success: false,
                output: '',
                error: `PROTOCOL_NOT_ALLOWED: only http:// and https:// are supported (got ${parsedUrl.protocol})`,
            }
        }

        // SSRF check on hostname
        const hostname = parsedUrl.hostname
        if (await isForbiddenHost(hostname)) {
            return {
                success: false,
                output: '',
                error: `SSRF_BLOCKED: hostname '${hostname}' resolves to a private, reserved, or cloud-metadata address`,
            }
        }

        // Perform the fetch with redirect following
        try {
            const result = await fetchWithLimits(parsedUrl.toString(), format, DEFAULT_TIMEOUT_MS, MAX_REDIRECTS, MAX_BODY_BYTES)
            return result
        } catch (e) {
            const err = e as Error
            return { success: false, output: '', error: `FETCH_ERROR: ${err.message}` }
        }
    }
}

/**
 * Fetch a URL respecting redirect, size, and timeout limits.
 */
async function fetchWithLimits(
    initialUrl: string,
    format: string,
    timeoutMs: number,
    maxRedirects: number,
    maxBodyBytes: number,
): Promise<ToolResult> {
    let currentUrl = initialUrl
    let redirectCount = 0

    while (true) {
        // Build Accept header based on requested format
        let acceptHeader: string
        switch (format) {
            case 'html':
                acceptHeader = 'text/html,application/xhtml+xml,*/*'
                break
            case 'text':
                acceptHeader = 'text/plain,text/markdown,*/*'
                break
            default:
                acceptHeader = 'text/markdown,text/html,application/xhtml+xml,text/plain,*/*'
                break
        }

        // Create abort controller for timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        let response: Response
        try {
            response = await fetch(currentUrl, {
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'Accept': acceptHeader,
                    'User-Agent': 'CodeOn/0.1.0 (WebFetch)',
                    'Accept-Encoding': 'gzip, deflate',
                },
            })
        } finally {
            clearTimeout(timeoutId)
        }

        // Handle redirects manually
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            redirectCount++
            if (redirectCount > maxRedirects) {
                return {
                    success: false,
                    output: '',
                    error: `TOO_MANY_REDIRECTS: exceeded ${maxRedirects} redirects (last URL: ${currentUrl})`,
                }
            }
            const location = response.headers.get('location')
            if (!location) {
                return { success: false, output: '', error: `REDIRECT_NO_LOCATION: got HTTP ${response.status} without Location header` }
            }
            // Resolve relative redirects
            try {
                currentUrl = new URL(location, currentUrl).toString()
            } catch {
                return { success: false, output: '', error: `INVALID_REDIRECT: Location '${location}' is not a valid URL` }
            }

            // SSRF check on redirect target
            const redirectHostname = new URL(currentUrl).hostname
            if (await isForbiddenHost(redirectHostname)) {
                return {
                    success: false,
                    output: '',
                    error: `SSRF_BLOCKED: redirect target '${redirectHostname}' resolves to a private/reserved address`,
                }
            }
            continue
        }

        // Check status
        if (response.status !== 200) {
            return {
                success: false,
                output: '',
                error: `HTTP_${response.status}: ${response.statusText} from ${currentUrl}`,
            }
        }

        // Check Content-Length header
        const contentLength = response.headers.get('content-length')
        if (contentLength && parseInt(contentLength, 10) > maxBodyBytes) {
            return {
                success: false,
                output: '',
                error: `RESPONSE_TOO_LARGE: Content-Length ${contentLength} exceeds ${maxBodyBytes} byte limit`,
            }
        }

        // Read body with size limit
        const contentType = response.headers.get('content-type') || ''
        let bodyText: string

        try {
            const reader = response.body?.getReader()
            if (!reader) {
                bodyText = ''
            } else {
                const chunks: Uint8Array[] = []
                let totalBytes = 0
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    totalBytes += value.byteLength
                    if (totalBytes > maxBodyBytes) {
                        return {
                            success: false,
                            output: '',
                            error: `RESPONSE_TOO_LARGE: body exceeded ${maxBodyBytes} bytes (${totalBytes} read)`,
                        }
                    }
                    chunks.push(value)
                }
                bodyText = new TextDecoder().decode(concatUint8Arrays(chunks))
            }
        } catch (e) {
            const err = e as Error
            return { success: false, output: '', error: `BODY_READ_ERROR: ${err.message}` }
        }

        // Convert based on content type and requested format
        let output: string
        const isHtml = contentType.includes('text/html')
        const isMarkdown = contentType.includes('text/markdown') || contentType.includes('text/x-markdown')
        const isPlain = contentType.includes('text/plain')

        if (format === 'html') {
            output = isHtml ? bodyText : bodyText
        } else if (isMarkdown || format === 'markdown') {
            // Already markdown or user wants markdown — if HTML, convert
            output = isHtml ? htmlToPlainText(bodyText) : bodyText
        } else if (isPlain || format === 'text') {
            output = bodyText
        } else {
            // Fallback: strip HTML if it looks like HTML
            output = bodyText.startsWith('<') ? htmlToPlainText(bodyText) : bodyText
        }

        // Truncate very long outputs (keep first 50k chars)
        const maxOutputChars = 50_000
        let truncated = false
        if (output.length > maxOutputChars) {
            output = output.slice(0, maxOutputChars)
            truncated = true
        }

        const metaLines = [
            `URL: ${currentUrl}`,
            `Status: ${response.status}`,
            `Content-Type: ${contentType}`,
            `Size: ${new TextEncoder().encode(output).length} bytes`,
        ]
        if (redirectCount > 0) metaLines.push(`Redirects: ${redirectCount}`)
        if (truncated) metaLines.push(`Truncated: yes (output limited to ${maxOutputChars} chars)`)

        return {
            success: true,
            output: `${metaLines.join('\n')}\n\n${output}`,
        }
    }
}

/** Concatenate an array of Uint8Arrays into one. */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((sum, a) => sum + a.byteLength, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const a of arrays) {
        result.set(a, offset)
        offset += a.byteLength
    }
    return result
}
