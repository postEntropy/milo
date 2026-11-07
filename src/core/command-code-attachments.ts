import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { MAX_INCOMING_BYTES, MAX_INCOMING_TOTAL_BYTES, type IncomingFile } from './media.js'

async function mkdirIfMissing(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export async function saveCommandCodeAttachments(projectPath: string, sessionId: string, files: IncomingFile[]): Promise<string[]> {
  const total = files.reduce((size, file) => size + file.data.byteLength, 0)
  if (total > MAX_INCOMING_TOTAL_BYTES) throw new Error('Attachments together are larger than 50 MB.')
  for (const file of files) {
    if (file.data.byteLength === 0) throw new Error(`The selected file ${file.name} is empty.`)
    if (file.data.byteLength > MAX_INCOMING_BYTES) throw new Error(`${file.name} is larger than 50 MB.`)
  }
  if (!/^[a-z]+-[a-z]+-\d{1,3}$/.test(sessionId)) throw new Error('Invalid Command Code Session id.')
  const projectRoot = await realpath(projectPath)
  const parent = join(projectRoot, '.milo-attachments')
  await mkdirIfMissing(parent)
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('The Command Code attachment directory must stay inside the Work project.')
  const directory = join(parent, sessionId)
  await mkdirIfMissing(directory)
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('The Command Code attachment directory must stay inside the Work project.')
  const realDirectory = await realpath(directory)
  const directoryRelative = relative(projectRoot, realDirectory)
  if (directoryRelative === '..' || directoryRelative.startsWith(`..${sep}`) || isAbsolute(directoryRelative)) {
    throw new Error('The Command Code attachment directory must stay inside the Work project.')
  }
  const paths: string[] = []
  for (const file of files) {
    const name = basename(file.name.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '') || 'attachment'
    const destination = join(realDirectory, `${randomUUID()}-${name}`)
    await writeFile(destination, file.data, { flag: 'wx', mode: 0o600 })
    paths.push(relative(projectRoot, destination).split(sep).join('/'))
  }
  return paths
}
