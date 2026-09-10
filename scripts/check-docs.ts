/** Offline local-link check for this repository's authored Markdown, not a full Markdown parser or security scan. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function markdownIn(directory: string): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Documentation symlink is unsupported: ${directory}/${entry.name}`)
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) files.push(...await markdownIn(path))
    else if (entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

function withoutFences(text: string): string {
  // Keep line numbers stable; this repository uses backtick fences.
  return text.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
}

function headings(text: string): Set<string> {
  const anchors = new Set<string>()
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1].replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase().replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, '').replace(/\s/g, '-')
    let unique = slug
    for (let suffix = 1; anchors.has(unique); suffix++) unique = `${slug}-${suffix}`
    anchors.add(unique)
  }
  return anchors
}

const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...await markdownIn('docs')]
const failures: string[] = []
const anchorCache = new Map<string, Set<string>>()
let checked = 0
for (const file of files) {
  const source = withoutFences(await readFile(resolve(root, file), 'utf8'))
  for (const match of source.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1].replace(/^<|>$/g, '')
    if (/^(https?:|mailto:)/i.test(href)) continue
    const line = source.slice(0, match.index).split('\n').length
    const location = `${file}:${line}`
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href)) { failures.push(`${location}: unsupported non-relative link`); continue }
    try {
      const hashIndex = href.indexOf('#')
      const path = decodeURIComponent((hashIndex < 0 ? href : href.slice(0, hashIndex)).split('?')[0])
      const fragment = hashIndex < 0 ? '' : decodeURIComponent(href.slice(hashIndex + 1))
      const target = path ? resolve(root, dirname(file), path) : resolve(root, file)
      const fromRoot = relative(root, target)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error('link escapes repository')
      const metadata = await stat(target)
      if (fragment && metadata.isFile() && extname(target) === '.md') {
        if (!anchorCache.has(target)) anchorCache.set(target, headings(await readFile(target, 'utf8')))
        if (!anchorCache.get(target)!.has(fragment)) throw new Error(`missing heading #${fragment}`)
      }
      checked++
    } catch (error) {
      failures.push(`${location}: ${href}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Checked ${files.length} Markdown files and ${checked} local links (offline).`)
}
