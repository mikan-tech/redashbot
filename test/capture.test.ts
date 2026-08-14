import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import playwright from 'playwright'
import type { Page } from 'playwright'
import { capture } from '../src/capture'

type MockPage = {
  setViewportSize: (...args: Parameters<Page['setViewportSize']>) => Promise<void>
  goto: (...args: Parameters<Page['goto']>) => Promise<void>
  waitForResponse: (...args: Parameters<Page['waitForResponse']>) => Promise<void>
  screenshot: (...args: Parameters<Page['screenshot']>) => Promise<Buffer>
}

type MockBrowser = {
  newPage: () => Promise<MockPage>
  close: () => Promise<void>
}

const originalLaunch = playwright.chromium.launch

function stubLaunch(browser: MockBrowser) {
  Object.defineProperty(playwright.chromium, 'launch', {
    configurable: true,
    value: async () => browser,
  })
}

function restoreLaunch() {
  Object.defineProperty(playwright.chromium, 'launch', {
    configurable: true,
    value: originalLaunch,
  })
}

afterEach(restoreLaunch)

function createPage(overrides: Partial<MockPage> = {}): MockPage {
  return {
    setViewportSize: async () => undefined,
    goto: async () => undefined,
    waitForResponse: async () => undefined,
    screenshot: async () => Buffer.from('screenshot'),
    ...overrides,
  }
}

function createBrowser(page: MockPage, onClose: () => Promise<void>): MockBrowser {
  return {
    newPage: async () => page,
    close: onClose,
  }
}

test('正常終了時にブラウザを終了する', async () => {
  let closeCount = 0
  const browser = createBrowser(createPage(), async () => {
    closeCount += 1
  })
  stubLaunch(browser)

  const result = await capture('https://redash.example.com')

  assert.deepEqual(result, Buffer.from('screenshot'))
  assert.equal(closeCount, 1)
})

test('ページ生成に失敗してもブラウザを終了する', async () => {
  let closeCount = 0
  const browser: MockBrowser = {
    newPage: async () => {
      throw new Error('new page failed')
    },
    close: async () => {
      closeCount += 1
    },
  }
  stubLaunch(browser)

  await assert.rejects(capture('https://redash.example.com'), /new page failed/)
  assert.equal(closeCount, 1)
})

test('ページ遷移に失敗してもブラウザを終了する', async () => {
  let closeCount = 0
  const browser = createBrowser(
    createPage({
      goto: async () => {
        throw new Error('goto failed')
      },
    }),
    async () => {
      closeCount += 1
    },
  )
  stubLaunch(browser)

  await assert.rejects(capture('https://redash.example.com'), /goto failed/)
  assert.equal(closeCount, 1)
})

test('スクリーンショットに失敗してもブラウザを終了する', async () => {
  let closeCount = 0
  const browser = createBrowser(
    createPage({
      screenshot: async () => {
        throw new Error('screenshot failed')
      },
    }),
    async () => {
      closeCount += 1
    },
  )
  stubLaunch(browser)

  await assert.rejects(capture('https://redash.example.com'), /screenshot failed/)
  assert.equal(closeCount, 1)
})

test('キャプチャ失敗時は終了処理のエラーで元のエラーを隠さない', async () => {
  let closeCount = 0
  const originalConsoleError = console.error
  console.error = () => undefined
  const browser = createBrowser(
    createPage({
      goto: async () => {
        throw new Error('capture failed')
      },
    }),
    async () => {
      closeCount += 1
      throw new Error('close failed')
    },
  )
  stubLaunch(browser)

  try {
    await assert.rejects(capture('https://redash.example.com'), /capture failed/)
    assert.equal(closeCount, 1)
  } finally {
    console.error = originalConsoleError
  }
})
