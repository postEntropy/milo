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
})
