// Runs after `yarn version` bumps the version, commits, and tags vX.Y.Z.
// Pushes main + the new tag to origin. The CI workflow on tag push runs
// test + dist-fresh, then force-moves the floating major tag (vX).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execSync } = require('node:child_process')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json')

const major = version.split('.')[0]
const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
if (branch !== 'main') {
  console.error(
    `postversion: refusing to push, not on main (currently '${branch}'). Tag and commit are already created locally — push manually if intentional.`,
  )
  process.exit(1)
}

console.log(`\n  Pushing main and v${version} to origin...`)
execSync(`git push origin main "v${version}"`, { stdio: 'inherit' })

console.log(`\n  Released v${version}. CI will move v${major} once test + dist-fresh pass.\n`)
