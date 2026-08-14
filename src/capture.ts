import playwright from 'playwright'
import sleep from 'await-sleep'
import { config } from './config'

const engine = playwright[config.browser]

export async function capture(url: string): Promise<Buffer> {
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
