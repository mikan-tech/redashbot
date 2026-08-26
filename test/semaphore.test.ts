import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSemaphore } from '../src/semaphore'

// 外部から解決できるPromiseを作り実行中のタスクを任意の順序で終わらせるために使う
function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('上限を超えて同時実行しない', async () => {
  const run = createSemaphore(2)
  const deferreds = [createDeferred(), createDeferred(), createDeferred()]
  let running = 0
  let maxRunning = 0

  const tasks = deferreds.map((deferred) =>
    run(async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await deferred.promise
      running -= 1
    }),
  )

  // 3件目は待機しているはずなので、この時点の同時実行数は2
  await Promise.resolve()
  assert.equal(maxRunning, 2)

  for (const deferred of deferreds) {
    deferred.resolve()
  }
  await Promise.all(tasks)

  assert.equal(maxRunning, 2)
  assert.equal(running, 0)
})

test('待機中のタスクは先に登録された順に実行する', async () => {
  const run = createSemaphore(1)
  const first = createDeferred()
  const order: number[] = []

  const tasks = [
    run(async () => {
      order.push(1)
      await first.promise
    }),
    run(async () => {
      order.push(2)
    }),
    run(async () => {
      order.push(3)
    }),
  ]

  first.resolve()
  await Promise.all(tasks)

  assert.deepEqual(order, [1, 2, 3])
})

test('タスクが失敗しても実行枠を解放する', async () => {
  const run = createSemaphore(1)

  await assert.rejects(
    run(async () => {
      throw new Error('task failed')
    }),
    /task failed/,
  )

  // 枠が解放されていなければここでデッドロックする
  const result = await run(async () => 'ok')
  assert.equal(result, 'ok')
})

test('タスクの戻り値をそのまま返す', async () => {
  const run = createSemaphore(1)
  const result = await run(async () => 42)
  assert.equal(result, 42)
})

test('上限に1未満を指定すると例外を投げる', () => {
  assert.throws(() => createSemaphore(0), /1以上の整数/)
  assert.throws(() => createSemaphore(-1), /1以上の整数/)
  assert.throws(() => createSemaphore(1.5), /1以上の整数/)
})
