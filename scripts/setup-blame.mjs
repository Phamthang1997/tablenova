/**
 * Points `git blame` at `.git-blame-ignore-revs`, once per clone, from `postinstall`.
 *
 * Why a script and not a documented command: without it, blame answers "style: format the Rust
 * crate with rustfmt" for most of the Rust code, because that one commit touched 112 files and is
 * therefore the last commit to have touched nearly every line. The question people actually ask is
 * who wrote the logic, and the ignore file makes blame walk past the reformat to reach it.
 *
 * Why it cannot be automatic in git itself: `git config` writes to `.git/config`, which is not part
 * of the repository. Git deliberately refuses to let a cloned repo configure the machine that
 * cloned it — otherwise cloning anything would let it set `core.pager` and run commands. So the
 * hook has to be something the developer already runs, and `npm install` is that.
 *
 * Deliberately NOT `git config --global`: that would apply to every repository, and blame FAILS
 * outright in any repo without this file. A global setting trades a small annoyance for a broken
 * command everywhere else.
 *
 * Every failure is swallowed on purpose. This is a convenience for reading history; it must never
 * be the reason `npm install` fails — a tarball install with no `.git`, a shallow CI checkout, or
 * git missing from PATH are all fine outcomes here.
 */
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs'], {
    stdio: 'ignore',
  });
} catch {
  // Not a git checkout, or no git. Nothing to configure and nothing to report.
}
