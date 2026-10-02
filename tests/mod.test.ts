import { expect, mock, test } from 'claude-code/testing'

// An in-memory skills folder beneath the plugin: fs.list / read / write / exists.
// The engine hands these hooks absolute paths; files are keyed relative to the cwd.
function vault(on: any, files: Record<string, string>) {
  const rel = (p: string) => p.replace(/^\/.*?\/(?=\.claude\/|SKILLS\.md$)/, '')
  const dirsOf = (path: string) => {
    const prefix = `${path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue
      const [head, ...rest] = f.slice(prefix.length).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
  }
  on('fs.list', ($: any, e: any) => ({ value: dirsOf(rel(e.path)) }))
  on('fs.read', ($: any, e: any) => {
    return files[rel(e.path)] === undefined ? { deny: `ENOENT: ${rel(e.path)}` } : { value: files[rel(e.path)] }
  })
  on('fs.write', ($: any, e: any) => {
    files[rel(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.exists', ($: any, e: any) => ({ value: files[rel(e.path)] !== undefined || Object.keys(files).some(f => f.startsWith(`${rel(e.path)}/`)) }))
  return files
}

const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} skill\ncategory: research\n${extra}---\nBody of ${name}\n`

test('/skills list, disable and index', async ($, on) => {
  mock.store(on)
  const files = vault(on, {
    '.claude/skills/alpha/SKILL.md': skill('alpha'),
    '.claude/skills/beta/SKILL.md': skill('beta', 'disable-model-invocation: true\n'),
    '.claude/skills/notes.md': 'not a skill',
  })
  const listed = await $.command.run({ command: 'skills', args: 'list' })
  expect(listed.text).toContain('2 skills')
  expect(listed.text).toContain('1 enabled')

  const off = await $.command.run({ command: 'skills', args: 'disable alpha' })
  expect(off.text).toContain('Disabled 1')
  expect(files['.claude/skills/alpha/SKILL.md']).toContain('disable-model-invocation: true')
  expect(files['SKILLS.md']).toContain('Total: 0 enabled skills')

  const on2 = await $.command.run({ command: 'skills', args: 'enable research' })
  expect(on2.text).toContain('Enabled 2')
  expect(files['SKILLS.md']).toContain('- beta: beta skill')

  const cat = await $.command.run({ command: 'skills', args: 'category beta sales' })
  expect(cat.text).toBe('beta → sales')
  expect(files['.claude/skills/beta/SKILL.md']).toContain('category: sales')
})

test('pane toggles a skill on every surface with fields', async ($, on) => {
  mock.store(on)
  const files = vault(on, { '.claude/skills/alpha/SKILL.md': skill('alpha') })
  const props = { title: 'Skills Manager', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
  for (const surface of ['terminal', 'desktop'] as const) {
    files['.claude/skills/alpha/SKILL.md'] = skill('alpha')
    const ui = await $.ui.mount({ plugin: 'skills-manager', surface, component: 'Pane', requestId: 'skills-manager', props } as any)
    await ui.press({ key: 'rescan' })
    await ui.press({ key: 'exp-research' })
    await ui.press({ key: 'on-alpha' })
    expect(files['.claude/skills/alpha/SKILL.md']).toContain('disable-model-invocation: true')
    await ui.press({ key: 'exp-research' }) // view state is shared across mounts: collapse again
    await ui.unmount()
  }
})
