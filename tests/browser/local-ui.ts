/** Local synthetic browser integration only. No real wallet or external request is used.
 * npm run build first. Use an installed playwright-core module and Chromium:
 * PLAYWRIGHT_MODULE=/absolute/path/playwright-core/index.mjs
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/chrome-headless-shell npm run test:ui
 * No browser downloads or production services are started by this script.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { preview } from 'vite'
import { bitcoin } from '@unisat/wallet-bitcoin'
import { ChainType, type LegacyTimeLockRecord } from '../../src/types'
import { LEGACY_RECORDS_KEY, RECORDS_V2_KEY } from '../../src/lib/records'
import { buildTimeLockUnlockTx, deriveTimeLockAddress } from '../../src/lib/timelock'
import { pubKey, userAddress, csvGolden, utxo } from '../core/fixtures'

const runtime = process.env.PLAYWRIGHT_MODULE || 'playwright-core'
const { chromium } = await import(runtime)
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false } })
const origin = server.resolvedUrls!.local[0]
const artifacts = resolve('.ui-artifacts')
await mkdir(artifacts, { recursive: true })
const timestamp = 2_208_988_800
const legacy: LegacyTimeLockRecord = { id: 'legacy-fixture', ownerAddress: userAddress, chain: ChainType.BITCOIN_MAINNET, assetKind: 'brc20', ticker: 'LEGACY', amount: '2', lockBlocks: 3, timeLockAddress: csvGolden.addresses[3], createdAt: '2026-09-11T00:00:00Z', commitTxid: '11'.repeat(32), revealTxid: '22'.repeat(32), inscriptionTxid: '22'.repeat(32), inscriptionVout: 0, inscriptionSatoshi: 546, status: 'locked' }
let passed = 0

async function scenario(name: string, run: (page: any, control: any) => Promise<void>, initialHash = '#/csv', options: { timezoneId?: string; deviceTime?: string } = {}) {
  if (process.env.UI_SCENARIO_FILTER && !name.includes(process.env.UI_SCENARIO_FILTER)) return
  const context = await browser.newContext({ timezoneId: options.timezoneId || 'America/Los_Angeles', viewport: { width: 1100, height: 900 } })
  const page = await context.newPage()
  if (options.deviceTime) await page.clock.install({ time: new Date(options.deviceTime) })
  page.setDefaultTimeout(10_000)
  // tsx/esbuild's named-function helper is referenced by serialized test callbacks.
  await page.addInitScript('window.__name = function(target) { return target; }')
  const control = { medianTime: timestamp - 100, chainMetadata: {} as Record<string, unknown>, apiFailure: false, holdChain: false, releaseChain: null as (() => void) | null, failBroadcastAt: 0, broadcastError: 'Synthetic broadcast interruption', changeAfterSign: '', changeAfterPush: '', signCalls: 0, broadcastCalls: 0, signed: [] as string[], broadcasts: [] as string[], blockchainRequests: 0, blockchainOrigins: [] as string[], externalUnexpected: [] as string[], holdSign: false, releaseSign: null as (() => void) | null, feeRequests: 0, holdFees: false, releaseFees: null as (() => void) | null }
  const faults: string[] = []
  page.on('pageerror', (error: Error) => faults.push(error.message))
  await page.exposeFunction('fixtureSign', async (psbt: string) => { control.signCalls++; control.signed.push(psbt); if (control.holdSign) await new Promise<void>((resolveSign) => { control.releaseSign = resolveSign }); return psbt })
  await page.exposeFunction('fixturePush', async (psbt: string) => {
    control.broadcastCalls++
    if (control.broadcastCalls === control.failBroadcastAt) throw new Error(control.broadcastError)
    // Use the actual unsigned transaction bytes, preserving nLockTime and sequence.
    const tx = bitcoin.Transaction.fromBuffer(bitcoin.Psbt.fromHex(psbt).data.globalMap.unsignedTx.toBuffer())
    control.broadcasts.push(psbt)
    return tx.getId()
  })
  await page.addInitScript(({ pubKey, userAddress, legacy, legacyKey, newKey, chain }: any) => {
    const win = window as any
    if (!localStorage.getItem('fixture-initialized')) {
      localStorage.setItem(legacyKey, JSON.stringify([legacy], null, 2))
      localStorage.removeItem(newKey)
      localStorage.setItem('bitcoin_asset_timelock_openapi_key', 'synthetic-test-key')
      localStorage.setItem('fixture-initialized', 'yes')
    }
    const listeners = new Map<string, Set<(...args: any[]) => void>>()
    win.fixture = { address: userAddress, pubKey, chain, changeAfterSign: '', changeAfterPush: '', emit(event: string) { for (const handler of listeners.get(event) || []) handler(event === 'accountsChanged' ? [this.address] : this.chain) } }
    const switchFixture = (kind: string) => {
      if (kind === 'account') { win.fixture.address = 'bc1qfixtureotheraccount'; win.fixture.emit('accountsChanged') }
      if (kind === 'chain') { win.fixture.chain = 'FRACTAL_BITCOIN_MAINNET'; win.fixture.emit('chainChanged') }
    }
    win.unisat = {
      getAccounts: async () => [win.fixture.address], requestAccounts: async () => [win.fixture.address],
      getPublicKey: async () => win.fixture.pubKey,
      getChain: async () => ({ enum: win.fixture.chain, name: win.fixture.chain, network: 'livenet' }),
      signPsbt: async (psbt: string) => { win.fixture.signing = true; const result = await win.fixtureSign(psbt); win.fixture.signing = false; switchFixture(win.fixture.changeAfterSign); return result },
      signPsbts: async (psbts: string[]) => { const results = []; for (const psbt of psbts) results.push(await win.fixtureSign(psbt)); switchFixture(win.fixture.changeAfterSign); return results },
      pushPsbt: async (psbt: string) => { const result = await win.fixturePush(psbt); switchFixture(win.fixture.changeAfterPush); return result },
      on: (event: string, handler: (...args: any[]) => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(handler) },
      removeListener: (event: string, handler: (...args: any[]) => void) => listeners.get(event)?.delete(handler),
    }
  }, { pubKey, userAddress, legacy, legacyKey: LEGACY_RECORDS_KEY, newKey: RECORDS_V2_KEY, chain: ChainType.BITCOIN_MAINNET })
  await context.route('**/*', async (route: any) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(origin).origin) return route.continue()
    if (!/^open-api(?:-[a-z0-9-]+)?\.unisat\.io$/.test(url.hostname)) { control.externalUnexpected.push(url.origin); return route.abort() }
    let data: any
    if (url.pathname.endsWith('/blockchain/info')) {
      control.blockchainRequests++
      control.blockchainOrigins.push(url.origin)
      const failed = control.apiFailure
      data = { chain: 'fixture-only', blocks: 900000, headers: 900000, bestBlockHash: '11'.repeat(32), prevBlockHash: '22'.repeat(32), medianTime: control.medianTime, chainwork: '00ff', ...control.chainMetadata }
      if (control.holdChain) {
        control.holdChain = false
        await new Promise<void>((resolveChain) => { control.releaseChain = resolveChain })
      }
      if (failed) return route.fulfill({ status: 503, body: 'Synthetic chain-time failure' })
    } else if (url.pathname.endsWith('/fees/recommended')) { control.feeRequests++; if (control.holdFees) await new Promise<void>((resolveFees) => { control.releaseFees = resolveFees }); data = { fastestFee: control.holdFees ? 17 : 1 } }
    else if (url.pathname.endsWith('/brc20/summary')) data = { total: 1, detail: [{ ticker: 'test', availableBalance: '1000' }] }
    else if (url.pathname.endsWith('/runes/balance-list')) data = { total: 1, detail: [{ runeid: '840000:1', rune: 'TEST', amount: '1000' }] }
    else if (url.pathname.endsWith('/runes/840000%3A1/info')) data = { runeid: '840000:1', rune: 'TEST' }
    else if (url.pathname.endsWith('/runes/840000%3A1/utxo')) data = { utxo: [{ ...utxo('44', 330), address: userAddress, runes: [{ runeid: '840000:1', amount: '1000' }] }] }
    else if (url.pathname.endsWith('/available-utxo-data')) data = { utxo: [utxo('55', 100000)] }
    else if (url.pathname.endsWith('/balance')) data = { address: userAddress, satoshi: 100000, pendingSatoshi: 0, utxoCount: 1 }
    else { control.externalUnexpected.push(url.pathname); return route.abort() }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) })
  })
  try {
    await page.goto(`${origin}${initialHash}`)
    if (initialHash !== '#/cltv') await page.getByText('LEGACY', { exact: true }).waitFor()
    await page.getByText('Bitcoin Mainnet', { exact: true }).waitFor()
    await run(page, control)
    assert.deepEqual(faults, [], `${name}: page errors`)
    assert.deepEqual(control.externalUnexpected, [], `${name}: unexpected external calls (all blocked)`)
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`${name}: browser faults`, faults)
    await page.screenshot({ path: resolve(artifacts, `failure-${passed + 1}.png`), fullPage: true })
    throw error
  } finally { await context.close() }
}

async function choose(page: any, id: string, text: string) {
  await page.locator(`#${id}`).click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: text }).first().click()
}
async function switchWorkspace(page: any, workspace: 'csv' | 'cltv') {
  await page.getByRole('navigation', { name: 'Lock workspaces' }).getByRole('link', { name: new RegExp(`^${workspace.toUpperCase()}`) }).click()
  await page.getByRole('region', { name: `${workspace.toUpperCase()} workspace`, exact: true }).waitFor()
  assert.equal(new URL(page.url()).hash, `#/${workspace}`)
}
async function configure(page: any, kind = 'runes', date = '2040-01-01T00:00') {
  await switchWorkspace(page, 'cltv')
  if (kind === 'runes') await page.getByText('Rune / Runestone', { exact: true }).click()
  await choose(page, 'asset-reference', kind === 'runes' ? 'TEST' : 'test')
  await page.locator('#transfer-amount').fill('10')
  await page.locator('#lock-date').fill(date)
}
async function confirmCreate(page: any, expectedLock = '2040-01-01 00:00:00 UTC') {
  await page.getByRole('button', { name: 'Lock Asset', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.ok((await page.getByRole('dialog').innerText()).includes(expectedLock))
  await page.getByRole('button', { name: 'Confirm Lock', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
}
async function records(page: any) { return page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '[]'), RECORDS_V2_KEY) }
async function waitForSaved(page: any, status: string) { await page.waitForFunction(({ key, status }: any) => JSON.parse(localStorage.getItem(key) || '[]').some((item: any) => item.status === status), { key: RECORDS_V2_KEY, status }) }

try {
  for (const kind of ['brc20', 'runes']) {
    await scenario(`CLTV unlock test: ${kind} skips only MTP once, keeps the PSBT and reports wallet broadcast rejection`, async (page, control) => {
      await page.evaluate(() => {
        const fixture = (window as any).fixture
        fixture.chain = 'FRACTAL_BITCOIN_MAINNET'
        fixture.emit('chainChanged')
      })
      await page.getByText('Fractal Mainnet', { exact: true }).waitFor()
      await configure(page, kind)
      await confirmCreate(page)
      await waitForSaved(page, 'locked')
      const saved = (await records(page))[0]
      const initialSigns = control.signCalls
      const initialPushes = control.broadcastCalls
      await page.getByRole('button', { name: /Check & Unlock/ }).click()
      await page.getByText(/Fixed date not yet mature/).first().waitFor()
      assert.equal(control.signCalls, initialSigns)
      const testButton = page.getByRole('button', { name: 'Test Unlock (skip MTP)', exact: true })
      await testButton.click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      const text = await dialog.innerText()
      assert.ok(text.includes(`${saved.inscriptionTxid}:${saved.inscriptionVout}`))
      assert.ok(text.includes('FRACTAL_BITCOIN_MAINNET'))
      assert.ok(text.includes('2040-01-01 00:00:00 UTC'))
      assert.ok(text.includes('may actually unlock'))
      assert.equal(await testButton.isDisabled(), true)
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(control.signCalls, initialSigns)
      assert.equal(control.broadcastCalls, initialPushes)
      // Missing chain metadata cannot turn this explicit test back into a web maturity check.
      control.apiFailure = true
      const chainCalls = control.blockchainRequests
      control.failBroadcastAt = initialPushes + 1
      control.broadcastError = 'non-final (synthetic node response; no live transaction)'
      await testButton.click()
      await page.getByRole('button', { name: 'Sign & Try Broadcast', exact: true }).click()
      await page.getByText(/CLTV test — wallet broadcast:.*non-final/).first().waitFor()
      assert.equal(control.blockchainRequests, chainCalls)
      assert.equal(control.signCalls, initialSigns + 1)
      assert.equal(control.broadcastCalls, initialPushes + 1)
      assert.deepEqual((await records(page))[0], saved, 'rejection must not change the locked record')
      const expected = buildTimeLockUnlockTx({
        userAddress, pubKey, lock: saved.lock, chain: saved.chain, feeRate: 1,
        inscriptionUtxo: { txid: saved.inscriptionTxid, vout: saved.inscriptionVout, satoshi: saved.inscriptionSatoshi, scriptPk: '' },
        feeUtxos: [utxo('55', 100000)],
      })
      assert.equal(control.signed.at(-1), expected.psbtHex, 'test path must not rewrite the unlocking transaction')
      const psbt = bitcoin.Psbt.fromHex(control.signed.at(-1)!)
      assert.equal(psbt.locktime, timestamp)
      assert.equal(psbt.txInputs[0].sequence, 0xffff_fffe)
      assert.equal(psbt.txOutputs[0].value, kind === 'brc20' ? 546 : 330)
      // The next normal attempt still enforces the web guard, even in the same tab.
      control.apiFailure = false
      await page.getByRole('button', { name: /Check & Unlock/ }).click()
      await page.getByText(/Fixed date not yet mature/).first().waitFor()
      assert.equal(control.signCalls, initialSigns + 1)
      await page.reload()
      await page.getByText('Bitcoin Mainnet', { exact: true }).waitFor()
      await page.evaluate(() => {
        const fixture = (window as any).fixture
        fixture.chain = 'FRACTAL_BITCOIN_MAINNET'
        fixture.emit('chainChanged')
      })
      await page.getByText('Fractal Mainnet', { exact: true }).waitFor()
      await page.getByRole('button', { name: /Check & Unlock/ }).click()
      await page.getByText(/Fixed date not yet mature/).first().waitFor()
      assert.equal(control.signCalls, initialSigns + 1)
      await page.setViewportSize({ width: 375, height: 812 })
      await testButton.click()
      await dialog.waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      const modalOverflow = await dialog.evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth)
      assert.equal(modalOverflow, false)
      await page.screenshot({ path: resolve(artifacts, `cltv-unlock-test-${kind}-mobile.png`), fullPage: true, animations: 'disabled' })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await switchWorkspace(page, 'csv')
      assert.equal(await testButton.count(), 0, 'CSV has no CLTV test entry')
    })
  }
  for (const change of ['account', 'chain', 'record']) {
    await scenario(`CLTV unlock test: ${change} change during confirmation still blocks signing`, async (page, control) => {
      await configure(page)
      await confirmCreate(page)
      await waitForSaved(page, 'locked')
      await page.getByRole('button', { name: 'Test Unlock (skip MTP)', exact: true }).click()
      await page.getByRole('dialog').waitFor()
      await page.evaluate(({ change, key }: any) => {
        const fixture = (window as any).fixture
        if (change === 'account') { fixture.address = 'bc1qfixtureotheraccount'; fixture.emit('accountsChanged') }
        if (change === 'chain') { fixture.chain = 'FRACTAL_BITCOIN_MAINNET'; fixture.emit('chainChanged') }
        if (change === 'record') { const saved = JSON.parse(localStorage.getItem(key)!); saved[0].amount = '99'; localStorage.setItem(key, JSON.stringify(saved)) }
      }, { change, key: RECORDS_V2_KEY })
      await page.getByRole('button', { name: 'Sign & Try Broadcast', exact: true }).click()
      await page.getByText(/CLTV test — preparation:/).first().waitFor()
      assert.equal(control.signCalls, 1)
      assert.equal(control.broadcastCalls, 1)
    })
  }
  await scenario('CLTV unlock test: post-sign identity change still prevents broadcasting', async (page, control) => {
    await configure(page)
    await confirmCreate(page)
    await waitForSaved(page, 'locked')
    await page.evaluate(() => { (window as any).fixture.changeAfterSign = 'account' })
    await page.getByRole('button', { name: 'Test Unlock (skip MTP)', exact: true }).click()
    await page.getByRole('button', { name: 'Sign & Try Broadcast', exact: true }).click()
    await page.getByText(/CLTV test — post-sign checks:/).first().waitFor()
    assert.equal(control.signCalls, 2)
    assert.equal(control.broadcastCalls, 1)
    assert.equal((await records(page))[0].status, 'locked')
  })
  await scenario('CLTV unlock test: wallet signing rejection is not labeled a broadcast rejection', async (page, control) => {
    await configure(page)
    await confirmCreate(page)
    await waitForSaved(page, 'locked')
    await page.evaluate(() => { (window as any).unisat.signPsbt = async () => { throw new Error('Synthetic wallet declined signing') } })
    await page.getByRole('button', { name: 'Test Unlock (skip MTP)', exact: true }).click()
    await page.getByRole('button', { name: 'Sign & Try Broadcast', exact: true }).click()
    await page.getByText(/CLTV test — wallet signing:.*Synthetic wallet declined signing/).first().waitFor()
    assert.equal(control.broadcastCalls, 1)
    assert.equal((await records(page))[0].status, 'locked')
  })
  await scenario('CLTV unlock test: a reported broadcast is recorded without claiming early unlock or confirmation', async (page, control) => {
    await configure(page)
    await confirmCreate(page)
    await waitForSaved(page, 'locked')
    control.medianTime = timestamp + 1
    await page.getByRole('button', { name: 'Test Unlock (skip MTP)', exact: true }).click()
    await page.getByRole('button', { name: 'Sign & Try Broadcast', exact: true }).click()
    await waitForSaved(page, 'unlocked')
    await page.getByText('CLTV test unlock (confirmation not checked) transaction broadcasted', { exact: true }).waitFor()
    assert.equal(control.signCalls, 2)
    assert.equal(control.broadcastCalls, 2)
    assert.ok((await records(page))[0].unlockTxid)
  })
  for (const options of [
    { timezoneId: 'Asia/Shanghai', deviceTime: '2090-01-01T00:00:00Z' },
    { timezoneId: 'America/Los_Angeles', deviceTime: '2000-01-01T00:00:00Z' },
  ]) {
    await scenario(`Fractal MTP default and future target ignore device time in ${options.timezoneId}`, async (page, control) => {
      await page.evaluate(() => {
        const fixture = (window as any).fixture
        fixture.chain = 'FRACTAL_BITCOIN_MAINNET'
        fixture.emit('chainChanged')
      })
      await page.getByText('Fractal Mainnet', { exact: true }).waitFor()
      await switchWorkspace(page, 'cltv')
      await page.waitForFunction(() => (document.querySelector('#lock-date') as HTMLInputElement)?.value === '2039-12-31 23:58:20')
      assert.equal(await page.locator('#lock-date').getAttribute('type'), 'text')
      assert.ok((await page.locator('.chain-time-status').innerText()).includes('2039-12-31 23:58:20 UTC'))
      assert.ok(!(await page.locator('body').innerText()).includes('Local preview:'))
      await configure(page)
      assert.equal(await page.getByRole('button', { name: 'Lock Asset', exact: true }).isDisabled(), false)
      await page.locator('#lock-date').fill('2039-12-31 23:58:19')
      assert.ok((await page.locator('#lock-date-error').innerText()).includes('chain MTP'))
      assert.equal(await page.getByRole('button', { name: 'Lock Asset', exact: true }).isDisabled(), true)
      await page.locator('#lock-date').fill('2040-01-01 00:00:00')
      await confirmCreate(page)
      await waitForSaved(page, 'locked')
      const saved = (await records(page))[0]
      assert.deepEqual(saved.lock, { kind: 'cltv_time', timestamp })
      assert.equal(saved.chain, ChainType.FRACTAL_BITCOIN_MAINNET)
      assert.equal(control.signCalls, 1)
      assert.ok(control.blockchainOrigins.every((origin: string) => origin === 'https://open-api-fractal.unisat.io'))
      await page.setViewportSize({ width: 375, height: 812 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.screenshot({ path: resolve(artifacts, `mtp-default-${options.deviceTime.slice(0, 4)}.png`), fullPage: true, animations: 'disabled' })
    }, '#/csv', options)
  }
  await scenario('MTP refresh, expiry, API-key changes and invalid text preserve the explicit target', async (page, control) => {
    await configure(page)
    const target = '2040-01-01T00:00'
    const button = page.getByRole('button', { name: 'Lock Asset', exact: true })
    const refresh = page.getByRole('button', { name: 'Refresh Chain Time', exact: true })
    control.medianTime = timestamp - 50
    await refresh.click()
    await page.getByText('2039-12-31 23:59:10 UTC', { exact: true }).waitFor()
    assert.equal(await page.locator('#lock-date').inputValue(), target)
    await page.clock.fastForward(61_000)
    await page.getByText(/Previous chain-time check expired/).waitFor()
    assert.equal(await button.isDisabled(), true)
    assert.equal(await page.locator('#lock-date').inputValue(), target)
    control.apiFailure = true
    await refresh.click()
    await page.getByText(/OpenAPI HTTP 503/).waitFor()
    assert.equal(await button.isDisabled(), true)
    assert.equal(await page.locator('#lock-date').inputValue(), target)
    control.apiFailure = false
    await refresh.click()
    await page.getByText('2039-12-31 23:59:10 UTC', { exact: true }).waitFor()
    assert.equal(await button.isDisabled(), false)
    await page.locator('#lock-date').fill('2040-02-30 00:00:00')
    assert.equal(await button.isDisabled(), true, 'invalid text cannot leave the old target actionable')
    assert.ok((await page.locator('#lock-date-error').innerText()).includes('Invalid UTC'))
    await page.locator('#lock-date').fill('')
    await refresh.click()
    await page.getByText('2039-12-31 23:59:10 UTC', { exact: true }).waitFor()
    assert.equal(await page.locator('#lock-date').inputValue(), '', 'clearing is an edit, not a request to reinitialize')
    await page.getByRole('button', { name: 'Use Chain MTP', exact: true }).click()
    assert.equal(await page.locator('#lock-date').inputValue(), '2039-12-31 23:59:10')
    assert.equal(await button.isDisabled(), true, 'the MTP starting point itself is not a future lock')
    await page.locator('#lock-date').fill(target)
    const calls = control.blockchainRequests
    await page.getByPlaceholder('Paste the key from developer.unisat.io').fill('different-synthetic-key')
    await page.getByText('Unknown — load chain MTP; device time is not used.', { exact: true }).waitFor()
    assert.equal(control.blockchainRequests, calls, 'API-key edits do not automatically query MTP')
    assert.equal(await page.locator('#lock-date').inputValue(), target)
    assert.equal(await button.isDisabled(), true)
    await refresh.click()
    await page.getByText('2039-12-31 23:59:10 UTC', { exact: true }).waitFor()
    assert.equal(await button.isDisabled(), false)
    assert.equal(control.signCalls, 0)
    assert.equal(control.broadcastCalls, 0)
  }, '#/csv', { deviceTime: '2026-09-11T00:00:00Z' })
  for (const change of ['network', 'api-key']) {
    await scenario(`a stale MTP failure cannot replace the new ${change} snapshot`, async (page, control) => {
      await configure(page)
      await page.getByText('2039-12-31 23:58:20 UTC', { exact: true }).waitFor()
      await page.exposeFunction('isFixtureChainHeld', () => !!control.releaseChain)
      control.holdChain = true
      control.apiFailure = true
      const staleResponse = page.waitForResponse((response: any) => response.url() === 'https://open-api.unisat.io/v1/indexer/blockchain/info')
      await page.getByRole('button', { name: 'Refresh Chain Time', exact: true }).click()
      await page.waitForFunction(async () => (window as any).isFixtureChainHeld())
      control.apiFailure = false
      control.medianTime = timestamp - 25
      if (change === 'network') {
        await page.evaluate(() => {
          const fixture = (window as any).fixture
          fixture.chain = 'FRACTAL_BITCOIN_MAINNET'
          fixture.emit('chainChanged')
        })
        await page.getByText('Fractal Mainnet', { exact: true }).waitFor()
      } else {
        await page.getByPlaceholder('Paste the key from developer.unisat.io').fill('replacement-synthetic-key')
        await page.getByText('Unknown — load chain MTP; device time is not used.', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Refresh Chain Time', exact: true }).click()
      }
      await page.getByText('2039-12-31 23:59:35 UTC', { exact: true }).waitFor()
      control.releaseChain()
      await staleResponse
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.ok((await page.locator('.chain-time-status').innerText()).includes('2039-12-31 23:59:35 UTC'))
      assert.ok(!(await page.locator('.chain-time-status').innerText()).includes('Synthetic chain-time failure'))
      assert.equal(await page.locator('#lock-date').inputValue(), '2040-01-01T00:00')
      assert.equal(control.signCalls, 0)
    })
  }
  await scenario('Rune CLTV create, new namespace, UTC and strict unlock MTP boundaries', async (page, control) => {
    const oldRaw = await page.evaluate((key: string) => localStorage.getItem(key), LEGACY_RECORDS_KEY)
    assert.equal(await page.locator('#lock-blocks').inputValue(), '3')
    await configure(page)
    await confirmCreate(page)
    await waitForSaved(page, 'locked')
    const saved = (await records(page))[0]
    assert.deepEqual(saved.lock, { kind: 'cltv_time', timestamp })
    assert.equal(saved.recordVersion, 2)
    assert.equal(saved.lockBlocks, undefined)
    assert.equal(await page.evaluate((key: string) => localStorage.getItem(key), LEGACY_RECORDS_KEY), oldRaw)
    assert.equal(control.signCalls, 1)
    assert.equal(control.broadcastCalls, 1)
    assert.ok((await page.locator('.chain-time-status').innerText()).includes('2039-12-31 23:58:20 UTC'))
    const button = page.getByRole('button', { name: /Check & Unlock/ })
    control.medianTime = timestamp
    await button.click()
    await page.getByText(/Fixed date not yet mature/).first().waitFor()
    assert.equal(control.signCalls, 1)
    control.apiFailure = true
    await button.click()
    await page.getByText(/OpenAPI HTTP 503/).first().waitFor()
    assert.equal(control.signCalls, 1)
    control.apiFailure = false
    control.medianTime = timestamp + 1
    await button.click()
    await waitForSaved(page, 'unlocked')
    const unlock = bitcoin.Psbt.fromHex(control.signed.at(-1)!)
    assert.equal(unlock.locktime, timestamp)
    assert.equal(unlock.txInputs[0].sequence, 0xffff_fffe)
    assert.equal(control.signCalls, 2)
    await page.waitForFunction(() => !document.querySelector('.ant-message-notice'))
    await page.setViewportSize({ width: 375, height: 812 })
    await page.screenshot({ path: resolve(artifacts, 'cltv-records-mobile.png'), fullPage: true, animations: 'disabled' })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert.equal(overflow, false, 'mobile horizontal overflow')
  })
  await scenario('Fractal CLTV accepts ancillary metadata variants but still blocks invalid or immature MTP', async (page, control) => {
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.chain = 'FRACTAL_BITCOIN_MAINNET'
      fixture.emit('chainChanged')
    })
    await page.getByText('Fractal Mainnet', { exact: true }).waitFor()
    control.chainMetadata = { chain: '', chainwork: '' }
    await configure(page)
    await confirmCreate(page)
    await waitForSaved(page, 'locked')
    assert.equal((await records(page))[0].chain, ChainType.FRACTAL_BITCOIN_MAINNET)
    assert.equal(control.signCalls, 1)
    const unlockButton = page.getByRole('button', { name: /Check & Unlock/ })
    control.chainMetadata = { chain: undefined, chainwork: undefined }
    control.medianTime = undefined
    await unlockButton.click()
    await page.getByText(/invalid medianTime/).first().waitFor()
    assert.equal(control.signCalls, 1)
    control.medianTime = timestamp
    await unlockButton.click()
    await page.getByText(/Fixed date not yet mature/).first().waitFor()
    assert.equal(control.signCalls, 1)
    control.chainMetadata = { chain: 'fractal-fixture', chainwork: '0x00ff' }
    control.medianTime = timestamp + 1
    await unlockButton.click()
    await waitForSaved(page, 'unlocked')
    assert.equal(control.signCalls, 2)
    assert.ok(control.blockchainOrigins.length > 0)
    assert.ok(control.blockchainOrigins.every((origin: string) => origin === 'https://open-api-fractal.unisat.io'))
  })
  await scenario('invalid and past date remain local errors; MTP failure cannot sign', async (page, control) => {
    await configure(page, 'runes', '2000-01-01T00:00')
    assert.ok((await page.locator('#lock-date-error').innerText()).includes('future'))
    assert.equal(await page.getByRole('button', { name: 'Lock Asset', exact: true }).isDisabled(), true)
    await page.locator('#lock-date').fill('')
    assert.ok((await page.locator('#lock-date-error').innerText()).includes('Enter'))
    assert.equal(control.signCalls, 0)
    for (const date of ['2106-02-07T06:28:14', '2106-02-07T06:28:15']) {
      await page.locator('#lock-date').fill(date)
      assert.ok((await page.locator('#lock-date-error').innerText()).includes('cannot confirm'))
      assert.equal(await page.getByRole('button', { name: 'Lock Asset', exact: true }).isDisabled(), true)
    }
    await page.locator('#lock-date').fill('2040-01-01T00:00')
    control.apiFailure = true
    await confirmCreate(page)
    await page.getByText(/OpenAPI HTTP 503/).first().waitFor()
    assert.equal(control.signCalls, 0)
    assert.equal(control.broadcastCalls, 0)
    await page.waitForFunction(() => !document.querySelector('.ant-message-notice'))
    await page.screenshot({ path: resolve(artifacts, 'cltv-form-error-desktop.png'), fullPage: true, animations: 'disabled' })
  })
  await scenario('unconfirmable recovered date is preserved and never marked mature', async (page, control) => {
    const target = 0xffff_fffe
    const address = deriveTimeLockAddress(pubKey, { kind: 'cltv_time', timestamp: target }, ChainType.BITCOIN_MAINNET)
    await page.evaluate(({ legacy, key, pubKey, target, address }: any) => {
      const { lockBlocks, ...fields } = legacy
      localStorage.setItem(key, JSON.stringify([{ ...fields, id: 'upper-bound-fixture', recordVersion: 2, ownerPubKey: pubKey, lock: { kind: 'cltv_time', timestamp: target }, timeLockAddress: address }]))
      window.dispatchEvent(new StorageEvent('storage', { key }))
    }, { legacy, key: RECORDS_V2_KEY, pubKey, target, address })
    await switchWorkspace(page, 'cltv')
    await page.getByText(/This fixed date cannot confirm an unlock/).first().waitFor()
    control.medianTime = 0xffff_ffff
    await page.getByRole('button', { name: 'Refresh Chain Time', exact: true }).click()
    await page.getByText(/2106-02-07 06:28:15 UTC/).first().waitFor()
    assert.equal(await page.getByText('Target passed at the last MTP check; rechecked before signing.', { exact: true }).count(), 0)
    await page.getByRole('button', { name: /Check & Unlock/ }).click()
    await page.getByText(/The saved condition has not been changed/).first().waitFor()
    assert.equal(control.signCalls, 0)
    assert.equal(control.broadcastCalls, 0)
    assert.equal((await records(page))[0].lock.timestamp, target)
  })
  await scenario('new-schema CSV record reports its actual block delay on early unlock', async (page, control) => {
    await page.evaluate(({ legacy, key, pubKey }: any) => {
      const { lockBlocks, ...fields } = legacy
      localStorage.setItem(key, JSON.stringify([{ ...fields, id: 'modern-csv-fixture', ticker: 'MODERNCSV', recordVersion: 2, ownerPubKey: pubKey, lock: { kind: 'csv_blocks', blocks: lockBlocks } }]))
      window.dispatchEvent(new StorageEvent('storage', { key }))
    }, { legacy, key: RECORDS_V2_KEY, pubKey })
    control.failBroadcastAt = 1
    control.broadcastError = 'non-BIP68-final'
    const row = page.locator('.ant-list-item').filter({ hasText: 'MODERNCSV' })
    await row.getByRole('button', { name: /Unlock/ }).click()
    await page.getByText(/Wait for 3 confirmations/).first().waitFor()
    assert.equal(control.blockchainRequests, 0, 'CSV must not acquire a new MTP dependency')
    assert.equal((await records(page))[0].status, 'locked')
  })
  await scenario('BRC pending resume preserves signed chain and original expired fixed date', async (page, control) => {
    await configure(page, 'brc20')
    control.failBroadcastAt = 3
    await confirmCreate(page)
    await page.getByText(/Synthetic broadcast interruption/).first().waitFor()
    const pending = (await records(page))[0]
    assert.equal(pending.status, 'pending')
    assert.equal(pending.broadcastStep, 2)
    assert.equal(pending.pendingPsbts.length, 5)
    assert.equal(control.signCalls, 5)
    await switchWorkspace(page, 'csv')
    assert.equal(await page.getByRole('button', { name: 'Continue Broadcast' }).count(), 0)
    await choose(page, 'asset-reference', 'test')
    await page.locator('#transfer-amount').fill('1')
    await page.getByRole('button', { name: 'Lock Asset', exact: true }).click()
    await page.getByText(/Open the CLTV \(#\/cltv\) workspace/).first().waitFor()
    assert.equal(control.signCalls, 5, 'hidden CLTV pending must still block CSV BRC creation')
    await switchWorkspace(page, 'cltv')
    assert.equal(await page.locator('#lock-date').inputValue(), '2040-01-01T00:00')
    control.medianTime = timestamp + 1
    await page.reload()
    await page.getByRole('button', { name: 'Continue Broadcast' }).click()
    await page.getByRole('button', { name: 'Continue Original Chain' }).waitFor()
    assert.ok((await page.getByRole('dialog').innerText()).includes('2040-01-01 00:00:00 UTC'))
    await page.getByRole('button', { name: 'Continue Original Chain' }).click()
    await waitForSaved(page, 'locked')
    const complete = (await records(page))[0]
    assert.deepEqual(complete.lock, pending.lock)
    assert.equal(complete.inscriptionTxid, pending.inscriptionTxid)
    assert.equal(control.signCalls, 5, 'resume must not re-sign or rebuild')
    assert.deepEqual(control.broadcasts, pending.pendingPsbts)
  })
  for (const change of ['account', 'chain']) {
    await scenario(`wallet ${change} change after signing cancels broadcast`, async (page, control) => {
      await configure(page)
      await page.evaluate((change: string) => { (window as any).fixture.changeAfterSign = change }, change)
      await confirmCreate(page)
      await page.getByText(/Operation stopped/).first().waitFor()
      assert.equal(control.signCalls, 1)
      assert.equal(control.broadcastCalls, 0)
      assert.deepEqual(await records(page), [])
    })
  }
  await scenario('BRC account change after submitted broadcast retains pending progress', async (page, control) => {
    await configure(page, 'brc20')
    await page.evaluate(() => { (window as any).fixture.changeAfterPush = 'account' })
    await confirmCreate(page)
    await page.getByText(/Operation stopped/).first().waitFor()
    assert.equal(control.broadcastCalls, 1)
    const pending = (await records(page))[0]
    assert.equal(pending.broadcastStep, 1)
    assert.equal(pending.pendingPsbts.length, 5)
  })
  await scenario('legacy CSV unlock preserves its namespace and never adds CLTV precheck', async (page, control) => {
    await page.getByRole('button', { name: /Unlock/ }).click()
    await page.waitForFunction((key: string) => JSON.parse(localStorage.getItem(key)!)[0].status === 'unlocked', LEGACY_RECORDS_KEY)
    const old = await page.evaluate((key: string) => JSON.parse(localStorage.getItem(key)!)[0], LEGACY_RECORDS_KEY)
    assert.equal(old.lockBlocks, 3)
    assert.equal(old.recordVersion, undefined)
    assert.equal(control.blockchainRequests, 0)
    assert.deepEqual(await records(page), [])
  })
  await scenario('duplicate create clicks produce one frozen confirmation and one transaction', async (page, control) => {
    await configure(page)
    await page.getByRole('button', { name: 'Lock Asset', exact: true }).evaluate((button: HTMLElement) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1)
    await page.getByRole('dialog').screenshot({ path: resolve(artifacts, 'cltv-confirmation.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Confirm Lock', exact: true }).click()
    await waitForSaved(page, 'locked')
    assert.equal(control.signCalls, 1)
    assert.equal(control.broadcastCalls, 1)
  })
  await scenario('cross-tab records refresh and corrupt namespace is not silently overwritten', async (page) => {
    const other = await page.context().newPage()
    await other.goto(origin)
    await other.evaluate(({ key, record }: any) => localStorage.setItem(key, JSON.stringify([{ ...record, ticker: 'OTHER-TAB' }])), { key: LEGACY_RECORDS_KEY, record: legacy })
    await page.getByText('OTHER-TAB', { exact: true }).waitFor()
    await other.evaluate((key: string) => localStorage.setItem(key, '{broken'), LEGACY_RECORDS_KEY)
    await page.getByText('Local records unavailable for changes', { exact: true }).waitFor()
    assert.equal(await page.evaluate((key: string) => localStorage.getItem(key), LEGACY_RECORDS_KEY), '{broken')
    assert.equal(await page.getByRole('button', { name: 'Lock Asset', exact: true }).isDisabled(), true)
    await other.close()
  })
  await scenario('denied LocalStorage access reports an error without crashing the page', async (page) => {
    await page.evaluate(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Synthetic storage denied') } })
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
    })
    await page.getByText('Local records unavailable for changes', { exact: true }).first().waitFor()
    assert.ok((await page.locator('main').innerText()).includes('Synthetic storage denied'))
    assert.equal(await page.getByRole('button', { name: 'Lock Asset', exact: true }).isDisabled(), true)
  })
  await scenario('malformed optional legacy and v2 fields show an alert without crashing or rewriting', async (page, control) => {
    const { lockBlocks, ...fields } = legacy
    const modern = { ...fields, id: 'optional-field-fixture', recordVersion: 2, ownerPubKey: pubKey, lock: { kind: 'csv_blocks', blocks: lockBlocks } }
    for (const [key, record] of [[LEGACY_RECORDS_KEY, legacy], [RECORDS_V2_KEY, modern]] as const) {
      for (const field of ['runeName', 'unlockTxid']) {
        const raw = JSON.stringify([{ ...record, [field]: {} }], null, 2)
        await page.evaluate(({ key, raw, legacyKey, modernKey, legacy }: any) => {
          localStorage.setItem(legacyKey, JSON.stringify([legacy], null, 2))
          localStorage.removeItem(modernKey)
          localStorage.setItem(key, raw)
          window.dispatchEvent(new StorageEvent('storage', { key: null }))
        }, { key, raw, legacyKey: LEGACY_RECORDS_KEY, modernKey: RECORDS_V2_KEY, legacy })
        await page.getByText(new RegExp(`Invalid record ${field}`)).first().waitFor()
        assert.equal(await page.getByRole('heading', { name: 'Bitcoin Asset Time Lock', exact: true }).isVisible(), true)
        assert.equal(await page.evaluate((key: string) => localStorage.getItem(key), key), raw)
      }
    }
    assert.equal(control.signCalls, 0)
    assert.equal(control.broadcastCalls, 0)
  })
  for (const initialHash of ['#/csv', '#/cltv', '#/unknown']) {
    await scenario(`dedicated ${initialHash} entry and refresh keep the correct workspace`, async (page) => {
      const workspace = initialHash === '#/cltv' ? 'cltv' : 'csv'
      const check = async () => {
        assert.equal(new URL(page.url()).hash, `#/${workspace}`)
        assert.equal(await page.locator('#lock-mode').count(), 0)
        assert.equal(await page.locator('#lock-date').count(), workspace === 'cltv' ? 1 : 0)
        assert.equal(await page.locator('#lock-blocks').count(), workspace === 'csv' ? 1 : 0)
        assert.equal(await page.locator('.chain-time-status').count(), workspace === 'cltv' ? 1 : 0)
        assert.equal(await page.getByText('LEGACY', { exact: true }).count(), workspace === 'csv' ? 1 : 0)
      }
      await check()
      await page.reload()
      await page.getByRole('region', { name: `${workspace.toUpperCase()} workspace`, exact: true }).waitFor()
      await check()
    }, initialHash)
  }
  await scenario('workspace drafts and success/error feedback remain separate across navigation', async (page, control) => {
    await page.getByText('Rune / Runestone', { exact: true }).click()
    await choose(page, 'asset-reference', 'TEST')
    await page.locator('#transfer-amount').fill('12')
    await page.locator('#lock-blocks').fill('144')
    await page.locator('#fee-rate').fill('7')
    await confirmCreate(page, '144 relative blocks (CSV)')
    await waitForSaved(page, 'locked')
    assert.equal((await records(page))[0].lock.kind, 'csv_blocks')
    await configure(page, 'brc20')
    await page.locator('#fee-rate').fill('9')
    control.apiFailure = true
    await confirmCreate(page)
    await page.getByText(/OpenAPI HTTP 503/).first().waitFor()
    await switchWorkspace(page, 'csv')
    assert.equal(await page.locator('#transfer-amount').inputValue(), '12')
    assert.equal(await page.locator('#fee-rate').inputValue(), '7')
    assert.equal(await page.locator('#lock-blocks').inputValue(), '144')
    assert.equal(await page.getByText('Configure Rune Time Lock', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Asset transfer has been locked', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Operation failed', { exact: true }).count(), 0)
    assert.ok((await page.getByRole('region', { name: 'CSV workspace' }).innerText()).includes(csvGolden.addresses[144]))
    await page.screenshot({ path: resolve(artifacts, 'csv-workspace-desktop.png'), fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 375, height: 812 })
    await page.screenshot({ path: resolve(artifacts, 'csv-workspace-mobile.png'), fullPage: true, animations: 'disabled' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await switchWorkspace(page, 'cltv')
    assert.equal(await page.locator('#transfer-amount').inputValue(), '10')
    assert.equal(await page.locator('#fee-rate').inputValue(), '9')
    assert.equal(await page.locator('#lock-date').inputValue(), '2040-01-01T00:00')
    assert.equal(await page.getByText('Configure BRC-20 Time Lock', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Asset transfer has been locked', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Operation failed', { exact: true }).count(), 1)
    assert.equal(await page.locator('.ant-list-item').count(), 0)
    await page.locator('#lock-date').focus()
    await page.screenshot({ path: resolve(artifacts, 'cltv-workspace-mobile.png'), fullPage: true, animations: 'disabled' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  })
  await scenario('legacy and new-schema CSV records are grouped by condition, never by namespace', async (page) => {
    const { lockBlocks, ...fields } = legacy
    const modernCsv = { ...fields, id: 'csv-workspace-record', ticker: 'CSVNEW', recordVersion: 2, ownerPubKey: pubKey, lock: { kind: 'csv_blocks', blocks: lockBlocks } }
    const modernCltv = { ...fields, id: 'cltv-workspace-record', ticker: 'DATENEW', recordVersion: 2, ownerPubKey: pubKey, lock: { kind: 'cltv_time', timestamp }, timeLockAddress: deriveTimeLockAddress(pubKey, { kind: 'cltv_time', timestamp }, ChainType.BITCOIN_MAINNET) }
    const raw = JSON.stringify([modernCsv, modernCltv], null, 2)
    await page.evaluate(({ key, raw }: any) => { localStorage.setItem(key, raw); window.dispatchEvent(new StorageEvent('storage', { key })) }, { key: RECORDS_V2_KEY, raw })
    await page.getByText('CSVNEW', { exact: true }).waitFor()
    assert.equal(await page.getByText('LEGACY', { exact: true }).count(), 1)
    assert.equal(await page.getByText('DATENEW', { exact: true }).count(), 0)
    await switchWorkspace(page, 'cltv')
    assert.equal(await page.getByText('DATENEW', { exact: true }).count(), 1)
    assert.equal(await page.getByText('CSVNEW', { exact: true }).count(), 0)
    assert.equal(await page.getByText('LEGACY', { exact: true }).count(), 0)
    assert.equal(await page.evaluate((key: string) => localStorage.getItem(key), RECORDS_V2_KEY), raw)
  })
  await scenario('confirmation blocks hash edits and browser back without changing the frozen workspace', async (page, control) => {
    await configure(page)
    await page.getByRole('button', { name: 'Lock Asset', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByRole('navigation').getByRole('link', { name: /^CSV/ }).getAttribute('aria-disabled'), 'true')
    await page.evaluate(() => {
      const win = window as any
      win.fixture.hashChanges = 0
      window.addEventListener('hashchange', () => { win.fixture.hashChanges++ })
      history.back()
    })
    await page.waitForFunction(() => (window as any).fixture.hashChanges >= 1)
    assert.equal(new URL(page.url()).hash, '#/cltv')
    await page.evaluate(() => { location.hash = '#/csv' })
    await page.waitForFunction(() => (window as any).fixture.hashChanges >= 2)
    assert.equal(new URL(page.url()).hash, '#/cltv')
    assert.equal(await page.getByRole('region', { name: 'CLTV workspace', exact: true }).count(), 1)
    assert.ok((await page.getByRole('dialog').innerText()).includes('2040-01-01 00:00:00 UTC'))
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await switchWorkspace(page, 'csv')
    assert.equal(control.signCalls, 0)
  })
  await scenario('pending signing cannot navigate, and its eventual result stays in the originating page', async (page, control) => {
    await configure(page)
    control.holdSign = true
    await confirmCreate(page)
    await page.waitForFunction(() => (window as any).fixture.signing === true)
    await page.evaluate(() => { location.hash = '#/csv' })
    await page.waitForFunction(() => location.hash === '#/cltv')
    assert.equal(await page.getByRole('navigation').getByRole('link', { name: /^CSV/ }).getAttribute('aria-disabled'), 'true')
    assert.ok(control.releaseSign)
    control.releaseSign()
    await waitForSaved(page, 'locked')
    await switchWorkspace(page, 'csv')
    assert.equal(await page.getByText('Asset transfer has been locked', { exact: true }).count(), 0)
    await switchWorkspace(page, 'cltv')
    assert.equal(await page.getByText('Asset transfer has been locked', { exact: true }).count(), 1)
    assert.equal((await records(page))[0].lock.timestamp, timestamp)
  })
  await scenario('CSV pending BRC broadcasts also block creation from the CLTV workspace', async (page, control) => {
    await choose(page, 'asset-reference', 'test')
    await page.locator('#transfer-amount').fill('5')
    control.failBroadcastAt = 1
    await confirmCreate(page, '3 relative blocks (CSV)')
    await page.getByText(/Synthetic broadcast interruption/).first().waitFor()
    assert.equal((await records(page))[0].lock.kind, 'csv_blocks')
    await configure(page, 'brc20')
    await page.getByRole('button', { name: 'Lock Asset', exact: true }).click()
    await page.getByText(/Open the CSV \(#\/csv\) workspace/).first().waitFor()
    assert.equal(control.signCalls, 5)
    assert.equal(control.broadcastCalls, 1)
  })
  await scenario('fee recommendation does not overwrite either manual draft after a workspace switch', async (page, control) => {
    await page.locator('#fee-rate').fill('7')
    control.holdFees = true
    const request = page.waitForRequest((request: any) => request.url().endsWith('/fees/recommended'))
    await page.getByPlaceholder('Paste the key from developer.unisat.io').fill('another-synthetic-key')
    await request
    await switchWorkspace(page, 'cltv')
    await page.locator('#fee-rate').fill('9')
    assert.ok(control.releaseFees)
    control.releaseFees()
    await page.waitForResponse((response: any) => response.url().endsWith('/fees/recommended'))
    assert.equal(await page.locator('#fee-rate').inputValue(), '9')
    await switchWorkspace(page, 'csv')
    assert.equal(await page.locator('#fee-rate').inputValue(), '7')
    assert.equal(control.feeRequests, 2, 'workspace navigation must not start another fee request')
  })
  console.log(`${passed} local browser scenarios passed. Screenshots: ${artifacts}`)
} finally {
  await browser.close()
  await new Promise<void>((resolveClose) => server.httpServer.close(() => resolveClose()))
}
