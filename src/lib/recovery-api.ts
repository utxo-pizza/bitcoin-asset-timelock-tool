import type { ChainType } from '../types'
import { CHAIN_SNAPSHOT_TTL_MS, getOpenApiBase, requireKnownChain } from './openapi'
import { MAX_PUBLIC_RECOVERY_BYTES, parsePublicRecoveryManifest, type PublicRecoveryManifest } from './recovery-manifest'

/** A terminal transport error: do not keep querying other candidates after it. */
export class RecoveryApiError extends Error {}

function endpoint(path: string, chain: ChainType | string): string {
  requireKnownChain(chain)
  const base = new URL(getOpenApiBase(chain))
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !path.startsWith('/') || path.startsWith('//')) throw new Error('Unsupported recovery API endpoint configuration.')
  return `${base.toString().replace(/\/+$/, '')}${path}`
}

async function readBounded(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel()
    throw new RecoveryApiError('Recovery API response exceeds the supported size.')
  }
  if (!response.body) throw new RecoveryApiError('Recovery API returned no body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new RecoveryApiError('Recovery API response exceeds the supported size.')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

async function requestBody(path: string, chain: ChainType | string, apiKey: string | undefined, maximum: number, content = false): Promise<string> {
  const url = endpoint(path, chain)
  const startedAt = Date.now()
  const headers: Record<string, string> = { accept: content ? 'application/json, text/plain' : 'application/json' }
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
  try {
    const response = await fetch(url, { headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel()
      throw new RecoveryApiError(`Recovery API HTTP ${response.status}. Stop and retry only after the service is available; respect any Retry-After guidance.`)
    }
    const age = Number(response.headers.get('age') || '0')
    if (!Number.isFinite(age) || age < 0 || age > CHAIN_SNAPSHOT_TTL_MS / 1000) {
      await response.body?.cancel()
      throw new RecoveryApiError('Recovery API returned stale data.')
    }
    const text = await readBounded(response, maximum)
    if (Date.now() - startedAt > CHAIN_SNAPSHOT_TTL_MS) throw new RecoveryApiError('Recovery API check expired.')
    return text
  } catch (error) {
    if (error instanceof RecoveryApiError) throw error
    throw new RecoveryApiError('Recovery API request failed. Stop and refresh before retrying.')
  }
}

/** Fresh, bounded JSON envelope reads; no caller-provided host or content URL. */
export async function requestRecoveryData(path: string, chain: ChainType | string, apiKey?: string, maximum = 262_144): Promise<unknown> {
  const text = await requestBody(path, chain, apiKey, maximum)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new RecoveryApiError('Recovery API returned invalid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).code !== 0 || !Object.prototype.hasOwnProperty.call(value, 'data')) throw new RecoveryApiError('Recovery API returned an unsuccessful or malformed envelope.')
  return (value as Record<string, unknown>).data
}

export function recoveryObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing or malformed ${label}.`)
  return value as Record<string, unknown>
}

export function assertPlainInscriptionContent(info: Record<string, unknown>): void {
  const contentType = typeof info.contentType === 'string' ? info.contentType.toLowerCase().split(';')[0].trim() : ''
  if (!['application/json', 'text/plain'].includes(contentType)) throw new Error('Only plain UTF-8 text or JSON inscription content is supported.')
  if (!Number.isSafeInteger(info.contentLength) || (info.contentLength as number) <= 0 || (info.contentLength as number) > MAX_PUBLIC_RECOVERY_BYTES) throw new Error('Unsupported inscription content length.')
  // Do not fetch delegated/encoded content or follow arbitrary metadata URLs.
  for (const field of ['delegate', 'delegateId', 'deligate', 'hasDeligate', 'hasDelegate', 'hasContentEncoding', 'contentEncoding', 'encoding']) {
    if (info[field] !== undefined && info[field] !== null && info[field] !== '' && info[field] !== false) throw new Error('Delegated or encoded inscription content is unsupported.')
  }
}

export async function loadRecoveryManifestInscription(id: string, chain: ChainType | string, apiKey?: string): Promise<PublicRecoveryManifest> {
  const selected = requireKnownChain(chain)
  const inscriptionId = id.trim().toLowerCase()
  if (!/^[0-9a-f]{64}i(?:0|[1-9]\d{0,9})$/.test(inscriptionId)) throw new Error('Enter a full inscription ID.')
  const info = recoveryObject(await requestRecoveryData(`/inscription/info/${inscriptionId}`, selected, apiKey), 'inscription metadata')
  if (info.inscriptionId !== inscriptionId) throw new Error('Inscription metadata identifies another inscription.')
  assertPlainInscriptionContent(info)
  const text = await requestBody(`/inscription/content/${inscriptionId}`, selected, apiKey, MAX_PUBLIC_RECOVERY_BYTES, true)
  if (new TextEncoder().encode(text).length !== info.contentLength) throw new Error('Inscription content length does not match its metadata.')
  const manifest = parsePublicRecoveryManifest(text)
  if (manifest.chain !== selected) throw new Error('Recovery manifest belongs to another network.')
  // This is untrusted indexer content, not authentication or a confirmation proof.
  return manifest
}
