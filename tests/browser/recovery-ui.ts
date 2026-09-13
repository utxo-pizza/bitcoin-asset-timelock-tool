/** Local synthetic integration: every external request is intercepted; no actual wallet or funds. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { preview } from 'vite'
import { bitcoin, eccManager } from '@unisat/wallet-bitcoin'
import { ChainType, OwnerAddressType, type LegacyTimeLockRecord } from '../../src/types'
import { buildTimeLockMetadataScript, getMetadataLockCondition, type TimeLockMetadata } from '../../src/lib/recovery'
import { deriveTimeLockAddress } from '../../src/lib/timelock'
import { buildRuneTransferRunestone } from '../../src/lib/runestone'
import { RECOVERED_RECORDS_KEY } from '../../src/lib/recovered-records'
import { LEGACY_RECORDS_KEY, RECORDS_V2_KEY } from '../../src/lib/records'
import { serializePublicRecoveryManifest } from '../../src/lib/recovery-manifest'
import { pubKey, userAddress, scriptPk } from '../core/fixtures'

const runtime = process.env.PLAYWRIGHT_MODULE || 'playwright-core'
const { chromium } = await import(runtime)
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false } })
const origin = server.resolvedUrls!.local[0]
const artifacts = resolve('.ui-artifacts/recovery')
await mkdir(artifacts, { recursive: true })
const chain = ChainType.BITCOIN_MAINNET
const target = 2_208_988_800
// TEST ONLY: publicly known scalar 1 and synthetic previous outputs, never funded.
const signer = eccManager.eccPair.fromPrivateKey(Buffer.from('00'.repeat(31) + '01', 'hex'))
const feeTx = new bitcoin.Transaction()
feeTx.addInput(Buffer.alloc(32, 9), 0)
feeTx.addOutput(Buffer.from(scriptPk, 'hex'), 20_000)
const feeUtxo = { txid: feeTx.getId(), vout: 0, satoshi: 20_000, scriptPk, address: userAddress, height: 80, isSpent: false, isSpending: false, inscriptions: [], inscriptionsCount: 0 }
const rune = { runeid: '100:1', amount: '123', rune: 'SYNTHETIC', spacedRune: 'SYNTHETIC', symbol: 'S', divisibility: 0 }

function fixture(workspace: 'csv' | 'cltv', assetKind: 'brc20' | 'runes' = 'brc20') {
  const metadata: TimeLockMetadata = workspace === 'csv'
    ? { version: 1, lockBlocks: 3, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2WPKH_EVEN }
    : { version: 2, lockTime: target, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2WPKH_EVEN }
  const address = deriveTimeLockAddress(pubKey, getMetadataLockCondition(metadata), chain)
  const lockScript = bitcoin.address.toOutputScript(address)
  const tx = new bitcoin.Transaction(); tx.version = 2; tx.addInput(Buffer.alloc(32, 1), 0)
  if (assetKind === 'brc20') { tx.addOutput(lockScript, 546); tx.addOutput(buildTimeLockMetadataScript(metadata), 0) }
  else {
    tx.addOutput(buildRuneTransferRunestone({ runeId: rune.runeid, amount: rune.amount, destinationOutput: 1, pointerOutput: 2, recoveryMetadata: metadata }), 0)
    tx.addOutput(lockScript, 330); tx.addOutput(Buffer.from(scriptPk, 'hex'), 330)
  }
  const txid = tx.getId(); const vout = assetKind === 'brc20' ? 0 : 1
  return { workspace, assetKind, metadata, address, tx, txid, vout, satoshi: assetKind === 'brc20' ? 546 : 330, scriptPk: lockScript.toString('hex') }
}
const csv = fixture('csv'); const csvRune = fixture('csv', 'runes'); const cltv = fixture('cltv'); const cltvRune = fixture('cltv', 'runes')
const fixtures = [csv, csvRune, cltv, cltvRune]
const backupId = `${'ef'.repeat(32)}i0`
const manifest = (items = [csv], selectedChain: ChainType = chain) => serializePublicRecoveryManifest({ format: 'batl-recovery', version: 1, chain: selectedChain, outpoints: items.map(({ txid, vout }) => ({ txid, vout })) })
const legacy: LegacyTimeLockRecord = { id: 'legacy-recovery-fixture', ownerAddress: userAddress, chain, assetKind: 'brc20', ticker: 'LEGACY', amount: '10', lockBlocks: 3,
  timeLockAddress: csv.address, createdAt: '2026-09-11T00:00:00Z', commitTxid: '12'.repeat(32), revealTxid: csv.txid,
  inscriptionTxid: csv.txid, inscriptionVout: 0, inscriptionSatoshi: 546, status: 'locked' }
let passed = 0

// Playwright is deliberately resolved from the supplied runtime rather than a new package dependency.
async function scenario(name: string, run: (page: any, control: any) => Promise<void>, options: { workspace?: 'csv' | 'cltv'; connected?: boolean; old?: LegacyTimeLockRecord[]; recoveredRaw?: string; width?: number } = {}) {
  if (process.env.UI_SCENARIO_FILTER && !name.includes(process.env.UI_SCENARIO_FILTER)) return
  const context = await browser.newContext({ viewport: { width: options.width || 1100, height: 900 }, acceptDownloads: true })
  const page = await context.newPage(); page.setDefaultTimeout(15_000)
  const control = { signCalls: 0, broadcastCalls: 0, signed: [] as string[], broadcasts: [] as string[], rawCalls: 0,
    medianTime: target + 1, blocks: 120, spent: false, unknownAssets: false, corruptOutput: false, failRaw: false,
    holdSign: false, releaseSign: null as (() => void) | null, holdRaw: false, releaseRaw: null as (() => void) | null,
    broadcastFailure: false, wrongBroadcastId: false, failAttemptSave: false, unexpected: [] as string[] }
  const faults: string[] = []
  page.on('pageerror', (error: Error) => faults.push(error.message))
  await page.addInitScript('window.__name = function(target) { return target; }')
  await page.exposeFunction('syntheticRecoverySign', async (hex: string) => {
    control.signCalls++; control.signed.push(hex)
    if (control.holdSign) await new Promise<void>((release) => { control.releaseSign = release })
    let psbt = bitcoin.Psbt.fromHex(hex)
    if (control.corruptOutput) {
      const changed = new bitcoin.Psbt().setVersion(psbt.version).setLocktime(psbt.locktime)
      psbt.txInputs.forEach((input, index) => changed.addInput({ ...input, ...psbt.data.inputs[index] }))
      psbt.txOutputs.forEach((output, index) => changed.addOutput({ script: output.script, value: output.value - (index === 0 ? 1 : 0) }))
      psbt = changed
    }
    for (let index = 0; index < psbt.inputCount; index++) psbt.signInput(index, signer)
    return psbt.finalizeAllInputs().toHex()
  })
  await page.exposeFunction('syntheticRecoveryPush', async (hex: string) => {
    control.broadcastCalls++; control.broadcasts.push(hex)
    if (control.broadcastFailure) throw new Error('Synthetic uncertain broadcast')
    return control.wrongBroadcastId ? 'ff'.repeat(32) : bitcoin.Psbt.fromHex(hex).extractTransaction().getId()
  })
  await page.addInitScript(({ address, publicKey, chain, connected, old, recoveredRaw, legacyKey, modernKey, recoveredKey }: any) => {
    const win = window as any
    if (!localStorage.getItem('recovery-fixture-initialized')) {
      localStorage.setItem(legacyKey, JSON.stringify(old)); localStorage.removeItem(modernKey)
      if (recoveredRaw !== undefined) localStorage.setItem(recoveredKey, recoveredRaw)
      else localStorage.removeItem(recoveredKey)
      localStorage.setItem('bitcoin_asset_timelock_openapi_key', 'synthetic-api-key-not-for-export')
      localStorage.setItem('recovery-fixture-initialized', 'yes')
    }
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    win.recoveryFixture = { address, publicKey, chain, connected, emit(event: string) { for (const listener of listeners.get(event) || []) listener(event === 'accountsChanged' ? [this.address] : this.chain) } }
    win.unisat = {
      getAccounts: async () => win.recoveryFixture.connected ? [win.recoveryFixture.address] : [],
      requestAccounts: async () => { win.recoveryFixture.connected = true; return [win.recoveryFixture.address] },
      getPublicKey: async () => win.recoveryFixture.publicKey,
      getChain: async () => ({ enum: win.recoveryFixture.chain, name: 'Synthetic network', network: 'livenet' }),
      signPsbt: (hex: string) => win.syntheticRecoverySign(hex), pushPsbt: (hex: string) => win.syntheticRecoveryPush(hex),
      on: (event: string, callback: (...args: unknown[]) => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(callback) },
      removeListener: (event: string, callback: (...args: unknown[]) => void) => listeners.get(event)?.delete(callback),
    }
  }, { address: userAddress, publicKey: pubKey, chain, connected: options.connected !== false, old: options.old || [], recoveredRaw: options.recoveredRaw,
    legacyKey: LEGACY_RECORDS_KEY, modernKey: RECORDS_V2_KEY, recoveredKey: RECOVERED_RECORDS_KEY })
  await context.route('**/*', async (route: any) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(origin).origin) return route.continue()
    if (!/^open-api(?:-[a-z0-9-]+)?\.unisat\.io$/.test(url.hostname)) { control.unexpected.push(url.origin); return route.abort() }
    const path = url.pathname.replace('/v1/indexer', '')
    let data: unknown
    const f = fixtures.find((candidate) => path.includes(candidate.txid))
    if (path === '/blockchain/info') data = { blocks: control.blocks, headers: control.blocks, bestBlockHash: 'ab'.repeat(32), prevBlockHash: 'cd'.repeat(32), medianTime: control.medianTime }
    else if (path === '/fees/recommended') data = { fastestFee: 1 }
    else if (path.endsWith('/brc20/summary')) data = { total: 0, detail: [] }
    else if (path.endsWith('/runes/balance-list')) data = { total: 0, detail: [] }
    else if (path.endsWith('/available-utxo-data')) data = { utxo: [feeUtxo] }
    else if (path === '/runes/status') data = { bestHeight: control.blocks }
    else if (path === '/brc20/status') data = { height: control.blocks }
    else if (path === `/rawtx/${feeUtxo.txid}`) data = feeTx.toHex()
    else if (path === `/utxo/${feeUtxo.txid}/0`) data = feeUtxo
    else if (path === `/tx/${feeUtxo.txid}`) data = { txid: feeUtxo.txid, height: 80, confirmations: control.blocks - 79 }
    else if (path === `/runes/utxo/${feeUtxo.txid}/0/balance`) data = []
    else if (path === `/inscription/info/${backupId}`) data = { inscriptionId: backupId, contentType: 'application/json', contentLength: Buffer.byteLength(manifest()) }
    else if (path === `/inscription/content/${backupId}`) return route.fulfill({ status: 200, contentType: 'application/json', body: manifest() })
    else if (f) {
      const output = { txid: f.txid, vout: f.vout, satoshi: f.satoshi, scriptPk: f.scriptPk, address: f.address, height: 100,
        isSpent: control.spent, isSpending: false, inscriptionsCount: f.assetKind === 'brc20' ? 1 : 0,
        inscriptions: f.assetKind === 'brc20' ? [{ inscriptionId: `${f.txid}i0`, offset: 0, isBRC20: true, moved: false }] : [] }
      if (path === `/rawtx/${f.txid}`) {
        control.rawCalls++
        if (control.failRaw) return route.fulfill({ status: 503, body: 'Synthetic read unavailable' })
        if (control.holdRaw) { control.holdRaw = false; await new Promise<void>((release) => { control.releaseRaw = release }) }
        data = f.tx.toHex()
      } else if (path === `/utxo/${f.txid}/${f.vout}`) data = output
      else if (path === `/tx/${f.txid}`) data = { txid: f.txid, height: 100, confirmations: control.blocks - 99 }
      else if (path === `/runes/utxo/${f.txid}/${f.vout}/balance`) data = control.unknownAssets ? null : f.assetKind === 'runes' ? [rune] : []
      else if (path === `/inscription/info/${f.txid}i0`) data = { inscriptionId: `${f.txid}i0`, offset: 0, height: 100, address: f.address,
        contentType: 'text/plain;charset=utf-8', contentLength: 64, brc20: { op: 'transfer', tick: 'test', amt: '10', decimal: '0' }, utxo: output }
      else if (path === `/brc20/test/tx/${f.txid}/history`) data = { start: 0, total: 1, detail: [{ inscriptionId: `${f.txid}i0`, txid: f.txid, height: 100, valid: true, type: 'inscribe-transfer', amount: '10' }] }
      else { control.unexpected.push(path); return route.abort() }
    } else { control.unexpected.push(path); return route.abort() }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) })
  })
  try {
    await page.goto(`${origin}#/${options.workspace || 'csv'}`)
    await page.getByRole('region', { name: 'Public backup and recovery' }).waitFor()
    await page.locator('#recovery-chain').waitFor()
    await page.getByText('Bitcoin Mainnet — recovery', { exact: true }).waitFor()
    await run(page, control)
    assert.deepEqual(faults, [], `${name}: page errors`)
    assert.deepEqual(control.unexpected, [], `${name}: unexpected external requests, all blocked`)
    passed++; console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`${name}: browser faults`, faults)
    await page.screenshot({ path: resolve(artifacts, `failure-${passed + 1}.png`), fullPage: true })
    throw error
  } finally { await context.close() }
}

const panel = (page: any) => page.getByRole('region', { name: 'Public backup and recovery' })
const row = (page: any, f = csv) => page.locator(`[data-recovery-outpoint="${f.txid}:${f.vout}"]`)
async function choose(page: any, id: string, label: string) {
  await page.locator(`#${id}`).click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText(label, { exact: true }).click()
}
async function restore(page: any, f = csv) {
  await page.locator('#recovery-txid').fill(f.txid)
  await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
  await row(page, f).waitFor()
  await panel(page).getByText(/public reference.*restored/).waitFor()
}
async function verify(page: any, f = csv) {
  await row(page, f).getByRole('button', { name: 'Verify recovered record', exact: true }).click()
  await panel(page).getByText(/Last check updated/).waitFor()
}
async function review(page: any, f = csv) {
  await row(page, f).getByRole('button', { name: 'Review recovered unlock', exact: true }).click()
  await page.getByRole('dialog').waitFor()
}
async function accept(page: any) {
  await page.getByRole('dialog').getByRole('checkbox', { name: /no Alkanes/ }).check()
  await page.getByRole('button', { name: 'Confirm recovered signing', exact: true }).click()
}
async function saved(page: any) { return page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '[]'), RECOVERED_RECORDS_KEY) }

try {
  await scenario('txid restore works with no connected wallet and never signs', async (page, control) => {
    await restore(page)
    assert.equal(control.signCalls, 0); assert.equal(control.broadcastCalls, 0); assert.equal(control.rawCalls, 1)
    assert.equal((await saved(page))[0].txid, csv.txid)
    assert.equal(await row(page).getByRole('button', { name: 'Review recovered unlock', exact: true }).isDisabled(), true)
  }, { connected: false })

  await scenario('public text and file restore two same-workspace references', async (page, control) => {
    await choose(page, 'recovery-source', 'Public JSON text or file')
    await page.locator('#recovery-manifest').fill(manifest([csv, csvRune]))
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await row(page, csvRune).waitFor(); assert.equal((await saved(page)).length, 2)
    await page.locator('#recovery-file').setInputFiles({ name: 'public.json', mimeType: 'application/json', buffer: Buffer.from(manifest([csv, csvRune])) })
    await panel(page).getByText(/Public file loaded/).waitFor()
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await panel(page).getByText(/2 public references restored/).waitFor()
    assert.equal((await saved(page)).length, 2); assert.equal(control.signCalls, 0)
  })

  await scenario('backup inscription restores public references without HTML rendering', async (page, control) => {
    await choose(page, 'recovery-source', 'Backup inscription ID')
    await page.locator('#recovery-inscription').fill(backupId)
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await row(page).waitFor()
    assert.equal((await saved(page))[0].source, 'inscription')
    assert.equal(control.signCalls, 0); assert.equal(await panel(page).locator('iframe').count(), 0)
  })

  await scenario('manifest wrong chain and mixed workspace batches save nothing', async (page, control) => {
    await choose(page, 'recovery-source', 'Public JSON text or file')
    await page.locator('#recovery-manifest').fill(manifest([csv], ChainType.FRACTAL_BITCOIN_MAINNET))
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await panel(page).getByText(/names a different network/).waitFor(); assert.equal(control.rawCalls, 0)
    await page.locator('#recovery-manifest').fill(manifest([csv, cltv]))
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await panel(page).getByText(/different lock workspace/).waitFor()
    assert.deepEqual(await saved(page), [])
  })

  await scenario('existing original records prevent duplicate restored history', async (page) => {
    await page.locator('#recovery-txid').fill(csv.txid)
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await panel(page).getByText(/already has an original local record/).waitFor()
    assert.deepEqual(await saved(page), [])
  }, { old: [legacy] })

  await scenario('public export previews exact whitelist and excludes pending signatures and API keys', async (page, control) => {
    const checkboxes = panel(page).getByRole('checkbox')
    assert.equal(await checkboxes.count(), 1)
    await checkboxes.first().check()
    await panel(page).getByRole('button', { name: 'Preview public JSON', exact: true }).click()
    const content = await page.locator('#recovery-preview').inputValue()
    assert.deepEqual(JSON.parse(content), JSON.parse(manifest()))
    for (const forbidden of ['synthetic-api-key', 'pendingPsbts', 'SYNTHETIC_SIGNED', 'ownerAddress', 'amount', 'ticker']) assert.ok(!content.includes(forbidden))
    const downloadEvent = page.waitForEvent('download')
    await panel(page).getByRole('button', { name: 'Download public backup', exact: true }).click()
    const download = await downloadEvent
    const filename = resolve(artifacts, 'public-backup-fixture.json'); await download.saveAs(filename)
    assert.equal(await readFile(filename, 'utf8'), content)
    assert.equal(control.signCalls, 0); assert.equal(control.broadcastCalls, 0)
    assert.equal(await panel(page).getByRole('link', { name: 'Open official UniSat inscription page' }).getAttribute('href'), 'https://unisat.io/inscribe')
  }, { old: [legacy, { ...legacy, id: 'pending', inscriptionTxid: '98'.repeat(32), ticker: 'PENDING', status: 'pending', pendingPsbts: Array(5).fill('SYNTHETIC_SIGNED_PRIVATE_DATA') }] })

  await scenario('cancelled confirmation does not sign or broadcast', async (page, control) => {
    await restore(page); await verify(page); await review(page)
    assert.equal(await page.getByRole('button', { name: 'Confirm recovered signing', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Cancel recovered unlock', exact: true }).click()
    await panel(page).getByText(/Review cancelled/).waitFor()
    assert.equal(control.signCalls, 0); assert.equal(control.broadcastCalls, 0)
  })

  for (const f of [csv, cltvRune]) await scenario(`${f.workspace} ${f.assetKind} recovered unlock uses real synthetic signatures and keeps principal`, async (page, control) => {
    await restore(page, f); await verify(page, f); await review(page, f); await accept(page)
    await panel(page).getByText(/Wallet reported broadcast/).waitFor()
    assert.equal(control.signCalls, 1); assert.equal(control.broadcastCalls, 1)
    const tx = bitcoin.Psbt.fromHex(control.broadcasts[0]).extractTransaction()
    assert.equal(tx.outs[0].value, f.satoshi)
    assert.ok(tx.outs.every((output) => output.script.toString('hex') === scriptPk))
    assert.equal(tx.locktime, f.workspace === 'csv' ? 0 : target)
    assert.equal(tx.ins[0].sequence, f.workspace === 'csv' ? 3 : 0xfffffffe)
    const record = (await saved(page))[0]
    assert.equal(record.unlockTxid, tx.getId()); assert.equal('pendingPsbts' in record, false)
  }, { workspace: f.workspace })

  for (const variant of ['unknown', 'spent', 'owner', 'csv-age', 'cltv-mtp'] as const) await scenario(`${variant} state blocks recovered signing`, async (page, control) => {
    const f = variant === 'cltv-mtp' ? cltv : csv
    await restore(page, f)
    if (variant === 'unknown') control.unknownAssets = true
    else if (variant === 'spent') control.spent = true
    else if (variant === 'csv-age') control.blocks = 101
    else if (variant === 'cltv-mtp') control.medianTime = target
    else await page.evaluate(() => { const fixture = (window as any).recoveryFixture; fixture.address = 'bc1qsyntheticwrongowner'; fixture.emit('accountsChanged') })
    await verify(page, f)
    assert.equal(await row(page, f).getByRole('button', { name: 'Review recovered unlock', exact: true }).isDisabled(), true)
    assert.equal(control.signCalls, 0); assert.equal(control.broadcastCalls, 0)
  }, { workspace: variant === 'cltv-mtp' ? 'cltv' : 'csv' })

  for (const change of ['wallet', 'api', 'record'] as const) await scenario(`${change} changes while signing prevent recovered broadcast`, async (page, control) => {
    await restore(page); await verify(page); control.holdSign = true
    await review(page); await accept(page)
    await page.waitForFunction(() => document.body.textContent?.includes('Review the recovered unlock in your wallet'))
    if (change === 'api') await page.locator('input[placeholder="Paste the key from developer.unisat.io"]').fill('synthetic-changed-key')
    else if (change === 'wallet') await page.evaluate(() => { const fixture = (window as any).recoveryFixture; fixture.chain = 'FRACTAL_BITCOIN_MAINNET'; fixture.emit('chainChanged') })
    else await page.evaluate((key: string) => {
      const refs = JSON.parse(localStorage.getItem(key)!); refs[0].restoredAt++
      localStorage.setItem(key, JSON.stringify(refs)); window.dispatchEvent(new StorageEvent('storage', { key }))
    }, RECOVERED_RECORDS_KEY)
    assert.ok(control.releaseSign); control.releaseSign()
    await panel(page).getByText(/changed.*Prepared transaction ID|Prepared transaction ID.*changed/).waitFor()
    assert.equal(control.signCalls, 1); assert.equal(control.broadcastCalls, 0)
  })

  await scenario('wallet returned output mutation is rejected before broadcasting', async (page, control) => {
    await restore(page); await verify(page); control.corruptOutput = true
    await review(page); await accept(page)
    await panel(page).getByText(/changed the unsigned transaction/).waitFor()
    assert.equal(control.signCalls, 1); assert.equal(control.broadcastCalls, 0)
    assert.equal((await saved(page))[0].unlockTxid, undefined)
  })

  await scenario('failed refresh invalidates the previous verified unlock state', async (page, control) => {
    await restore(page); await verify(page)
    assert.equal(await row(page).getByRole('button', { name: 'Review recovered unlock', exact: true }).isEnabled(), true)
    control.failRaw = true
    await row(page).getByRole('button', { name: 'Verify recovered record', exact: true }).click()
    await panel(page).getByText(/Recovery API HTTP 503/).waitFor()
    assert.equal(await row(page).getByRole('button', { name: 'Review recovered unlock', exact: true }).isDisabled(), true)
    assert.equal(control.signCalls, 0)
  })

  await scenario('shared operation gate blocks duplicate restore and workspace navigation', async (page, control) => {
    control.holdRaw = true
    await page.locator('#recovery-txid').fill(csv.txid)
    await panel(page).getByRole('button', { name: 'Restore records', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(await panel(page).getByRole('button', { name: 'Restore records', exact: true }).isDisabled(), true)
    await page.evaluate(() => { window.location.hash = '#/cltv' })
    await page.waitForFunction(() => window.location.hash === '#/csv')
    assert.ok(control.releaseRaw); control.releaseRaw()
    await row(page).waitFor(); assert.equal(control.rawCalls, 1)
  })

  await scenario('damaged recovered storage is preserved and blocks all writes', async (page, control) => {
    await panel(page).getByText(/Cannot read bitcoin_asset_timelock_recovered_v1/).waitFor()
    assert.equal(await panel(page).getByRole('button', { name: 'Restore records', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate((key: string) => localStorage.getItem(key), RECOVERED_RECORDS_KEY), '{broken')
    assert.equal(control.signCalls, 0)
  }, { recoveredRaw: '{broken' })

  await scenario('uncertain attempt is preserved and explicit retry requires both acknowledgments', async (page, control) => {
    await restore(page); await verify(page); control.broadcastFailure = true
    await review(page); await accept(page)
    await panel(page).getByText(/Synthetic uncertain broadcast.*Prepared transaction ID/).waitFor()
    const previous = (await saved(page))[0].unlockTxid
    assert.match(previous, /^[0-9a-f]{64}$/)
    await verify(page)
    await row(page).getByRole('button', { name: 'Review & retry recovered unlock', exact: true }).click()
    const dialog = page.getByRole('dialog'); await dialog.waitFor()
    assert.ok((await dialog.innerText()).includes(previous))
    await dialog.getByRole('checkbox', { name: /no Alkanes/ }).check()
    assert.equal(await page.getByRole('button', { name: 'Confirm recovered signing', exact: true }).isDisabled(), true)
    await dialog.getByRole('checkbox', { name: /checked the previous attempt/ }).check()
    assert.equal(await page.getByRole('button', { name: 'Confirm recovered signing', exact: true }).isDisabled(), false)
    await page.getByRole('button', { name: 'Cancel recovered unlock', exact: true }).click()
    assert.equal(control.signCalls, 1); assert.equal(control.broadcastCalls, 1)
  })

  await scenario('375px recovery and confirmation remain readable without horizontal overflow', async (page) => {
    await restore(page); await verify(page)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await page.locator('.recovery-panel').screenshot({ path: resolve(artifacts, 'recovery-mobile.png'), animations: 'disabled' })
    await review(page)
    const dialog = page.getByRole('dialog')
    assert.equal(await dialog.evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await dialog.screenshot({ path: resolve(artifacts, 'recovery-confirmation-mobile.png'), animations: 'disabled' })
    await dialog.getByRole('checkbox', { name: /no Alkanes/ }).scrollIntoViewIfNeeded()
    assert.equal(await dialog.evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false)
    await dialog.screenshot({ path: resolve(artifacts, 'recovery-confirmation-mobile-inputs.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Cancel recovered unlock', exact: true }).click()
  }, { width: 375 })

  console.log(`${passed} recovery browser scenarios passed. Screenshots: ${artifacts}`)
} finally {
  await browser.close()
  await new Promise<void>((resolveClose) => server.httpServer.close(() => resolveClose()))
}
