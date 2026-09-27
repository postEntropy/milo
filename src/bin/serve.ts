#!/usr/bin/env node
import process from 'node:process'
import { runServe } from '../gateways/serve.js'
import { errorMessage } from '../util/errors.js'
import { parseArgs } from './args.js'
import { validateArgs } from './dispatch.js'

// The same flags `milo serve` takes, because this is the other way in: the
// bundled entry point (`npm run serve`, `dist/bin/serve.js`). Reading them only
// in `cli.ts` meant `milo serve --no-web` worked and `npm run serve -- --no-web`
// silently did not.
const args = parseArgs(process.argv.slice(2))
const problem = validateArgs(args)
if (problem) {
  console.error(problem)
  process.exitCode = 1
} else {
  runServe({ noWeb: args.noWeb, webPort: args.webPort }).catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
