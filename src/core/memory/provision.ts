import path from 'node:path'
import { OLLAMA_URL, type MemoryConfig } from '../config/schema.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import {
  engineAnswers,
  freePort,
  installedEngine,
  installEngine,
  pullModel,
  startEngine,
  type InstallProgress,
} from './ollama.js'

export interface Provisioned {
  url: string
  model: string
  version: string
  /** The engine, left running. Whoever provisioned decides when to stop it. */
  stop(): void
}

/**
 * Everything the setup screen offers, in one call: fetch the engine, run it on a
 * private port with its models under Milo's own directory, and pull the model.
 *
 * The caller writes `url` and `model` into the config, which is what makes the
 * engine findable again on the next run: the port is chosen here and then fixed,
 * so a later Milo starts its engine on the port the config already names.
 */
export async function provisionEmbedding(options: {
  dir: string
  model: string
  apiBase?: string
  onProgress?: InstallProgress
  signal?: AbortSignal
}): Promise<Provisioned> {
  const report = options.onProgress ?? (() => undefined)

  const installed = await installEngine({
    dir: options.dir,
    apiBase: options.apiBase,
    onProgress: report,
    signal: options.signal,
  })

  const engine = await startEngine({
    binary: installed.binary,
    modelsDir: modelsDir(options.dir),
    port: await freePort(),
    onProgress: report,
  })

  try {
    await pullModel({
      url: engine.url,
      model: options.model,
      onProgress: report,
      signal: options.signal,
    })
  } catch (error) {
    // Nothing half-installed is left running: the config is only written by a
    // caller that gets this far.
    engine.stop()
    throw error
  }

  return { url: engine.url, model: options.model, version: installed.version, stop: engine.stop }
}

/** Where the engine's own models go. Milo's, so nothing else sees them. */
export function modelsDir(dir: string): string {
  return path.join(dir, 'models')
}

/**
 * Brings the engine up if embeddings are configured and nothing answers there.
 *
 * Called on the way in and not waited for: the first turn does not need
 * embeddings to answer, and recall already falls back to words while the engine
 * is starting. Only Milo's own copy is started — an engine someone else runs is
 * their business, and Milo merely talks to it.
 */
export function engineOnDemand(options: {
  embedding: MemoryConfig['embedding']
  dir: string
  onProgress?: InstallProgress
}): void {
  const embedding = options.embedding
  // Only the local one: a hosted embedder runs on someone else's machine, and
  // there is nothing here to start for it.
  if (embedding?.provider !== 'ollama') return

  const url = embedding.url ?? OLLAMA_URL

  void (async () => {
    const answers = await engineAnswers(url)
    if (answers) return

    const installed = await installedEngine(options.dir)
    if (!installed) return

    const port = Number(new URL(url).port || 11434)
    const engine = await startEngine({
      binary: installed.binary,
      modelsDir: modelsDir(options.dir),
      port,
      onProgress: options.onProgress,
    })
    // The engine belongs to this process: the CLI exits and it goes with it, so
    // nothing is left holding a port. `exit` is enough — killing a child needs no
    // asynchronous work, and a Milo that is killed outright leaves an engine that
    // the next run simply finds answering and adopts.
    process.once('exit', engine.stop)
  })().catch((error: unknown) => {
    logWarn(`could not start the embedding engine: ${errorMessage(error)}`)
  })
}
