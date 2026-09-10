import { ChainType } from '../types'
import type { TimeLockCondition, UnisatSignInput, UnisatWallet } from '../types'

export type OperationIdentity = Readonly<{ ownerAddress: string; pubKey: string; chain: ChainType; lock: TimeLockCondition }>

export function freezeOperationIdentity(ownerAddress: string, pubKey: string, chain: string, lock: TimeLockCondition): OperationIdentity {
  if (!ownerAddress || !pubKey || !Object.values(ChainType).includes(chain as ChainType)) throw new Error('A known wallet account, public key and network are required.')
  return Object.freeze({ ownerAddress, pubKey, chain: chain as ChainType, lock: Object.freeze({ ...lock }) })
}

/** Synchronous same-page gate; this does not claim cross-tab transaction isolation. */
export function createOperationGate() {
  let busy = false
  return { enter: () => { if (busy) return false; busy = true; return true }, leave: () => { busy = false } }
}

/** Events invalidate even a switch away and back during one pending wallet prompt. */
export function watchOperationIdentity(identity: OperationIdentity, provider: UnisatWallet | undefined = window.unisat) {
  let changed = false
  const invalidate = () => { changed = true }
  provider?.on?.('accountsChanged', invalidate)
  provider?.on?.('chainChanged', invalidate)
  const assertCurrent = async () => {
    if (!provider?.getChain || changed || (typeof window !== 'undefined' && window.unisat !== provider)) throw new Error('Wallet account or network changed (or cannot be verified). Operation stopped; saved broadcast progress was retained.')
    const accounts = await provider.getAccounts()
    const pubKey = await provider.getPublicKey()
    const chain = await provider.getChain()
    if (changed || (typeof window !== 'undefined' && window.unisat !== provider) || accounts[0] !== identity.ownerAddress || pubKey.trim().toLowerCase() !== identity.pubKey.toLowerCase() || chain.enum !== identity.chain) {
      throw new Error('Wallet account, public key or network changed. Operation stopped; saved broadcast progress was retained.')
    }
  }
  return { assertCurrent, dispose: () => { provider?.removeListener?.('accountsChanged', invalidate); provider?.removeListener?.('chainChanged', invalidate) } }
}

function extractWalletError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    for (const key of ['message', 'msg', 'error', 'reason']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  return String(error)
}

function isPsbtHexRequiredError(error: unknown): boolean {
  const message = extractWalletError(error).toLowerCase()
  return message.includes('psbthex') && message.includes('required')
}

function unwrapSignedPsbt(result: unknown): string {
  if (typeof result === 'string' && result.trim()) return result.trim()
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    for (const key of ['psbt', 'base64', 'signedPsbt', 'psbtHex', 'hex']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    const nested = obj.result
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
    if (nested && typeof nested === 'object') {
      const nestedObj = nested as Record<string, unknown>
      for (const key of ['psbt', 'base64', 'signedPsbt', 'psbtHex', 'hex', 'data']) {
        const value = nestedObj[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
  }
  throw new Error('The wallet returned an unsupported PSBT response.')
}

export async function signPsbtCompat(
  psbtHex: string,
  options?: { autoFinalized?: boolean; toSignInputs?: UnisatSignInput[] },
  beforeSign?: () => Promise<void>,
): Promise<string> {
  const signer = window.unisat?.signPsbt
  if (!signer) {
    throw new Error('The connected wallet does not support signPsbt.')
  }

  try {
    await beforeSign?.()
    const result = await signer.call(window.unisat, psbtHex, options)
    return unwrapSignedPsbt(result)
  } catch (error) {
    if (!isPsbtHexRequiredError(error)) {
      throw error
    }

    await beforeSign?.()
    const result = await (signer as unknown as (
      payload: { psbtHex: string; options?: { autoFinalized?: boolean; toSignInputs?: UnisatSignInput[] } },
    ) => Promise<unknown>).call(window.unisat, {
      psbtHex,
      options,
    })
    return unwrapSignedPsbt(result)
  }
}

export async function signPsbtsCompat(
  psbtHexs: string[],
  options: { autoFinalized?: boolean; toSignInputs?: UnisatSignInput[] }[],
  assertCurrent?: () => Promise<void>,
): Promise<string[]> {
  if (psbtHexs.length !== options.length) {
    throw new Error('Each PSBT requires its own signing options.')
  }
  const batchSigner = window.unisat?.signPsbts
  if (!batchSigner) {
    const signed: string[] = []
    for (let index = 0; index < psbtHexs.length; index += 1) {
      signed.push(await signPsbtCompat(psbtHexs[index], options[index], assertCurrent))
    }
    return signed
  }

  await assertCurrent?.()
  const result = await batchSigner.call(window.unisat, psbtHexs, options)
  if (!Array.isArray(result) || result.length !== psbtHexs.length) {
    throw new Error('The wallet returned an invalid batch PSBT signing response.')
  }
  return result.map(unwrapSignedPsbt)
}

export async function pushSignedPsbt(psbt: string): Promise<string> {
  if (window.unisat?.pushPsbt) {
    return window.unisat.pushPsbt(psbt)
  }
  throw new Error('The connected wallet does not support pushPsbt broadcasting.')
}
