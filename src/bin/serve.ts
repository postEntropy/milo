#!/usr/bin/env node
import { runServe } from '../gateways/serve.js'
import { errorMessage } from '../util/errors.js'

runServe().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
