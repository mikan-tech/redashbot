// 同時実行数を制限するためのセマフォ
//
// Chromiumは1インスタンスあたり多数のプロセス・スレッドを生成するため、
// キャプチャを無制限に並行実行するとコンテナのPID上限に到達し、
// pthread_create が EAGAIN で失敗してChromiumがクラッシュする
// 実行枠を絞ることで瞬間的なプロセス数の跳ね上がりを抑える
export type Semaphore = <T>(task: () => Promise<T>) => Promise<T>

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`セマフォの上限は1以上の整数である必要があります: ${limit}`)
  }

  let running = 0
  const waiting: Array<(() => void) | undefined> = []
  let waitingHead = 0

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= limit) {
      // 枠が空くまで待つ
      // 枠は解放側から直接譲渡されるため、
      // ここで再開しても running を増やさない
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else {
      running += 1
    }

    try {
      return await task()
    } finally {
      const next = waiting[waitingHead]
      waiting[waitingHead] = undefined
      waitingHead += 1
      if (next) {
        // 枠を減らさずに待機中の処理へ譲渡する
        // ここで running を減らすと、待機側が再開するまでの間に
        // 別の呼び出しが枠を取り、上限を超えて実行されてしまう
        next()
      } else {
        running -= 1
        waiting.length = 0
        waitingHead = 0
      }
    }
  }
}
