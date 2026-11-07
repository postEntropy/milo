import { describe, expect, it } from 'vitest'
import { parseCommandCodeModels } from '../src/core/command-code-models.js'

describe('Command Code model catalog', () => {
  it('reads model ids and descriptions from the CLI catalog', () => {
    expect(parseCommandCodeModels(`Open Source\n\nclaude-sonnet-5-5       recommended coding model\nprovider/model-a        long-context model\n\nPass the full id, or just the short name after the last "/":`)).toEqual([
      { id: 'claude-sonnet-5-5', description: 'recommended coding model' },
      { id: 'provider/model-a', description: 'long-context model' },
    ])
  })

  it('refuses an output with no model rows', () => {
    expect(() => parseCommandCodeModels('Open Source\n\nNo models')).toThrow('did not report any available models')
  })
})
