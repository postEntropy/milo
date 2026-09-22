const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'clever', 'coral', 'crisp', 'eager',
  'fair', 'gentle', 'glad', 'grand', 'keen', 'kind', 'lively', 'lucky',
  'mellow', 'merry', 'mild', 'noble', 'polite', 'proud', 'quick', 'quiet',
  'rapid', 'shiny', 'silent', 'smooth', 'solid', 'steady', 'sunny', 'swift',
  'tidy', 'vivid', 'warm', 'wise',
]

const ANIMALS = [
  'badger', 'beaver', 'bison', 'condor', 'crane', 'donkey', 'falcon', 'ferret',
  'finch', 'gecko', 'heron', 'husky', 'ibis', 'koala', 'lemur', 'llama',
  'lynx', 'marmot', 'mole', 'moose', 'moth', 'newt', 'otter', 'owl',
  'panda', 'puffin', 'quail', 'raven', 'robin', 'salmon', 'seal', 'shrew',
  'sloth', 'stork', 'swan', 'tapir', 'toad', 'wolf', 'wren', 'yak',
]

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)]!
}

/**
 * A short, readable id (`calm-otter-7`). `isTaken` keeps it unique against
 * whatever the store already holds.
 */
export function generateNickname(isTaken: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${1 + Math.floor(Math.random() * 99)}`
    if (!isTaken(id)) return id
  }
  throw new Error('Could not find a free session id')
}
