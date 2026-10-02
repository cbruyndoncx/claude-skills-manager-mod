// Skills Manager mod: a port of the Obsidian Skills Manager plugin to Claude Code.
// Pane (/skills), slash subcommands, and a model tool over one shared engine.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AddForm, ChainView, Detail, Market, PlaybookDetail, PlaybookRow, PlaybookView, RegistrySkill, RegistryType, SkillRow, SkillState, Tab, View } from '../types'
import { chainList, chainMatrix, formatMatrix } from './lib/chains'
import { buildExport, buildIndex, EXPORT_TARGETS } from './lib/exporter'
import { ensureFrontmatter, extractBody, FRONTMATTER_TEMPLATE, setField, setList, TEMPLATE_FILENAME, toSkillMeta } from './lib/frontmatter'
import type { FrontmatterDefaults } from './lib/frontmatter'
import { encodePath, matchByName, parseRepo, parseSkillRef, pickSkillSubpath, sortReleases } from './lib/github'
import type { Release } from './lib/github'
import { filterPlaybooks, findPlaybook, runPrompt, toPlaybook } from './lib/playbooks'
import { filterSkills, parseRegistry, REGISTRIES, registryRequest } from './lib/registry'
import { scanSkill } from './lib/security'
import { isNewer } from './lib/semver'
import { groupZipSkills } from './lib/zip'

const PANE = 'skills-manager'
const STORE_KEY = 'skills'
const API = 'https://api.github.com'
const BUILTIN_CATEGORIES = ['marketing', 'seo', 'documents', 'diagramming', 'obsidian', 'notion', 'business', 'research', 'development', 'productivity', 'sales', 'utilities']

const skills = atom({ plugin: 'skills-manager', key: 'skills' } as const, [] as SkillRow[])
const view = atom({ plugin: 'skills-manager', key: 'view' } as const, {
  tab: 'installed', search: '', includeDesc: false, source: 'all', expanded: [], selected: '', confirmDelete: '', updates: {},
} as View)
const detail = atom({ plugin: 'skills-manager', key: 'detail' } as const, null as Detail)
const market = atom({ plugin: 'skills-manager', key: 'market' } as const, {
  registry: 'skills-sh', board: 'all-time', search: '', page: 0, results: [], hasMore: false, status: '', log: [], installed: [],
} as Market)
const addForm = atom({ plugin: 'skills-manager', key: 'add' } as const, { input: '', versions: [], version: '', status: '', zip: null } as AddForm)
const busy = atom({ plugin: 'skills-manager', key: 'busy' } as const, '')
const playbooks = atom({ plugin: 'skills-manager', key: 'playbooks' } as const, [] as PlaybookRow[])
const pbView = atom({ plugin: 'skills-manager', key: 'pbView' } as const, { search: '', status: '', chain: '', maturity: '', selected: '' } as PlaybookView)
const pbDetail = atom({ plugin: 'skills-manager', key: 'pbDetail' } as const, null as PlaybookDetail)
const chainView = atom({ plugin: 'skills-manager', key: 'chainView' } as const, { expanded: [], showEmpty: true } as ChainView)
const PINS_KEY = 'pinnedPlaybooks'
const PLAYBOOK_STATUSES = ['draft', 'active', 'retired']

type Opts = {
  skillsDir: string
  githubPat: string
  autoUpdate: boolean
  defaultCategory: string
  customCategories: string[]
  generateSkillsIndex: boolean
  crossToolExportEnabled: boolean
  crossToolExport: string[]
  skillsmpApiKey: string
  playbookFolders: string[]
  valueChains: string[]
}

const list = (v: unknown) => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean)

let O: Opts = readOptions({})
let CWD = ''

function readOptions(raw: Record<string, unknown>): Opts {
  return {
    skillsDir: String(raw.skillsDir || '.claude/skills').replace(/\/+$/, ''),
    githubPat: String(raw.githubPat || ''),
    autoUpdate: raw.autoUpdate !== false,
    defaultCategory: String(raw.defaultCategory || 'uncategorized'),
    customCategories: list(raw.customCategories),
    generateSkillsIndex: raw.generateSkillsIndex !== false,
    crossToolExportEnabled: raw.crossToolExportEnabled === true,
    crossToolExport: list(raw.crossToolExport).map(s => s.toLowerCase()),
    skillsmpApiKey: String(raw.skillsmpApiKey || ''),
    playbookFolders: list(raw.playbookFolders || '00-CORE/Playbooks, 20-COMPANY/03-PROCESSES/Playbooks, 10-ME/Playbooks, 30-CLIENTS').map(f => f.replace(/\/+$/, '')),
    valueChains: list(raw.valueChains).map(c => c.toLowerCase()),
  }
}

type InstallResult = { success: boolean; skillName: string; errors: string[] }
const fail = (skillName: string, ...errors: string[]): InstallResult => ({ success: false, skillName, errors })
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const skillDir = (folder: string) => `${O.skillsDir}/${folder}`
const absolute = (path: string) => (path.startsWith('/') || !CWD ? path : `${CWD}/${path}`)

// ─── Files and processes ─────────────────────────────────────

async function run($: any, argv: string[], timeoutMs = 120000): Promise<string> {
  const r = await $.process.run(argv, { timeoutMs })
  if (r.exitCode !== 0) throw new Error(`${argv[0]} failed: ${String(r.stderr || r.stdout).trim().slice(0, 200)}`)
  return r.stdout
}

async function readText($: any, path: string): Promise<string | undefined> {
  return $.fs.read(path).catch(() => undefined)
}

async function listDir($: any, path: string): Promise<{ name: string; kind: string; isLink: boolean }[]> {
  return $.fs.list(path).catch(() => [])
}

/** Every file under `root`, relative to it (dot-folders skipped, bounded depth). */
async function walk($: any, root: string, rel = '', depth = 0): Promise<string[]> {
  if (depth > 8) return []
  const out: string[] = []
  for (const entry of await listDir($, rel ? `${root}/${rel}` : root)) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.kind === 'dir') {
      if (!entry.name.startsWith('.')) out.push(...(await walk($, root, path, depth + 1)))
    } else {
      out.push(path)
    }
  }
  return out
}

async function removeDir($: any, path: string) {
  if (await $.fs.exists(path)) await run($, ['rm', '-rf', path])
}

/** Replace `target` with `staging`, keeping a backup until the move succeeds. */
async function promote($: any, staging: string, target: string) {
  const backup = `${target}.backup-${Date.now()}`
  let isBackedUp = false
  try {
    if (await $.fs.exists(target)) {
      await run($, ['mv', target, backup])
      isBackedUp = true
    }
    await run($, ['mv', staging, target])
    if (isBackedUp) await run($, ['rm', '-rf', backup])
  } catch (e) {
    if (isBackedUp && !(await $.fs.exists(target)) && (await $.fs.exists(backup))) {
      await run($, ['mv', backup, target]).catch(() => undefined)
    }
    throw e
  }
}

async function validateDir($: any, path: string): Promise<string[]> {
  const text = await readText($, `${path}/SKILL.md`)
  if (text === undefined) return [`SKILL.md not found in ${path}`]
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) return ['SKILL.md is missing YAML frontmatter (--- delimiters)']
  const errors: string[] = []
  if (!/^name:\s*\S/m.test(text)) errors.push('Missing required frontmatter field: name')
  if (!/^description:\s*\S/m.test(text)) errors.push('Missing required frontmatter field: description')
  return errors
}

async function normalise($: any, folderPath: string, defaults: FrontmatterDefaults) {
  const text = await readText($, `${folderPath}/SKILL.md`)
  if (text === undefined) return
  const next = ensureFrontmatter(text, defaults)
  if (next !== text) await $.fs.write(`${folderPath}/SKILL.md`, next)
}

// ─── State (install bookkeeping in $.store) ──────────────────

async function loadStates($: any): Promise<Record<string, SkillState>> {
  return ((await $.store.get(STORE_KEY)) as Record<string, SkillState> | undefined) ?? {}
}

async function putState($: any, folder: string, state: SkillState | undefined) {
  const all = await loadStates($)
  if (state) all[folder] = state
  else delete all[folder]
  await $.store.set(STORE_KEY, all)
}

// ─── Scan, toggle, index, export ─────────────────────────────

async function scanSkills($: any): Promise<SkillRow[]> {
  const states = await loadStates($)
  const rows: SkillRow[] = []
  for (const entry of await listDir($, O.skillsDir)) {
    const name = entry.name
    if (name.startsWith('.') || name.includes('.backup-') || name.includes('.staging-')) continue
    if (entry.kind !== 'dir' && !entry.isLink) continue
    const text = await readText($, `${skillDir(name)}/SKILL.md`)
    if (text === undefined) continue
    const meta = toSkillMeta(text, O.defaultCategory)
    if (!meta) continue
    rows.push({ folder: name, meta, state: states[name], risk: scanSkill(extractBody(text), []).riskLevel })
  }
  return rows.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
}

async function refresh($: any): Promise<SkillRow[]> {
  const rows = await scanSkills($)
  await update($, skills, () => rows)
  return rows
}

/** After any change: rescan, regenerate SKILLS.md, re-export (as the plugin did). */
async function afterChange($: any): Promise<SkillRow[]> {
  const rows = await refresh($)
  if (O.generateSkillsIndex) await writeIndex($, rows).catch(() => undefined)
  if (O.crossToolExportEnabled && O.crossToolExport.length > 0) await exportSkills($, rows).catch(() => undefined)
  return rows
}

async function writeIndex($: any, rows: SkillRow[]) {
  const entries = rows.map(r => ({
    folder: r.folder, name: r.meta.name, description: r.meta.description, category: r.meta.category,
    enabled: !r.meta.disableModelInvocation, userInvocable: r.meta.userInvocable,
  }))
  await $.fs.write('SKILLS.md', buildIndex(entries, O.skillsDir))
}

async function exportSkills($: any, rows: SkillRow[]): Promise<{ exported: string[]; errors: string[] }> {
  const exported: string[] = []
  const errors: string[] = []
  const bodies: { name: string; body: string }[] = []
  for (const r of rows.filter(r => !r.meta.disableModelInvocation)) {
    const text = await readText($, `${skillDir(r.folder)}/SKILL.md`)
    if (text === undefined) errors.push(`Could not read ${r.folder}/SKILL.md`)
    else if (extractBody(text)) bodies.push({ name: r.meta.name, body: extractBody(text) })
  }
  if (bodies.length === 0) return { exported, errors: [...errors, 'No enabled skills to export'] }
  const content = buildExport(bodies)
  for (const target of O.crossToolExport) {
    const t = EXPORT_TARGETS[target]
    if (!t) {
      errors.push(`Unknown export target: ${target}`)
      continue
    }
    try {
      await $.fs.write(t.path, content)
      exported.push(t.label)
    } catch (e) {
      errors.push(`Failed to write ${t.path}: ${errText(e)}`)
    }
  }
  return { exported, errors }
}

async function setSkillField($: any, folder: string, field: string, value: string): Promise<boolean> {
  const path = `${skillDir(folder)}/SKILL.md`
  const text = await readText($, path)
  if (text === undefined) return false
  const next = setField(text, field, value)
  if (next === text) return false
  await $.fs.write(path, next)
  return true
}

async function setEnabled($: any, folders: string[], isEnabled: boolean): Promise<number> {
  let changed = 0
  for (const f of folders) if (await setSkillField($, f, 'disable-model-invocation', isEnabled ? 'false' : 'true')) changed++
  await afterChange($)
  return changed
}

async function setFieldAndRefresh($: any, folder: string, field: string, value: string) {
  await setSkillField($, folder, field, value)
  await afterChange($)
  if ((await read($, detail))?.folder === folder) await loadDetail($, folder)
}

async function toggleFrozen($: any, folder: string): Promise<boolean | undefined> {
  const all = await loadStates($)
  if (!all[folder]) return undefined
  all[folder] = { ...all[folder], frozen: !all[folder].frozen }
  await $.store.set(STORE_KEY, all)
  await refresh($)
  return all[folder].frozen
}

async function deleteSkill($: any, folder: string): Promise<boolean> {
  try {
    await removeDir($, skillDir(folder))
    await putState($, folder, undefined)
    await afterChange($)
    return true
  } catch {
    return false
  }
}

async function loadDetail($: any, folder: string) {
  const root = skillDir(folder)
  const files = await walk($, root)
  const text = (await readText($, `${root}/SKILL.md`)) ?? ''
  const scripts: { file: string; text: string }[] = []
  for (const f of files.filter(f => f.startsWith('scripts/'))) {
    const t = await readText($, `${root}/${f}`)
    if (t !== undefined) scripts.push({ file: f, text: t })
  }
  const body = extractBody(text)
  await update($, detail, () => ({ folder, files, body, scan: scanSkill(body, scripts) }))
}

// ─── Playbooks and value chains ──────────────────────────────

async function loadPins($: any): Promise<string[]> {
  return ((await $.store.get(PINS_KEY)) as string[] | undefined) ?? []
}

/** Notes with `type: playbook` under the playbook folders (template folders skipped). */
async function scanPlaybooks($: any): Promise<PlaybookRow[]> {
  const pins = await loadPins($)
  const rows: PlaybookRow[] = []
  const seen = new Set<string>()
  for (const root of O.playbookFolders) {
    for (const f of await walk($, root, '', 4)) {
      const path = `${root}/${f}`
      if (!f.endsWith('.md') || seen.has(path) || /(^|\/)templates?\//i.test(path)) continue
      seen.add(path)
      const text = await readText($, path)
      const p = text === undefined ? null : toPlaybook(path, text, pins)
      if (p) rows.push(p)
    }
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title))
}

async function refreshPlaybooks($: any): Promise<PlaybookRow[]> {
  const rows = await scanPlaybooks($)
  await update($, playbooks, () => rows)
  return rows
}

async function togglePin($: any, path: string): Promise<boolean> {
  const pins = await loadPins($)
  const isPinned = !pins.includes(path)
  await $.store.set(PINS_KEY, isPinned ? [...pins, path] : pins.filter(p => p !== path))
  await refreshPlaybooks($)
  return isPinned
}

async function setPlaybookField($: any, path: string, field: string, value: string) {
  const text = await readText($, path)
  if (text === undefined) throw new Error(`Cannot read ${path}`)
  const next = setField(text, field, value)
  if (next !== text) await $.fs.write(path, next)
  await refreshPlaybooks($)
  if ((await read($, pbDetail))?.path === path) await loadPlaybookDetail($, path)
}

async function loadPlaybookDetail($: any, path: string) {
  const text = (await readText($, path)) ?? ''
  await update($, pbDetail, () => ({ path, body: extractBody(text) }))
}

/** The prompt that runs a playbook (the vault's /playbook-runner skill when installed). */
async function playbookPrompt($: any, p: PlaybookRow, extra: string): Promise<string> {
  return runPrompt(p, await $.fs.exists(`${skillDir('playbook-runner')}/SKILL.md`), extra)
}

/**
 * Queue the playbook as its own turn. Submitted from a timer, not inline: a
 * command or press hook cannot submit while the engine is holding it.
 */
async function runPlaybook($: any, p: PlaybookRow, extra = ''): Promise<string> {
  const text = await playbookPrompt($, p, extra)
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch((e: unknown) => $.ui.toast(`Could not start the playbook: ${errText(e)}`))
  })
  return text
}

async function setSkillChains($: any, folder: string, chains: string[]) {
  const path = `${skillDir(folder)}/SKILL.md`
  const text = await readText($, path)
  if (text === undefined) throw new Error(`Cannot read ${path}`)
  const next = setList(text, 'value-chains', [...new Set(chains)])
  if (next !== text) await $.fs.write(path, next)
  await afterChange($)
  if ((await read($, detail))?.folder === folder) await loadDetail($, folder)
}

async function chainRows($: any) {
  const sk = await refresh($)
  const pbs = await refreshPlaybooks($)
  return chainMatrix(chainList(O.valueChains, sk, pbs), sk, pbs)
}

function formatPlaybooks(rows: PlaybookRow[]): string {
  if (rows.length === 0) return `No playbooks (type: playbook) under ${O.playbookFolders.join(', ')}.`
  return rows.map(p => `${p.isPinned ? '★ ' : ''}${p.title}  (${[p.status, p.valueChain, p.steps !== undefined && `${p.steps} steps`, p.duration].filter(Boolean).join(', ')})${p.trigger ? `  — ${p.trigger}` : ''}`).join('\n')
}

// ─── GitHub ──────────────────────────────────────────────────

function ghHeaders(isApi: boolean): Record<string, string> {
  const h: Record<string, string> = isApi ? { Accept: 'application/vnd.github.v3+json' } : {}
  if (O.githubPat) h.Authorization = `Token ${O.githubPat}`
  return h
}

async function ghApi($: any, path: string): Promise<{ status: number; headers: Record<string, string>; json: any }> {
  const r = await $.http.fetch(`${API}${path}`, { headers: ghHeaders(true) })
  return { status: r.status, headers: r.headers, json: r.ok ? JSON.parse(r.text) : undefined }
}

async function fetchReleases($: any, repo: string): Promise<Release[]> {
  const r = await ghApi($, `/repos/${repo}/releases?per_page=25`)
  if (r.status === 403) {
    throw new Error(r.headers['x-ratelimit-remaining'] === '0' ? 'GitHub API rate limit exceeded. Add a PAT in /config.' : `GitHub API forbidden (403) for ${repo}`)
  }
  if (r.status === 404) throw new Error(`Repository not found: ${repo}`)
  if (r.status !== 200) throw new Error(`GitHub API error: ${r.status}`)
  return sortReleases(r.json)
}

async function fetchRaw($: any, url: string): Promise<string | undefined> {
  const r = await $.http.fetch(url, { headers: ghHeaders(false) }).catch(() => undefined)
  return r?.ok ? r.text : undefined
}

const rawUrl = (repo: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodePath(path)}`

async function fetchTree($: any, repo: string, ref: string): Promise<string[] | undefined> {
  const r = await ghApi($, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  if (r.status !== 200) return undefined
  return (r.json.tree as { path: string; type: string }[]).filter(e => e.type === 'blob').map(e => e.path)
}

async function fetchDefaultBranch($: any, repo: string): Promise<string> {
  const r = await ghApi($, `/repos/${repo}`)
  return (r.status === 200 && r.json.default_branch) || 'main'
}

/** SKILL.md (release asset, else repo), other release assets, then the whole tree at the ref. */
async function fetchSkillFiles($: any, repo: string, release?: Release): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const asset = release?.assets.find(a => a.name === 'SKILL.md')
  const skillMd = asset ? await fetchRaw($, asset.browser_download_url) : await fetchRaw($, rawUrl(repo, 'HEAD', 'SKILL.md'))
  if (skillMd !== undefined) files.set('SKILL.md', skillMd)
  for (const a of release?.assets ?? []) {
    if (a.name === 'SKILL.md' || a.name.endsWith('.zip')) continue
    const t = await fetchRaw($, a.browser_download_url)
    if (t !== undefined) files.set(a.name, t)
  }
  const ref = release?.tag_name || 'HEAD'
  for (const path of (await fetchTree($, repo, ref)) ?? []) {
    if (files.has(path)) continue
    const t = await fetchRaw($, rawUrl(repo, ref, path))
    if (t !== undefined) files.set(path, t)
  }
  return files
}

async function fetchSubpathFiles($: any, repo: string, subpath: string, ref: string): Promise<Map<string, string>> {
  const tree = await fetchTree($, repo, ref)
  if (!tree) throw new Error(`Failed to fetch repo tree for ${repo}`)
  const prefix = subpath.endsWith('/') ? subpath : `${subpath}/`
  const blobs = tree.filter(p => p.startsWith(prefix) || p === subpath)
  if (blobs.length === 0) throw new Error(`No files found under "${subpath}" in ${repo}`)
  const files = new Map<string, string>()
  for (const path of blobs) {
    const t = await fetchRaw($, rawUrl(repo, ref, path))
    if (t !== undefined) files.set(path.startsWith(prefix) ? path.slice(prefix.length) : path.split('/').pop()!, t)
  }
  return files
}

async function findSkillSubpath($: any, repo: string, skillId: string, ref: string): Promise<string | undefined> {
  const tree = await fetchTree($, repo, ref)
  const mds = (tree ?? []).filter(p => p.endsWith('/SKILL.md'))
  if (mds.length === 0) return undefined
  const picked = pickSkillSubpath(mds, skillId)
  if (picked !== undefined) return picked
  for (const md of mds) {
    const t = await fetchRaw($, rawUrl(repo, ref, md))
    if (t !== undefined && matchByName(t, skillId)) return md.replace(/\/SKILL\.md$/, '')
  }
  return undefined
}

async function fetchSkillsShInfo($: any, id: string): Promise<{ repo: string; subpath?: string } | undefined> {
  const r = await $.http.fetch(`https://skills.sh/api/skills/${encodeURIComponent(id)}`).catch(() => undefined)
  if (!r?.ok) return undefined
  const d = JSON.parse(r.text) as { source?: string; repo?: string; subpath?: string }
  const repo = d.repo || d.source
  return repo ? { repo, subpath: d.subpath } : undefined
}

async function checkForUpdate($: any, repo: string, local: string): Promise<string | undefined> {
  try {
    const latest = (await fetchReleases($, repo))[0]
    return latest && isNewer(latest.tag_name, local) ? latest.tag_name : undefined
  } catch {
    return undefined
  }
}

// ─── Install ─────────────────────────────────────────────────

/** Stage files, validate, promote with rollback, normalise frontmatter, record state. */
async function installFiles($: any, folder: string, files: Map<string, string>, defaults: FrontmatterDefaults, state: SkillState): Promise<InstallResult> {
  const staging = `${O.skillsDir}/.${folder}.staging-${Date.now()}`
  try {
    for (const [path, content] of files) await $.fs.write(`${staging}/${path}`, content)
    const errors = await validateDir($, staging)
    if (errors.length > 0) {
      await removeDir($, staging).catch(() => undefined)
      return fail(folder, ...errors)
    }
    await promote($, staging, skillDir(folder))
    await normalise($, skillDir(folder), defaults)
    const previous = (await loadStates($))[folder]
    await putState($, folder, previous ? { ...state, installedAt: previous.installedAt, lastUpdated: new Date().toISOString() } : state)
    return { success: true, skillName: folder, errors: [] }
  } catch (e) {
    await removeDir($, staging).catch(() => undefined)
    return fail(folder, errText(e))
  }
}

async function installFromGitHub($: any, repo: string, version?: string): Promise<InstallResult> {
  try {
    const releases = await fetchReleases($, repo)
    const release = version ? releases.find(r => r.tag_name === version) : releases[0]
    if (version && !release) return fail('', `Release ${version} not found for ${repo}`)
    const files = await fetchSkillFiles($, repo, release)
    if (!files.has('SKILL.md')) return fail('', `No SKILL.md found in ${repo}`)
    const folder = repo.split('/').pop()!
    const tag = release?.tag_name
    return await installFiles($, folder, files,
      { source: 'github', version: tag || '1.0.0', 'origin-repo': repo },
      { source: 'github', repo, version: tag, frozen: false, installedAt: new Date().toISOString() })
  } catch (e) {
    return fail('', errText(e))
  }
}

async function installFromMonorepo($: any, repo: string, subpath: string): Promise<InstallResult> {
  const folder = subpath.split('/').pop() || subpath.replace(/\//g, '-')
  try {
    const ref = await fetchDefaultBranch($, repo)
    let actual = subpath
    let files: Map<string, string>
    try {
      files = await fetchSubpathFiles($, repo, subpath, ref)
    } catch {
      const resolved = await findSkillSubpath($, repo, subpath, ref)
      if (!resolved) return fail(folder, `Could not find skill "${subpath}" in ${repo}`)
      actual = resolved
      files = await fetchSubpathFiles($, repo, resolved, ref)
    }
    if (!files.has('SKILL.md')) return fail(folder, `No SKILL.md found under "${actual}" in ${repo}`)
    return await installFiles($, folder, files,
      { source: 'github', 'origin-repo': repo },
      { source: 'github', repo: `${repo}/${actual}`, frozen: false, installedAt: new Date().toISOString() })
  } catch (e) {
    return fail(folder, errText(e))
  }
}

/** Register a folder already on disk; one outside the skills directory is copied in. */
async function installLocal($: any, path: string): Promise<InstallResult> {
  const clean = path.replace(/\/+$/, '')
  const folder = clean.split('/').pop()!
  const errors = await validateDir($, clean)
  if (errors.length > 0) return fail(folder, ...errors)
  if (clean !== skillDir(folder)) {
    if (await $.fs.exists(skillDir(folder))) return fail(folder, `${skillDir(folder)} already exists`)
    await run($, ['mkdir', '-p', O.skillsDir])
    await run($, ['cp', '-R', clean, skillDir(folder)])
  }
  await normalise($, skillDir(folder), { source: 'local' })
  await putState($, folder, { source: 'local', frozen: false, installedAt: new Date().toISOString() })
  return { success: true, skillName: folder, errors: [] }
}

async function extractZip($: any, zipPath: string): Promise<string> {
  const tmp = `${O.skillsDir}/.zip-${Date.now()}`
  await run($, ['mkdir', '-p', tmp])
  try {
    await run($, ['unzip', '-q', '-o', zipPath, '-d', tmp])
  } catch {
    await run($, ['python3', '-m', 'zipfile', '-e', zipPath, tmp])
  }
  return tmp
}

async function previewZip($: any, zipPath: string): Promise<NonNullable<AddForm['zip']>> {
  const tmp = await extractZip($, zipPath)
  const mds = (await walk($, tmp)).filter(p => p.endsWith('/SKILL.md'))
  const out: NonNullable<AddForm['zip']>['skills'] = []
  for (const g of groupZipSkills(mds)) {
    const text = (await readText($, `${tmp}/${g.dir}/SKILL.md`)) ?? ''
    out.push({ ...g, name: /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? g.folder })
  }
  if (out.length === 0) {
    await removeDir($, tmp)
    throw new Error('No SKILL.md files found in ZIP')
  }
  return { tmp, skills: out }
}

async function installZipSkills($: any, zip: NonNullable<AddForm['zip']>, only?: string): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = []
  const errors: string[] = []
  for (const s of zip.skills.filter(s => !only || s.folder === only)) {
    const from = `${zip.tmp}/${s.dir}`
    const problems = await validateDir($, from)
    if (problems.length > 0) {
      errors.push(`${s.folder}: ${problems.join('; ')}`)
      continue
    }
    try {
      await promote($, from, skillDir(s.folder))
      await normalise($, skillDir(s.folder), { source: 'zip' })
      await putState($, s.folder, { source: 'zip', frozen: false, installedAt: new Date().toISOString() })
      installed.push(s.folder)
    } catch (e) {
      errors.push(`${s.folder}: ${errText(e)}`)
    }
  }
  return { installed, errors }
}

/** Any accepted input: local folder, .zip, owner/repo[/path], GitHub URL, skills.sh URL. */
async function installRef($: any, input: string, version?: string): Promise<InstallResult> {
  const t = input.trim()
  if (/\.zip$/i.test(t)) {
    const zip = await previewZip($, t)
    const r = await installZipSkills($, zip)
    await removeDir($, zip.tmp).catch(() => undefined)
    return { success: r.installed.length > 0, skillName: r.installed.join(', '), errors: r.errors }
  }
  if (await $.fs.exists(`${t.replace(/\/+$/, '')}/SKILL.md`)) return installLocal($, t)
  const ref = parseSkillRef(t)
  if (!ref) return fail('', 'Unrecognized format. Use owner/repo, a GitHub URL, a skills.sh URL, a local folder or a .zip.')
  if (ref.type === 'skills-sh') {
    const info = await fetchSkillsShInfo($, ref.skillsShId)
    if (!info) return fail('', 'Could not resolve the skills.sh skill to a GitHub source')
    return info.subpath ? installFromMonorepo($, info.repo, info.subpath) : installFromGitHub($, info.repo)
  }
  if (ref.type === 'github-monorepo') return installFromMonorepo($, ref.repo, ref.subpath)
  return installFromGitHub($, ref.repo, version)
}

async function updateSkill($: any, folder: string, version?: string): Promise<InstallResult> {
  const state = (await loadStates($))[folder]
  if (!state || state.source !== 'github' || !state.repo) return fail(folder, 'Not a GitHub-installed skill')
  if (state.frozen) return fail(folder, 'Skill version is frozen')
  const seg = state.repo.split('/')
  return seg.length > 2 ? installFromMonorepo($, `${seg[0]}/${seg[1]}`, seg.slice(2).join('/')) : installFromGitHub($, state.repo, version)
}

async function checkUpdates($: any, folders?: string[]): Promise<Record<string, string>> {
  const states = await loadStates($)
  const found: Record<string, string> = {}
  for (const [folder, s] of Object.entries(states)) {
    if (folders && !folders.includes(folder)) continue
    if (s.source !== 'github' || s.frozen || !s.repo || !s.version || s.repo.split('/').length > 2) continue
    const latest = await checkForUpdate($, s.repo, s.version)
    if (latest) found[folder] = latest
  }
  await update($, view, v => ({ ...v, updates: { ...v.updates, ...found } }))
  return found
}

async function updateMany($: any, folders?: string[]): Promise<{ updated: number; failed: number }> {
  const states = await loadStates($)
  let updated = 0
  let failed = 0
  for (const [folder, s] of Object.entries(states)) {
    if (folders && !folders.includes(folder)) continue
    if (s.source !== 'github' || s.frozen) continue
    if ((await updateSkill($, folder)).success) updated++
    else failed++
  }
  await update($, view, v => ({ ...v, updates: {} }))
  await afterChange($)
  return { updated, failed }
}

// ─── Marketplace ─────────────────────────────────────────────

async function loadMarket($: any, isMore: boolean) {
  const m = await read($, market)
  const page = isMore ? m.page + 1 : 0
  const req = registryRequest(m.registry, m.board, page, m.search, O.skillsmpApiKey)
  if ('error' in req) {
    await update($, market, x => ({ ...x, status: req.error, results: isMore ? x.results : [], hasMore: false }))
    return
  }
  await update($, market, x => ({ ...x, status: 'Loading…' }))
  try {
    const r = await $.http.fetch(req.url, { headers: req.headers })
    if (!r.ok) throw new Error(`${REGISTRIES[m.registry].label} returned status ${r.status}`)
    const got = parseRegistry(m.registry, page, JSON.parse(r.text))
    await update($, market, x => ({ ...x, page, results: isMore ? [...x.results, ...got.skills] : got.skills, hasMore: got.hasMore, status: '' }))
  } catch (e) {
    await update($, market, x => ({ ...x, status: errText(e) }))
  }
}

async function installRegistrySkill($: any, s: RegistrySkill): Promise<InstallResult> {
  const repo = parseRepo(s.source) ?? s.source
  const repoName = repo.split('/').pop() || ''
  const result = s.skillId && s.skillId !== repoName ? await installFromMonorepo($, repo, s.skillId) : await installFromGitHub($, repo)
  const rows = await afterChange($)
  const category = rows.find(r => r.folder === result.skillName)?.meta.category
  const line = result.success ? `✓ ${s.name} → ${category ?? O.defaultCategory}` : `✗ ${s.name}: ${result.errors.join('; ')}`
  await update($, market, x => ({ ...x, log: [line, ...x.log].slice(0, 20), installed: result.success ? [...x.installed, s.skillId || s.name] : x.installed }))
  return result
}

// ─── Shared helpers for UI, command and tool ─────────────────

async function withBusy<T>($: any, label: string, work: () => Promise<T>): Promise<T | undefined> {
  await update($, busy, () => label)
  try {
    return await work()
  } catch (e) {
    $.ui.toast(`${label} failed: ${errText(e)}`)
    return undefined
  } finally {
    await update($, busy, () => '')
  }
}

function summary(r: InstallResult): string {
  return r.success ? `Installed: ${r.skillName}` : `Install failed: ${r.errors.join('; ')}`
}

function visibleRows(rows: SkillRow[], v: View): SkillRow[] {
  const q = v.search.toLowerCase()
  return rows.filter(r => {
    if (v.source !== 'all' && (r.state?.source ?? r.meta.source ?? 'local') !== v.source) return false
    if (!q) return true
    return r.meta.name.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q) || (v.includeDesc && r.meta.description.toLowerCase().includes(q))
  })
}

function findSkill(rows: SkillRow[], name: string): SkillRow | undefined {
  return rows.find(r => r.folder === name) ?? rows.find(r => r.meta.name === name)
}

function formatList(rows: SkillRow[]): string {
  if (rows.length === 0) return `No skills in ${O.skillsDir}.`
  const enabled = rows.filter(r => !r.meta.disableModelInvocation).length
  const lines = [`${rows.length} skills in ${O.skillsDir} · ${enabled} enabled · ${rows.length - enabled} disabled`]
  for (const c of [...new Set(rows.map(r => r.meta.category))].sort()) {
    lines.push('', c)
    for (const r of rows.filter(r => r.meta.category === c)) {
      const flags = [r.meta.disableModelInvocation ? 'off' : 'on', r.meta.version && `v${r.meta.version}`, r.state?.source, r.state?.frozen && 'frozen', r.risk !== 'clean' && r.risk]
      lines.push(`  ${r.folder}  (${flags.filter(Boolean).join(', ')})  ${r.meta.description.slice(0, 80)}`)
    }
  }
  return lines.join('\n')
}

/** Skills an enable/disable target names: "all", a category, or one skill. */
function targetsOf(rows: SkillRow[], target: string): string[] {
  if (target === 'all') return rows.map(r => r.folder)
  const one = findSkill(rows, target)
  if (one) return [one.folder]
  const inCat = rows.filter(r => r.meta.category === target).map(r => r.folder)
  if (inCat.length > 0) return inCat
  throw new Error(`No skill or category named "${target}" in ${O.skillsDir}`)
}

/** One action, shared by the slash command and the model tool. */
async function act($: any, action: string, arg: string, extra: string, isFromTool = false): Promise<string> {
  const rows = await refresh($)
  // Playbook titles have spaces: try the whole text first, else the first word with the rest as context.
  const needPlaybook = async (): Promise<{ p: PlaybookRow; rest: string }> => {
    const pbs = await refreshPlaybooks($)
    const full = [arg, extra].filter(Boolean).join(' ')
    const whole = findPlaybook(pbs, full)
    if (whole) return { p: whole, rest: '' }
    const first = findPlaybook(pbs, arg)
    if (first) return { p: first, rest: extra }
    throw new Error(`No playbook named "${full}" under ${O.playbookFolders.join(', ')}`)
  }
  const need = (): SkillRow => {
    const r = findSkill(rows, arg)
    if (!r) throw new Error(`No skill named "${arg}" in ${O.skillsDir}`)
    return r
  }
  switch (action) {
    case 'list':
      return formatList(arg ? visibleRows(rows, { ...(await read($, view)), source: 'all', search: arg, includeDesc: true }) : rows)
    case 'rescan':
      return `Rescanned: ${(await afterChange($)).length} skills.`
    case 'show': {
      const r = need()
      await loadDetail($, r.folder)
      const d = await read($, detail)
      const meta = Object.entries(r.meta).map(([k, v]) => `${k}: ${v}`).join('\n')
      const threats = d?.scan.threats.map(t => `- [${t.severity}] ${t.file}: ${t.description}`).join('\n') || 'none'
      return `${meta}\nstate: ${JSON.stringify(r.state ?? {})}\nfiles: ${d?.files.join(', ')}\nsecurity: ${d?.scan.riskLevel}\n${threats}`
    }
    case 'enable':
    case 'disable': {
      const n = await setEnabled($, targetsOf(rows, arg), action === 'enable')
      return `${action === 'enable' ? 'Enabled' : 'Disabled'} ${n} skill(s).`
    }
    case 'invocable': {
      const isOn = !['false', 'off', 'no'].includes(extra.toLowerCase())
      await setFieldAndRefresh($, need().folder, 'user-invocable', String(isOn))
      return `${arg}: user-invocable ${isOn ? 'on' : 'off'}.`
    }
    case 'category':
      if (!extra) throw new Error('Usage: category <skill> <category>')
      await setFieldAndRefresh($, need().folder, 'category', extra)
      return `${arg} → ${extra}`
    case 'freeze': {
      const frozen = await toggleFrozen($, need().folder)
      return frozen === undefined ? `${arg} has no install record (only installed skills can be frozen).` : `${arg} ${frozen ? 'frozen' : 'unfrozen'}.`
    }
    case 'delete':
      return (await deleteSkill($, need().folder)) ? `Deleted ${arg}.` : `Could not delete ${arg}.`
    case 'install':
    case 'add': {
      if (!arg) throw new Error('Usage: install <owner/repo | URL | path | file.zip> [version]')
      const r = await installRef($, arg, extra || undefined)
      await afterChange($)
      if (!r.success) return summary(r)
      const scans: string[] = []
      for (const f of r.skillName.split(', ')) {
        await loadDetail($, f)
        const d = await read($, detail)
        if (d && d.scan.riskLevel !== 'clean') scans.push(`${f}: ${d.scan.riskLevel} (${d.scan.threats.map(t => t.description).join('; ')})`)
      }
      return `${summary(r)}${scans.length ? `\nSecurity scan:\n${scans.join('\n')}` : ''}`
    }
    case 'versions': {
      const repo = parseRepo(arg)
      if (!repo) throw new Error('Usage: versions <owner/repo>')
      return (await fetchReleases($, repo)).map(r => r.tag_name).join(', ') || 'No releases (installs use the default branch).'
    }
    case 'check-updates': {
      const found = await checkUpdates($, arg ? [need().folder] : undefined)
      const names = Object.entries(found).map(([f, v]) => `${f} → ${v}`)
      return names.length ? `Updates available:\n${names.join('\n')}` : 'All skills are up to date.'
    }
    case 'update': {
      if (arg && arg !== 'all') {
        const r = await updateSkill($, need().folder, extra || undefined)
        await afterChange($)
        return r.success ? `Updated ${arg}.` : `Update failed: ${r.errors.join('; ')}`
      }
      const r = await updateMany($)
      return `Updated ${r.updated} skill(s)${r.failed ? `, ${r.failed} failed` : ''}.`
    }
    case 'export': {
      if (O.crossToolExport.length === 0) return 'No export targets configured. Set "Export targets" in /config (cursor, copilot, windsurf, cline).'
      const r = await exportSkills($, rows)
      return [r.exported.length > 0 && `Exported to: ${r.exported.join(', ')}`, r.errors.length > 0 && `Errors: ${r.errors.join('; ')}`].filter(Boolean).join('\n')
    }
    case 'index':
      await writeIndex($, rows)
      return 'Wrote SKILLS.md.'
    case 'playbooks': {
      const pbs = await refreshPlaybooks($)
      const q = [arg, extra].filter(Boolean).join(' ')
      return formatPlaybooks(filterPlaybooks(pbs, { search: q, status: '', chain: '', maturity: '', selected: '' }))
    }
    case 'playbook': {
      const { p } = await needPlaybook()
      const body = extractBody((await readText($, p.path)) ?? '')
      const meta = [['Path', p.path], ['Status', p.status], ['Trigger', p.trigger], ['Outcome', p.outcome], ['Value chain', p.valueChain],
        ['Coverage', p.coverage.join(', ')], ['Maturity', p.maturity.join(', ')], ['Steps', p.steps], ['Duration', p.duration], ['Tier', p.pricingTier], ['Tags', p.tags.join(', ')]]
      return `${meta.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body.slice(0, 4000)}`
    }
    case 'run': {
      const { p, rest } = await needPlaybook()
      if (isFromTool) return `To run "${p.title}", follow this:\n${await playbookPrompt($, p, rest)}`
      const text = await runPlaybook($, p, rest)
      return `Running playbook "${p.title}": ${text.split('\n')[0]}`
    }
    case 'pin': {
      const { p } = await needPlaybook()
      return `${p.title} ${(await togglePin($, p.path)) ? 'pinned' : 'unpinned'}.`
    }
    case 'playbook-status':
    case 'playbook-chain': {
      const words = extra.split(/\s+/).filter(Boolean)
      const value = words.pop() ?? ''
      const pbs = await refreshPlaybooks($)
      const p = findPlaybook(pbs, [arg, ...words].join(' ')) ?? findPlaybook(pbs, arg)
      if (!p || !value) throw new Error(`Usage: ${action} <playbook> <${action === 'playbook-status' ? PLAYBOOK_STATUSES.join('|') : 'chain|none'}>`)
      const field = action === 'playbook-status' ? 'status' : 'value-chain'
      await setPlaybookField($, p.path, field, value === 'none' ? '' : value)
      return `${p.title}: ${field} → ${value}`
    }
    case 'chains': {
      const matrix = await chainRows($)
      if (!arg) return formatMatrix(matrix)
      const r = matrix.find(c => c.id === arg || c.label.toLowerCase() === [arg, extra].join(' ').trim().toLowerCase())
      if (!r) throw new Error(`Unknown value chain "${arg}". Known: ${matrix.map(c => c.id).filter(Boolean).join(', ')}`)
      return [`${r.label}${r.stages.length ? ` — stages covered: ${r.stages.join(', ')}` : ''}`,
        `Playbooks (${r.playbooks.length}):`, ...r.playbooks.map(p => `  ${p.title} (${p.status}${p.coverage.length ? `; ${p.coverage.join(', ')}` : ''})`),
        `Skills (${r.skills.length}):`, ...r.skills.map(s => `  ${s.folder}${s.meta.disableModelInvocation ? ' (off)' : ''}`)].join('\n')
    }
    case 'chain-add':
    case 'chain-remove': {
      const r = need()
      if (!extra) throw new Error(`Usage: ${action} <skill> <chain>`)
      const chains = action === 'chain-add' ? [...r.meta.valueChains, extra] : r.meta.valueChains.filter(c => c !== extra)
      await setSkillChains($, r.folder, chains)
      return `${r.folder}: value-chains → [${[...new Set(chains)].join(', ')}]`
    }
    case 'browse': {
      await update($, market, m => ({ ...m, search: arg }))
      await loadMarket($, false)
      const m = await read($, market)
      if (m.status) return m.status
      const shown = m.registry === 'skills-sh' ? filterSkills(m.results, arg) : m.results
      return shown.slice(0, 25).map(s => `${s.name}  (${s.source}${s.skillId ? `, ${s.skillId}` : ''}, ${s.installs} installs)  ${s.description ?? ''}`).join('\n') || 'No results.'
    }
    default:
      throw new Error(`Unknown action "${action}".`)
  }
}

const HELP = `/skills — open the Skills Manager pane
/skills list [query] · show <skill> · rescan
/skills enable|disable <skill|category|all> · invocable <skill> on|off · category <skill> <name>
/skills install <owner/repo | owner/repo/path | GitHub URL | skills.sh URL | folder | file.zip> [version]
/skills versions <owner/repo> · check-updates [skill] · update [skill|all] [version] · freeze <skill>
/skills delete <skill> · browse [query] · export · index
/skills playbooks [query] · playbook <name> · run <name> [context] · pin <name>
/skills playbook-status <name> draft|active|retired · playbook-chain <name> <chain|none>
/skills chains [chain] · chain-add <skill> <chain> · chain-remove <skill> <chain>
/playbook [name [context]] — open the Playbooks tab, or run a playbook`

// ─── Rendering ───────────────────────────────────────────────

function categoriesFor(current: string): { value: string; label: string }[] {
  return [...new Set([O.defaultCategory, ...BUILTIN_CATEGORIES, ...O.customCategories, current])].sort().map(c => ({ value: c, label: c }))
}

function renderTabs(ui: any, $: any, v: View, b: string) {
  const { Box, Button, Text } = ui
  const tab = (id: Tab, label: string) => (
    <Button key={`tab-${id}`} label={label} variant={v.tab === id ? 'primary' : undefined} onPress={async () => {
      await update($, view, x => ({ ...x, tab: id }))
      if (id === 'playbooks' || id === 'chains') await withBusy($, 'Scan playbooks', () => refreshPlaybooks($))
    }} />
  )
  return (
    <Box flexDirection="row" gap={1}>
      {tab('installed', 'Installed')}
      {tab('playbooks', 'Playbooks')}
      {tab('chains', 'Value chains')}
      {tab('marketplace', 'Marketplace')}
      {tab('add', 'Add skill')}
      <Button key="rescan" label="Rescan" dimColor onPress={() => withBusy($, 'Rescan', async () => {
        await afterChange($)
        await refreshPlaybooks($)
      })} />
      {b ? <Text color="yellow">{b}…</Text> : <Text dimColor>{O.skillsDir}</Text>}
    </Box>
  )
}

function renderDetail(ui: any, $: any, r: SkillRow, d: Detail, v: View, hasFields: boolean) {
  const { Box, Button, Text, Select, Markdown, Link } = ui
  const m = r.meta
  const s = r.state
  const pairs: [string, string | undefined][] = [
    ['Category', m.category], ['Version', m.version], ['Source', s?.source ?? m.source], ['Origin', m.origin],
    ['Repo', s?.repo ?? m.originRepo], ['License', m.license], ['Compatibility', m.compatibility], ['Allowed tools', m.allowedTools],
    ['Value chains', m.valueChains.join(', ') || undefined],
    ['Installed', s?.installedAt?.slice(0, 10)], ['Updated', s?.lastUpdated?.slice(0, 10)], ['Frozen', s?.frozen ? 'yes' : undefined],
  ]
  const available = v.updates[r.folder]
  return (
    <Box key={`detail-${r.folder}`} flexDirection="column" paddingLeft={4} marginBottom={1}>
      <Text>{m.description}</Text>
      {pairs.filter(([, val]) => val).map(([k, val]) => <Text key={`m-${k}`} dimColor>{k}: {val}</Text>)}
      {m.valueChains.length > 0 && (
        <Box flexDirection="row" gap={1}>
          {m.valueChains.map(c => (
            <Button key={`vcx-${r.folder}-${c}`} plain dimColor label={`× ${c}`}
              onPress={() => withBusy($, 'Value chain', () => setSkillChains($, r.folder, m.valueChains.filter(x => x !== c)))} />
          ))}
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        {hasFields && (
          <Select key={`cat-${r.folder}`} label="Category" value={m.category} options={categoriesFor(m.category)}
            onSelect={(c: string) => withBusy($, 'Category', () => setFieldAndRefresh($, r.folder, 'category', c))} />
        )}
        <Button key={`auto-${r.folder}`} label={`Auto-loading: ${m.disableModelInvocation ? 'off' : 'on'}`}
          onPress={() => withBusy($, 'Toggle', () => setEnabled($, [r.folder], m.disableModelInvocation))} />
        <Button key={`inv-${r.folder}`} label={`User-invocable: ${m.userInvocable ? 'on' : 'off'}`}
          onPress={() => withBusy($, 'Toggle', () => setFieldAndRefresh($, r.folder, 'user-invocable', m.userInvocable ? 'false' : 'true'))} />
        {hasFields && (
          <Select key={`vc-${r.folder}`} label="Add value chain" value=""
            options={[{ value: '', label: '—' }, ...chainList(O.valueChains, [], []).filter(c => !m.valueChains.includes(c.id)).map(c => ({ value: c.id, label: c.label }))]}
            onSelect={(c: string) => c ? withBusy($, 'Value chain', () => setSkillChains($, r.folder, [...m.valueChains, c])) : undefined} />
        )}
        <Link key={`edit-${r.folder}`} href={`file://${absolute(`${skillDir(r.folder)}/SKILL.md`)}`} label="Edit SKILL.md" />
        {available && s?.source === 'github' && !s.frozen && (
          <Button key={`upd-${r.folder}`} variant="primary" label={`Update to ${available}`}
            onPress={() => withBusy($, `Update ${r.folder}`, async () => {
              const res = await updateSkill($, r.folder)
              await update($, view, x => ({ ...x, updates: Object.fromEntries(Object.entries(x.updates).filter(([f]) => f !== r.folder)) }))
              await afterChange($)
              await loadDetail($, r.folder)
              $.ui.toast(res.success ? `Updated ${r.folder}` : `Update failed: ${res.errors.join('; ')}`)
            })} />
        )}
      </Box>
      {d?.folder === r.folder ? (
        <Box flexDirection="column">
          <Text bold>Files ({d.files.length})</Text>
          {d.files.slice(0, 25).map(f => <Text key={`f-${f}`} dimColor>  {f}</Text>)}
          {d.files.length > 25 && <Text dimColor>  … {d.files.length - 25} more</Text>}
          <Text bold color={d.scan.riskLevel === 'danger' ? 'red' : d.scan.riskLevel === 'warning' ? 'yellow' : 'green'}>
            Security: {d.scan.riskLevel}
          </Text>
          {d.scan.threats.map((t, i) => <Text key={`t-${i}`} color={t.severity === 'danger' ? 'red' : 'yellow'}>  [{t.severity}] {t.file}: {t.description}</Text>)}
          <Text bold>Instructions</Text>
          <Markdown key={`md-${r.folder}`} text={d.body.length > 3000 ? `${d.body.slice(0, 3000)}\n\n…` : d.body || '_(empty)_'} />
        </Box>
      ) : (
        <Text dimColor>Loading details…</Text>
      )}
    </Box>
  )
}

function renderRow(ui: any, $: any, r: SkillRow, v: View, d: Detail, hasFields: boolean) {
  const { Box, Button, Text } = ui
  const m = r.meta
  const s = r.state
  const isGithub = s?.source === 'github'
  const isOpen = v.selected === r.folder
  const isConfirming = v.confirmDelete === r.folder
  const badges = [m.version && `v${m.version}`, s?.source ?? m.source, s?.frozen && 'frozen'].filter(Boolean).join(' · ')
  return (
    <Box key={`row-${r.folder}`} flexDirection="column">
      <Box flexDirection="row" gap={1} paddingLeft={2}>
        <Button key={`on-${r.folder}`} plain label={m.disableModelInvocation ? '[ ]' : '[x]'}
          onPress={() => withBusy($, 'Toggle', () => setEnabled($, [r.folder], m.disableModelInvocation))} />
        <Button key={`name-${r.folder}`} plain label={`${isOpen ? '▾' : '▸'} ${m.name}`} dimColor={m.disableModelInvocation}
          onPress={async () => {
            await update($, view, x => ({ ...x, selected: x.selected === r.folder ? '' : r.folder, confirmDelete: '' }))
            if (!isOpen) await loadDetail($, r.folder)
          }} />
        {badges && <Text dimColor>{badges}</Text>}
        {r.risk !== 'clean' && <Text color={r.risk === 'danger' ? 'red' : 'yellow'}>{r.risk}</Text>}
        {v.updates[r.folder] && <Text color="cyan">↑ {v.updates[r.folder]}</Text>}
        {isGithub && (
          <Button key={`frz-${r.folder}`} plain dimColor label={s!.frozen ? 'unfreeze' : 'freeze'} onPress={() => toggleFrozen($, r.folder)} />
        )}
        {isGithub && (
          <Button key={`chk-${r.folder}`} plain dimColor label="check"
            onPress={() => withBusy($, `Check ${r.folder}`, async () => {
              const found = await checkUpdates($, [r.folder])
              $.ui.toast(found[r.folder] ? `Update available for ${r.folder}: ${found[r.folder]}` : `${r.folder} is up to date`)
            })} />
        )}
        <Button key={`del-${r.folder}`} plain label={isConfirming ? 'confirm delete?' : 'delete'} dimColor={!isConfirming}
          onPress={() => isConfirming
            ? withBusy($, `Delete ${r.folder}`, async () => {
              $.ui.toast((await deleteSkill($, r.folder)) ? `Deleted ${r.folder}` : `Could not delete ${r.folder}`)
              await update($, view, x => ({ ...x, confirmDelete: '', selected: x.selected === r.folder ? '' : x.selected }))
            })
            : update($, view, x => ({ ...x, confirmDelete: r.folder }))} />
      </Box>
      {isOpen && renderDetail(ui, $, r, d, v, hasFields)}
    </Box>
  )
}

function renderInstalled(ui: any, $: any, rows: SkillRow[], v: View, d: Detail, hasFields: boolean) {
  const { Box, Button, Text, Input, Select } = ui
  const shown = visibleRows(rows, v)
  const enabled = rows.filter(r => !r.meta.disableModelInvocation).length
  const folders = shown.map(r => r.folder)
  const cats = [...new Set(shown.map(r => r.meta.category))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return (
    <Box flexDirection="column">
      {hasFields && (
        <Box flexDirection="row" gap={1}>
          <Input key="search" placeholder="Search skills" value={v.search} submitLabel="filter"
            onInput={(q: string) => update($, view, x => ({ ...x, search: q }))} onSubmit={(q: string) => update($, view, x => ({ ...x, search: q }))} />
          <Select key="source" label="Source" value={v.source}
            options={[{ value: 'all', label: 'All' }, { value: 'local', label: 'Local' }, { value: 'github', label: 'GitHub' }, { value: 'zip', label: 'ZIP' }]}
            onSelect={(s: string) => update($, view, x => ({ ...x, source: s as View['source'] }))} />
          <Button key="desc" plain dimColor={!v.includeDesc} label={`search descriptions: ${v.includeDesc ? 'on' : 'off'}`}
            onPress={() => update($, view, x => ({ ...x, includeDesc: !x.includeDesc }))} />
        </Box>
      )}
      <Text dimColor>
        {rows.length} skills · {enabled} enabled · {rows.length - enabled} disabled{shown.length !== rows.length ? ` · ${shown.length} shown` : ''}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="all-on" label="Enable all" onPress={() => withBusy($, 'Enable all', () => setEnabled($, folders, true))} />
        <Button key="all-off" label="Disable all" onPress={() => withBusy($, 'Disable all', () => setEnabled($, folders, false))} />
        <Button key="all-check" label="Check updates" onPress={() => withBusy($, 'Check updates', async () => {
          const n = Object.keys(await checkUpdates($, folders)).length
          $.ui.toast(n ? `${n} update(s) available` : 'All skills are up to date')
        })} />
        <Button key="all-upd" label="Update all" onPress={() => withBusy($, 'Update all', async () => {
          const r = await updateMany($, folders)
          $.ui.toast(`Updated ${r.updated} skill(s)${r.failed ? `, ${r.failed} failed` : ''}`)
        })} />
        <Button key="export" dimColor label="Export" onPress={() => withBusy($, 'Export', async () => $.ui.toast(await act($, 'export', '', '')))} />
      </Box>
      {rows.length === 0 && <Text dimColor>No skills found in {O.skillsDir}. Use “Add skill”, or set the folder in /config.</Text>}
      {cats.map(c => {
        const inCat = shown.filter(r => r.meta.category === c)
        const isOpen = v.search !== '' || v.expanded.includes(c)
        const anyOff = inCat.some(r => r.meta.disableModelInvocation)
        return (
          <Box key={`cat-${c}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key={`exp-${c}`} plain label={`${isOpen ? '▾' : '▸'} ${c} (${inCat.length})`}
                onPress={() => update($, view, x => ({ ...x, expanded: x.expanded.includes(c) ? x.expanded.filter(e => e !== c) : [...x.expanded, c] }))} />
              <Button key={`catall-${c}`} plain dimColor label={anyOff ? 'enable all' : 'disable all'}
                onPress={() => withBusy($, c, () => setEnabled($, inCat.map(r => r.folder), anyOff))} />
            </Box>
            {isOpen && inCat.map(r => renderRow(ui, $, r, v, d, hasFields))}
          </Box>
        )
      })}
    </Box>
  )
}

function renderMarket(ui: any, $: any, m: Market, hasFields: boolean) {
  const { Box, Button, Text, Input, Select, Link } = ui
  const boards = REGISTRIES[m.registry].boards
  const shown = m.registry === 'skills-sh' ? filterSkills(m.results, m.search) : m.results
  return (
    <Box flexDirection="column">
      {hasFields && (
        <Box flexDirection="row" gap={1}>
          <Select key="registry" label="Registry" value={m.registry}
            options={(Object.keys(REGISTRIES) as RegistryType[]).map(k => ({ value: k, label: REGISTRIES[k].label }))}
            onSelect={async (r: string) => {
              await update($, market, x => ({ ...x, registry: r as RegistryType, board: REGISTRIES[r as RegistryType].boards[0]!.id, results: [], page: 0 }))
              await loadMarket($, false)
            }} />
          <Select key="board" label="Board" value={m.board} options={boards.map(b => ({ value: b.id, label: b.label }))}
            onSelect={async (b: string) => {
              await update($, market, x => ({ ...x, board: b }))
              await loadMarket($, false)
            }} />
          <Input key="msearch" placeholder="Search / filter" value={m.search} submitLabel="search"
            onSubmit={async (q: string) => {
              await update($, market, x => ({ ...x, search: q }))
              if (m.registry !== 'skills-sh') await loadMarket($, false)
            }} />
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="mload" label={m.results.length ? 'Reload' : 'Load'} onPress={() => loadMarket($, false)} />
        {m.hasMore && <Button key="mmore" label="Load more" onPress={() => loadMarket($, true)} />}
        {m.status && <Text color="yellow">{m.status}</Text>}
      </Box>
      {shown.map((s, i) => {
        const id = s.skillId || s.name
        const isDone = m.installed.includes(id)
        const repo = parseRepo(s.source) ?? s.source
        return (
          <Box key={`ms-${i}-${id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key={`mi-${i}-${id}`} plain label={isDone ? 'installed' : 'install'} dimColor={isDone}
                onPress={() => isDone ? undefined : withBusy($, `Install ${s.name}`, async () => $.ui.toast(summary(await installRegistrySkill($, s))))} />
              <Link key={`ml-${i}-${id}`} href={`https://github.com/${repo}`} label={s.name} />
              <Text dimColor>{[s.installs ? `${s.installs} installs` : '', s.stars ? `★${s.stars}` : '', repo].filter(Boolean).join(' · ')}</Text>
            </Box>
            {s.description && <Text dimColor wrap="truncate-end">    {s.description}</Text>}
          </Box>
        )
      })}
      {m.log.length > 0 && <Text bold>Activity</Text>}
      {m.log.slice(0, 8).map((l, i) => <Text key={`log-${i}`} dimColor>{l}</Text>)}
    </Box>
  )
}

function renderAdd(ui: any, $: any, a: AddForm, hasFields: boolean) {
  const { Box, Button, Text, Input, Select } = ui
  const isZip = /\.zip$/i.test(a.input.trim())
  const ref = parseSkillRef(a.input)
  const kind = isZip ? 'ZIP archive'
    : ref ? (ref.type === 'skills-sh' ? `skills.sh: ${ref.skillsShId}` : ref.type === 'github-monorepo' ? `GitHub monorepo: ${ref.repo} → ${ref.subpath}` : `GitHub: ${ref.repo}`)
    : a.input ? 'local folder (or unrecognized)' : ''
  const install = () => withBusy($, 'Install', async () => {
    if (isZip) {
      const zip = await previewZip($, a.input.trim())
      await update($, addForm, x => ({ ...x, zip, status: `${zip.skills.length} skill(s) in archive` }))
      return
    }
    const r = await installRef($, a.input, a.version || undefined)
    await afterChange($)
    await update($, addForm, x => ({ ...x, status: summary(r) }))
    $.ui.toast(summary(r))
  })
  const zip = a.zip
  return (
    <Box flexDirection="column">
      <Text dimColor>owner/repo · owner/repo/path/to/skill · GitHub URL · skills.sh URL · local folder · path/to/file.zip</Text>
      {hasFields ? (
        <Input key="addref" placeholder="kepano/obsidian-skills" value={a.input} submitLabel="set"
          onInput={(t: string) => update($, addForm, x => ({ ...x, input: t, versions: [], version: '' }))}
          onSubmit={(t: string) => update($, addForm, x => ({ ...x, input: t }))} />
      ) : (
        <Text dimColor>Use /skills install &lt;ref&gt; on this surface.</Text>
      )}
      {kind && <Text dimColor>Detected: {kind}</Text>}
      <Box flexDirection="row" gap={1}>
        {ref?.type === 'github' && !isZip && (
          <Button key="versions" label="Fetch versions" onPress={() => withBusy($, 'Versions', async () => {
            const tags = (await fetchReleases($, ref.repo)).map(r => r.tag_name)
            await update($, addForm, x => ({ ...x, versions: tags, version: '', status: tags.length ? `${tags.length} release(s)` : 'No releases: the default branch will be installed' }))
          })} />
        )}
        {hasFields && a.versions.length > 0 && (
          <Select key="version" label="Version" value={a.version || 'latest'}
            options={[{ value: 'latest', label: 'Latest' }, ...a.versions.map(t => ({ value: t, label: t }))]}
            onSelect={(t: string) => update($, addForm, x => ({ ...x, version: t === 'latest' ? '' : t }))} />
        )}
        <Button key="install" variant="primary" label={isZip ? 'Preview ZIP' : 'Install'} onPress={install} />
      </Box>
      {a.status && <Text color={a.status.startsWith('Install failed') ? 'red' : undefined}>{a.status}</Text>}
      {zip && (
        <Box flexDirection="column">
          {zip.skills.map(s => (
            <Box key={`z-${s.folder}`} flexDirection="row" gap={1}>
              <Button key={`zi-${s.folder}`} plain label="install" onPress={() => withBusy($, `Install ${s.folder}`, async () => {
                const r = await installZipSkills($, zip, s.folder)
                await afterChange($)
                await update($, addForm, x => ({
                  ...x,
                  status: r.installed.length ? `Installed: ${r.installed.join(', ')}` : `Install failed: ${r.errors.join('; ')}`,
                  zip: x.zip && { ...x.zip, skills: x.zip.skills.filter(k => k.folder !== s.folder) },
                }))
              })} />
              <Text>{s.name}</Text>
              <Text dimColor>→ {skillDir(s.folder)}</Text>
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            <Button key="zall" variant="primary" label="Install all" onPress={() => withBusy($, 'Install ZIP', async () => {
              const r = await installZipSkills($, zip)
              await removeDir($, zip.tmp).catch(() => undefined)
              await afterChange($)
              const status = [r.installed.length > 0 && `Installed: ${r.installed.join(', ')}`, r.errors.length > 0 && `Install failed: ${r.errors.join('; ')}`]
              await update($, addForm, x => ({ ...x, zip: null, status: status.filter(Boolean).join(' · ') }))
            })} />
            <Button key="zcancel" label="Cancel" onPress={async () => {
              await removeDir($, zip.tmp).catch(() => undefined)
              await update($, addForm, x => ({ ...x, zip: null, status: '' }))
            }} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

function renderPlaybooks(ui: any, $: any, rows: PlaybookRow[], v: PlaybookView, d: PlaybookDetail, hasFields: boolean) {
  const { Box, Button, Text, Input, Select, Markdown, Link } = ui
  const shown = filterPlaybooks(rows, v)
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort()
  const opts = (all: string, xs: string[]) => [{ value: '', label: all }, ...xs.map(x => ({ value: x, label: x }))]
  const chainIds = chainList(O.valueChains, [], rows).map(c => c.id)
  return (
    <Box flexDirection="column">
      {hasFields && (
        <Box flexDirection="row" gap={1}>
          <Input key="pbsearch" placeholder="Search playbooks" value={v.search} submitLabel="filter"
            onInput={(q: string) => update($, pbView, x => ({ ...x, search: q }))} onSubmit={(q: string) => update($, pbView, x => ({ ...x, search: q }))} />
          <Select key="pbstatus" label="Status" value={v.status} options={opts('All', uniq([...PLAYBOOK_STATUSES, ...rows.map(p => p.status)]))}
            onSelect={(x: string) => update($, pbView, y => ({ ...y, status: x }))} />
          <Select key="pbchain" label="Chain" value={v.chain} options={[...opts('All', uniq(rows.map(p => p.valueChain))), { value: '(none)', label: '(none)' }]}
            onSelect={(x: string) => update($, pbView, y => ({ ...y, chain: x }))} />
          <Select key="pbmat" label="Maturity" value={v.maturity} options={opts('All', uniq(rows.flatMap(p => p.maturity)))}
            onSelect={(x: string) => update($, pbView, y => ({ ...y, maturity: x }))} />
        </Box>
      )}
      <Text dimColor>
        {rows.length} playbooks · {rows.filter(p => p.status === 'active').length} active · {rows.filter(p => p.isPinned).length} pinned{shown.length !== rows.length ? ` · ${shown.length} shown` : ''}
      </Text>
      {rows.length === 0 && <Text dimColor>No notes with type: playbook under {O.playbookFolders.join(', ')}. Set “Playbook folders” in /config.</Text>}
      {shown.map(p => {
        const isOpen = v.selected === p.path
        return (
          <Box key={`pbrow-${p.path}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key={`pin-${p.path}`} plain label={p.isPinned ? '★' : '☆'} onPress={() => togglePin($, p.path)} />
              <Button key={`run-${p.path}`} plain label="▶ run" onPress={() => withBusy($, `Run ${p.title}`, async () => {
                await runPlaybook($, p)
                $.ui.toast(`Running playbook: ${p.title}`)
              })} />
              <Button key={`pb-${p.path}`} plain label={`${isOpen ? '▾' : '▸'} ${p.title}`} dimColor={p.status === 'retired'}
                onPress={async () => {
                  await update($, pbView, x => ({ ...x, selected: x.selected === p.path ? '' : p.path }))
                  if (!isOpen) await loadPlaybookDetail($, p.path)
                }} />
              <Text dimColor>{[p.status, p.valueChain, p.steps !== undefined && `${p.steps} steps`, p.duration].filter(Boolean).join(' · ')}</Text>
            </Box>
            {isOpen && (
              <Box key={`pbd-${p.path}`} flexDirection="column" paddingLeft={4} marginBottom={1}>
                {([['Trigger', p.trigger], ['Outcome', p.outcome], ['Coverage', p.coverage.join(', ')], ['Maturity', p.maturity.join(', ')],
                  ['Tier', p.pricingTier], ['Tags', p.tags.join(', ')], ['Path', p.path]] as [string, string][])
                  .filter(([, val]) => val).map(([k, val]) => <Text key={`pbm-${k}`} dimColor={k !== 'Trigger' && k !== 'Outcome'}>{k}: {val}</Text>)}
                <Box flexDirection="row" gap={1}>
                  {hasFields && (
                    <Select key={`pbs-${p.path}`} label="Status" value={p.status} options={uniq([...PLAYBOOK_STATUSES, p.status]).map(x => ({ value: x, label: x }))}
                      onSelect={(x: string) => withBusy($, 'Status', () => setPlaybookField($, p.path, 'status', x))} />
                  )}
                  {hasFields && (
                    <Select key={`pbc-${p.path}`} label="Value chain" value={p.valueChain}
                      options={[{ value: '', label: '(none)' }, ...uniq([...chainIds, p.valueChain]).map(x => ({ value: x, label: x }))]}
                      onSelect={(x: string) => withBusy($, 'Value chain', () => setPlaybookField($, p.path, 'value-chain', x))} />
                  )}
                  <Button key={`pbfill-${p.path}`} label="Draft in prompt" onPress={async () => {
                    await $.prompt.fill({ text: await playbookPrompt($, p, '') })
                  }} />
                  <Link key={`pbedit-${p.path}`} href={`file://${absolute(p.path)}`} label="Edit note" />
                </Box>
                {d?.path === p.path ? (
                  <Markdown key={`pbmd-${p.path}`} text={d.body.length > 4000 ? `${d.body.slice(0, 4000)}\n\n…` : d.body || '_(empty)_'} />
                ) : (
                  <Text dimColor>Loading…</Text>
                )}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function renderChains(ui: any, $: any, sk: SkillRow[], pbs: PlaybookRow[], cv: ChainView, hasFields: boolean) {
  const { Box, Button, Text, Select } = ui
  const chains = chainList(O.valueChains, sk, pbs)
  const rows = chainMatrix(chains, sk, pbs).filter(r => cv.showEmpty || r.playbooks.length + r.skills.length > 0)
  const covered = rows.filter(r => r.id && r.playbooks.length > 0 && r.skills.length > 0).length
  const toggle = (id: string) => update($, chainView, x => ({ ...x, expanded: x.expanded.includes(id) ? x.expanded.filter(e => e !== id) : [...x.expanded, id] }))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{covered}/{chains.length} chains have both playbooks and skills</Text>
        <Button key="chempty" plain dimColor label={cv.showEmpty ? 'hide empty chains' : 'show empty chains'}
          onPress={() => update($, chainView, x => ({ ...x, showEmpty: !x.showEmpty }))} />
      </Box>
      {rows.map(r => {
        const key = r.id || 'unassigned'
        const isOpen = cv.expanded.includes(key)
        const gap = r.id && r.id !== 'infrastructure' && r.playbooks.length === 0 ? 'no playbooks' : r.id && r.skills.length === 0 ? 'no skills' : ''
        return (
          <Box key={`ch-${key}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key={`chx-${key}`} plain label={`${isOpen ? '▾' : '▸'} ${r.label}`} dimColor={!r.id} onPress={() => toggle(key)} />
              <Text dimColor>{r.playbooks.length} playbooks ({r.activePlaybooks} active) · {r.skills.length} skills ({r.enabledSkills} on)</Text>
              {gap && <Text color="yellow">{gap}</Text>}
            </Box>
            {isOpen && (
              <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
                {r.stages.length > 0 && <Text dimColor>Stages covered: {r.stages.join(' → ')}</Text>}
                <Text bold>Playbooks</Text>
                {r.playbooks.length === 0 && <Text dimColor>  none</Text>}
                {r.playbooks.map(p => (
                  <Box key={`chp-${key}-${p.path}`} flexDirection="row" gap={1}>
                    <Button key={`chpr-${key}-${p.path}`} plain label="▶" onPress={() => withBusy($, `Run ${p.title}`, async () => {
                      await runPlaybook($, p)
                      $.ui.toast(`Running playbook: ${p.title}`)
                    })} />
                    <Button key={`chpo-${key}-${p.path}`} plain label={p.title} onPress={async () => {
                      await update($, pbView, x => ({ ...x, selected: p.path }))
                      await loadPlaybookDetail($, p.path)
                      await update($, view, x => ({ ...x, tab: 'playbooks' as Tab }))
                    }} />
                    <Text dimColor>{[p.status, p.coverage.join(', ')].filter(Boolean).join(' · ')}</Text>
                  </Box>
                ))}
                <Text bold>Skills</Text>
                {r.skills.length === 0 && <Text dimColor>  none</Text>}
                {r.skills.map(s => (
                  <Box key={`chs-${key}-${s.folder}`} flexDirection="row" gap={1}>
                    <Text dimColor={s.meta.disableModelInvocation}>  {s.meta.name}</Text>
                    {r.id ? (
                      <Button key={`chsr-${key}-${s.folder}`} plain dimColor label="remove"
                        onPress={() => withBusy($, 'Value chain', () => setSkillChains($, s.folder, s.meta.valueChains.filter(c => c !== r.id)))} />
                    ) : hasFields ? (
                      <Select key={`chsa-${s.folder}`} label="assign" value="" options={[{ value: '', label: '—' }, ...chains.map(c => ({ value: c.id, label: c.label }))]}
                        onSelect={(c: string) => c ? withBusy($, 'Value chain', () => setSkillChains($, s.folder, [c])) : undefined} />
                    ) : null}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

// ─── Hooks ───────────────────────────────────────────────────

export const register: Register = (on, options) => {
  O = readOptions(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    CWD = e.cwd
    await $.command.register({
      name: 'skills',
      description: 'Skills Manager: manage SKILL.md skills (no args opens the pane; "help" lists subcommands)',
      argumentHint: '[list|install|enable|disable|update|browse|help …]',
    })
    await $.command.register({
      name: 'playbook',
      description: 'Run a playbook (type: playbook note) by name; no args opens the Playbooks tab',
      argumentHint: '[playbook name] [context]',
    })
    await $.tool.register({
      name: 'skills',
      description: 'Manage the AI agent skills (SKILL.md folders) in the configured skills directory: list/search, show details and security scan, enable/disable (disable-model-invocation), set category or user-invocable, install from GitHub/monorepo/skills.sh/local folder/ZIP, list release versions, check for and apply updates, freeze versions, browse the marketplace, export to other AI tools, regenerate SKILLS.md. Also playbooks (notes with type: playbook): list/search, show, run (returns the run instructions), pin, set status or value chain. And value chains: the chain matrix with gaps, one chain\'s playbooks and skills, add/remove a skill\'s value-chains.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'rescan', 'enable', 'disable', 'invocable', 'category', 'freeze', 'install', 'versions', 'check-updates', 'update', 'browse', 'export', 'index', 'playbooks', 'playbook', 'run', 'pin', 'playbook-status', 'playbook-chain', 'chains', 'chain-add', 'chain-remove'] },
          target: { type: 'string', description: 'Skill folder/name; enable/disable also take a category or "all"; install takes owner/repo, owner/repo/path, a URL, a folder or a .zip; list/browse take a query; versions takes owner/repo' },
          value: { type: 'string', description: 'install/update: version tag; category: the category; invocable: on|off; playbook-status: draft|active|retired; playbook-chain and chain-add/remove: the chain id; run: extra context' },
        },
        required: ['action'],
      },
    })
    if (await $.fs.exists(O.skillsDir)) {
      await $.fs.write(`${O.skillsDir}/${TEMPLATE_FILENAME}`, FRONTMATTER_TEMPLATE).catch(() => undefined)
    }
    if (O.autoUpdate) {
      $.clock.after(60000, () => {
        void checkUpdates($).then(found => {
          for (const [f, v] of Object.entries(found)) $.ui.toast(`Update available for ${f}: ${v}`)
        }).catch(() => undefined)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'playbook' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) {
      await refresh($)
      await refreshPlaybooks($)
      await update($, view, x => ({ ...x, tab: 'playbooks' as Tab }))
      await $.ui.open({ id: PANE, title: 'Skills Manager', focus: true })
      return { text: 'Playbooks opened.' }
    }
    const [arg = '', ...rest] = text.split(/\s+/)
    try {
      return { text: await act($, 'run', arg, rest.join(' ')) }
    } catch (err) {
      return { text: errText(err) }
    }
  })

  on('command.run', { command: 'skills' }, async ($, e) => {
    const [sub = '', arg = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!sub || sub === 'open' || sub === 'view') {
      await refresh($)
      await refreshPlaybooks($)
      await $.ui.open({ id: PANE, title: 'Skills Manager', focus: true })
      return { text: `Skills Manager opened (${O.skillsDir}).` }
    }
    if (sub === 'help') return { text: HELP }
    try {
      return { text: await act($, sub, arg, rest.join(' ')) }
    } catch (err) {
      return { text: `${errText(err)}\n\n${HELP}` }
    }
  })

  on('tool.call', { tool: 'mcp__skills-manager__skills' }, async ($, e) => {
    const input = e as unknown as { action: string; target?: string; value?: string }
    try {
      return { result: await act($, input.action, input.target ?? '', input.value ?? '', true) }
    } catch (err) {
      return { result: `Error: ${errText(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box } = ui
    const hasFields = e.surface !== 'mobile'
    const v = await read($, view)
    const b = await read($, busy)
    let body
    if (v.tab === 'playbooks') body = renderPlaybooks(ui, $, await read($, playbooks), await read($, pbView), await read($, pbDetail), hasFields)
    else if (v.tab === 'chains') body = renderChains(ui, $, await read($, skills), await read($, playbooks), await read($, chainView), hasFields)
    else if (v.tab === 'marketplace') body = renderMarket(ui, $, await read($, market), hasFields)
    else if (v.tab === 'add') body = renderAdd(ui, $, await read($, addForm), hasFields)
    else body = renderInstalled(ui, $, await read($, skills), v, await read($, detail), hasFields)
    return (
      <Box flexDirection="column">
        {renderTabs(ui, $, v, b)}
        {body}
      </Box>
    )
  })
}
