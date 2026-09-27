import { describe, expect, it } from 'vitest'
import { TurnQueue } from '../src/gateways/turns.js'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

describe('TurnQueue', () => {
  it('runs one turn at a time per conversation', async () => {
    const queue = new TurnQueue()
    const order: string[] = []

    const work = (label: string, delay: number) => async () => {
      order.push(`${label}:start`)
      await tick(delay)
      order.push(`${label}:end`)
    }

    queue.run('chat-1', work('first', 30))
    queue.run('chat-1', work('second', 1))
    await tick(60)

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('does not hold up another conversation', async () => {
    const queue = new TurnQueue()
    const order: string[] = []

    queue.run('chat-1', async () => {
      order.push('slow:start')
      await tick(30)
      order.push('slow:end')
    })
    queue.run('chat-2', async () => {
      order.push('other')
    })
    await tick(50)

    // The second conversation finishes well before the first one does.
    expect(order).toEqual(['slow:start', 'other', 'slow:end'])
  })

  it('keeps going after a turn fails', async () => {
    const queue = new TurnQueue()
    const order: string[] = []

    queue.run('chat-1', async () => {
      order.push('boom')
      throw new Error('turn failed')
    })
    queue.run('chat-1', async () => {
      order.push('recovered')
    })
    await tick(30)

    expect(order).toEqual(['boom', 'recovered'])
  })

  it('forgets a conversation once it is idle', async () => {
    const queue = new TurnQueue()
    queue.run('chat-1', async () => undefined)
    await tick(30)

    expect(queue.size).toBe(0)
  })

  it('hands a message to the turn that is running', async () => {
    const queue = new TurnQueue()
    const seen: string[][] = []

    queue.run('chat-1', async (inbox) => {
      await tick(20)
      seen.push([...inbox])
    })
    await tick(5) // the turn has started; the inbox belongs to a running turn

    expect(queue.steer('chat-1', 'actually, use b.txt')).toBe(true)
    await tick(40)

    expect(seen).toEqual([['actually, use b.txt']])
  })

  it('says no when there is no turn to hand a message to', async () => {
    const queue = new TurnQueue()
    // Nothing running: the caller starts a turn instead, which is why this has
    // to be false rather than a message dropped on the floor.
    expect(queue.steer('chat-1', 'hello')).toBe(false)

    queue.run('chat-1', async () => undefined)
    await tick(30)
    expect(queue.steer('chat-1', 'hello')).toBe(false)
  })

  it('is busy while a turn runs, and not once it is over', async () => {
    const queue = new TurnQueue()
    expect(queue.busy('chat-1')).toBe(false)

    queue.run('chat-1', async () => {
      await tick(20)
    })
    await tick(5)
    expect(queue.busy('chat-1')).toBe(true)

    await tick(40)
    expect(queue.busy('chat-1')).toBe(false)
  })

  it('settles only once the queue has let the turn go', async () => {
    const queue = new TurnQueue()
    let resolveSettled: (busy: boolean) => void = () => undefined
    const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve })

    // What a surface waits on to announce "not busy any more". Read from inside
    // the turn's own body it would still say true, which is how a web page ends
    // up holding a stop button for a turn that is over.
    queue.run('chat-1', async () => {
      await tick(20)
    }, () => resolveSettled(queue.busy('chat-1')))

    await expect(settled).resolves.toBe(false)
  })
})
