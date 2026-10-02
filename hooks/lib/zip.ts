// Group the SKILL.md files found in an extracted archive into skill folders.

/**
 * `skillMdPaths` are relative to the extraction root. Returns each skill's
 * folder (relative to the root) and the install name, with a shared single
 * wrapper directory stripped (archive.zip → wrapper/skill-a, wrapper/skill-b).
 */
export function groupZipSkills(skillMdPaths: string[]): { dir: string; folder: string }[] {
  const dirs = skillMdPaths.map(p => p.split('/').slice(0, -1).join('/'))
  let prefix = ''
  const first = dirs[0]?.split('/') ?? []
  if (first.length >= 2 && dirs.every(d => d.startsWith(`${first[0]}/`))) prefix = `${first[0]}/`
  return dirs
    .map(dir => ({ dir, folder: prefix ? dir.slice(prefix.length) : dir }))
    .filter(s => s.folder !== '')
    .map(s => ({ dir: s.dir, folder: s.folder.split('/').pop()! }))
}
