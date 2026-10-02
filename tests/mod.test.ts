import { expect, mock, test } from 'claude-code/testing'

// An in-memory skills folder beneath the plugin: fs.list / read / write / exists.
// The engine hands these hooks absolute paths; files are keyed relative to the cwd.
function vault(on: any, files: Record<string, string>) {
  const rel = (p: string) => p.replace(/^\/.*?\/(?=(?:\.claude|00-CORE|10-ME|20-COMPANY|30-CLIENTS)(?:\/|$)|SKILLS\.md$)/, '')
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

const playbook = (title: string, chain: string) =>
  `---\ntype: playbook\ntitle: ${title}\ntrigger: t\noutcome: o\nstatus: draft\nvalue-chain: ${chain}\ntotal-steps: 3\n---\nSteps\n`

test('playbooks: list, status, run and value chains', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', ($2: any, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const files = vault(on, {
    '.claude/skills/crm/SKILL.md': skill('crm'),
    '00-CORE/Playbooks/close-deal.md': playbook('Close a deal', 'lead-to-cash'),
    '00-CORE/Playbooks/templates/tpl.md': playbook('Template', 'lead-to-cash'),
    '30-CLIENTS/acme/Playbooks/onboard.md': playbook('Onboard Acme', ''),
    '00-CORE/Playbooks/readme.md': '# not a playbook',
  })
  const listed = await $.command.run({ command: 'skills', args: 'playbooks' })
  expect(listed.text).toContain('Close a deal')
  expect(listed.text).toContain('Onboard Acme')
  expect(listed.text).not.toContain('Template')

  await $.command.run({ command: 'skills', args: 'playbook-status Close a deal active' })
  expect(files['00-CORE/Playbooks/close-deal.md']).toContain('status: active')

  const ran = await $.command.run({ command: 'playbook', args: 'Close a deal' })
  expect(ran.text).toContain('Running playbook')
  await clock.advance(10)
  expect(prompts[0]).toContain('00-CORE/Playbooks/close-deal.md')

  await $.command.run({ command: 'skills', args: 'chain-add crm lead-to-cash' })
  expect(files['.claude/skills/crm/SKILL.md']).toContain('value-chains: [lead-to-cash]')
  const chains = await $.command.run({ command: 'skills', args: 'chains lead-to-cash' })
  expect(chains.text).toContain('Close a deal')
  expect(chains.text).toContain('crm')
  const matrix = await $.command.run({ command: 'skills', args: 'chains' })
  expect(matrix.text).toContain('Unassigned')
})

test('pane: playbook pin, run and chains tab on every surface with fields', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', ($2: any, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  vault(on, { '00-CORE/Playbooks/close-deal.md': playbook('Close a deal', 'lead-to-cash') })
  const props = { title: 'Skills Manager', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'skills-manager', surface, component: 'Pane', requestId: 'skills-manager', props } as any)
    await ui.press({ key: 'tab-playbooks' })
    const pinKey = 'pin-00-CORE/Playbooks/close-deal.md'
    expect((await ui.find({ key: pinKey }))?.text).toContain('☆')
    await ui.press({ key: pinKey })
    expect((await ui.find({ key: pinKey }))?.text).toContain('★')
    await ui.press({ key: pinKey })
    await ui.press({ key: 'run-00-CORE/Playbooks/close-deal.md' })
    await clock.advance(10)
    expect(prompts.at(-1)).toContain('Close a deal')
    await ui.press({ key: 'tab-chains' })
    await ui.press({ key: 'chx-lead-to-cash' })
    expect(await ui.find({ key: 'chpo-lead-to-cash-00-CORE/Playbooks/close-deal.md' })).toBeDefined()
    await ui.press({ key: 'chx-lead-to-cash' })
    await ui.press({ key: 'tab-installed' })
    await ui.unmount()
  }
})
