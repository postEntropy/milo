import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CommandCodeModel {
  id: string
  description: string
}

export async function listCommandCodeModels(): Promise<CommandCodeModel[]> {
  const { stdout } = await execFileAsync('cmd', ['--list-models'], { timeout: 10_000, maxBuffer: 1_000_000 })
  return parseCommandCodeModels(stdout)
}

export function parseCommandCodeModels(output: string): CommandCodeModel[] {
  const models: CommandCodeModel[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z0-9][a-zA-Z0-9._:/-]*)\s{2,}(.+?)\s*$/.exec(line)
    if (match) models.push({ id: match[1]!, description: match[2]! })
  }
  if (models.length === 0) throw new Error('Command Code did not report any available models.')
  return models
}
