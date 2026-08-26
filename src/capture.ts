import playwright from 'playwright'
import sleep from 'await-sleep'
import { config } from './config'
import { createSemaphore } from './semaphore'

const engine = playwright[config.browser]

// キャプチャの同時実行数を制限する
// Slackのリマインダーで複数のクエリが一斉に投稿されるとハンドラが並行して動くため、
// ここで絞らないとChromiumが同時に何個も起動してPID上限に到達する
const runWithLimit = createSemaphore(config.captureConcurrency)

export async function capture(url: string): Promise<Buffer> {
  return runWithLimit(() => captureWithBrowser(url))
}

async function captureWithBrowser(url: string): Promise<Buffer> {
  const browser = await engine.launch({
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  })
  let captureFailed = false

  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1024, height: 360 })
    await page.goto(url)
    try {
      await page.waitForResponse(/.json/, { timeout: config.sleep })
      await sleep(config.sleep)
    } catch {
      //
    }

    return await page.screenshot({ fullPage: true })
  } catch (error) {
    captureFailed = true
    throw error
  } finally {
    try {
      await browser.close()
    } catch (error) {
      if (!captureFailed) {
        throw error
      }

      console.error('Failed to close Playwright browser after capture failed', error)
    }
  }
}
