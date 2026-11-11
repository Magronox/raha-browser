// The "Source:" line of THIRD_PARTY_NOTICES.txt for one package. Many
// packages name their repository as an SSH URL (ssh://git@github.com/…,
// git+ssh://…, git@github.com:…), which only opens for someone with an SSH
// key. MPL-2.0 §3.2(a) wants a source pointer anyone can follow, so a GitHub
// SSH URL becomes https://github.com/<owner>/<repo>/tree/<tag> — the source
// at the exact version shipped. Pure, no network: tag names were checked by
// hand with `git ls-remote --tags` (2026-11-06).

/** Repositories whose release tags are not `v<version>`. */
export const TAG_PREFIX = /** @type {Record<string, string>} */ ({
  'jprichardson/node-jsonfile': '', // tags are bare: 6.2.1
});

/**
 * @param {unknown} repo package.json `repository` (string or { url })
 * @param {string} version the package version shipped
 * @returns {string} '' when the package names no repository
 */
export function sourceUrl(repo, version) {
  const raw = typeof repo === 'string' ? repo
    : repo && typeof repo === 'object' && 'url' in repo ? String(repo.url ?? '') : '';
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)\/?$/.exec(url);
  if (!ssh) return url;
  const slug = `${ssh[1]}/${ssh[2]}`;
  const prefix = TAG_PREFIX[slug] ?? 'v';
  return `https://github.com/${slug}/tree/${prefix}${version}`;
}
