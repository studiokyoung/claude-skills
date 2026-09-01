// ~/claude-skills/router/test/git-commit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, tmpDir, runHook, testEnv } from './helpers.mjs';
import { fingerprint, markerPath, readMarker, writeMarker, clearMarker, stagedPaths, changedPaths, toplevel } from '../lib/git.mjs';
import { parseCommand, bashWriteTargets, bashWriteTargetsWithBase, candidateSet } from '../lib/commit.mjs';

test('parseCommand: plain, chained add, env override, -C, amend, non-commit, quoted echo', () => {
  assert.equal(parseCommand('git commit -m "x"').isCommit, true);
  const chained = parseCommand('git add -A && git commit -m "a && b"');
  assert.equal(chained.isCommit, true); assert.equal(chained.adds[0].all, true);
  const skip = parseCommand('SKIP_VERIFY=1 git commit -am "docs"');
  assert.equal(skip.skip, true); assert.equal(skip.commit.all, true);
  const c = parseCommand('git -C /tmp/x commit --amend --no-edit');
  assert.equal(c.commit.cPath, '/tmp/x'); assert.equal(c.commit.amend, true);
  assert.equal(parseCommand('git status && git log --oneline -3').isCommit, false);
  assert.equal(parseCommand('echo "git commit -m x"').isCommit, false);
  const cd = parseCommand('cd web && git add app/page.tsx lib && git commit -m "feat"');
  assert.equal(cd.isCommit, true); assert.deepEqual(cd.adds[0].paths, ['app/page.tsx', 'lib']); assert.equal(cd.adds[0].all, false);
  const heredoc = parseCommand('git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nbody\nEOF\n)"');
  assert.equal(heredoc.isCommit, true);
});

test('bashWriteTargets: redirects, tee, heredoc, dev/null, quoted >', () => {
  assert.deepEqual(bashWriteTargets("cat > web/components/Toast.tsx <<'EOF'\nx\nEOF"), ['web/components/Toast.tsx']);
  assert.deepEqual(bashWriteTargets('echo hi > /dev/null'), []);
  assert.deepEqual(bashWriteTargets('npm test 2>&1 | tee out.log'), ['out.log']);
  assert.deepEqual(bashWriteTargets('printf x >> notes.md'), ['notes.md']);
  assert.deepEqual(bashWriteTargets('echo ">"'), []);
  assert.deepEqual(bashWriteTargets('ls -la'), []);
});

test('candidateSet: staged only, -a, git add dir, git add -A', () => {
  const { dir, git } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a', 'web/lib/x.ts': 'b', 'README.md': 'r' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a2');
  fs.writeFileSync(path.join(dir, 'web/lib/x.ts'), 'b2');
  fs.writeFileSync(path.join(dir, 'web/new.ts'), 'n');
  git('add', 'web/app/page.tsx');
  assert.deepEqual(candidateSet(dir, { all: false }, []), ['web/app/page.tsx']);
  assert.deepEqual(candidateSet(dir, { all: true }, []).sort(), ['web/app/page.tsx', 'web/lib/x.ts']);
  assert.deepEqual(candidateSet(dir, { all: false }, [{ all: false, paths: ['web/lib'] }]).sort(), ['web/app/page.tsx', 'web/lib/x.ts']);
  assert.deepEqual(candidateSet(dir, { all: false }, [{ all: true, paths: [] }]).sort(), ['web/app/page.tsx', 'web/lib/x.ts', 'web/new.ts']);
  assert.deepEqual(stagedPaths(dir), ['web/app/page.tsx']);
  assert.deepEqual(changedPaths(dir).sort(), ['web/app/page.tsx', 'web/lib/x.ts', 'web/new.ts']);
});

test('fingerprint: stable, changes on tracked edit, on new untracked file, on same-length untracked edit', () => {
  const { dir } = makeRepo('portfolio-html', { 'a.txt': 'aaaa' });
  const f0 = fingerprint(dir);
  assert.equal(fingerprint(dir), f0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bbbb');
  const f1 = fingerprint(dir); assert.notEqual(f1, f0);
  fs.writeFileSync(path.join(dir, 'u.txt'), 'cccc');
  const f2 = fingerprint(dir); assert.notEqual(f2, f1);
  fs.writeFileSync(path.join(dir, 'u.txt'), 'dddd');
  const f3 = fingerprint(dir); assert.notEqual(f3, f2);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  assert.equal(fingerprint(path.join(dir, 'sub')), f3);
  assert.equal(fingerprint(tmpDir('nogit-')), null);
});

test('marker read/write/clear lives in .git and never in the tree', () => {
  const { dir, git } = makeRepo('portfolio-html');
  const p = markerPath(dir);
  assert.equal(p, path.join(toplevel(dir), '.git', 'verify-pass'));
  assert.equal(readMarker(dir), null);
  assert.equal(writeMarker(dir, { fingerprint: 'f', ts: 't' }), true);
  assert.deepEqual(readMarker(dir), { fingerprint: 'f', ts: 't' });
  assert.equal(git('status', '--porcelain').stdout.trim(), '');
  clearMarker(dir);
  assert.equal(readMarker(dir), null);
});

test('mark-pass CLI writes a marker matching the live fingerprint; --clear removes; non-git reports', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'x' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'y');
  const w = runHook('mark-pass.mjs', null, env, ['--root', path.join(dir, 'web'), '--gates', '{"git":"PASS","typecheck":"PASS"}', '--routes', '["/"]']);
  assert.equal(w.json.ok, true);
  const m = readMarker(dir);
  assert.equal(m.fingerprint, fingerprint(dir));
  assert.deepEqual(m.gates, { git: 'PASS', typecheck: 'PASS' });
  assert.deepEqual(m.routes, ['/']);
  assert.match(m.ts, /[+-]\d{2}:\d{2}$/);
  const c = runHook('mark-pass.mjs', null, env, ['--root', dir, '--clear']);
  assert.equal(c.json.cleared, true); assert.equal(readMarker(dir), null);
  const n = runHook('mark-pass.mjs', null, env, ['--root', tmpDir('nogit-')]);
  assert.deepEqual(n.json, { ok: false, reason: 'not-a-git-repo' });
});

test('parseCommand: SKIP_VERIFY only as an env prefix, shell prefixes, base from cd/-C, quoted paths', () => {
  assert.equal(parseCommand('git commit -m "docs: use SKIP_VERIFY=1 to bypass"').skip, false);
  assert.equal(parseCommand('SKIP_VERIFY=1 git commit -m x').skip, true);
  assert.equal(parseCommand('cd web && SKIP_VERIFY=1 git commit -m x').skip, true);
  assert.equal(parseCommand('if true; then git commit -m x; fi').isCommit, true);
  assert.equal(parseCommand('cd web && git add app/page.tsx && git commit -m x').adds[0].base, 'web');
  assert.equal(parseCommand('git -C web add app/page.tsx && git commit -m x').adds[0].base, 'web');
  assert.deepEqual(parseCommand('git add "web/my file.tsx" && git commit -m x').adds[0].paths, ['web/my file.tsx']);
});

test('parseCommand: commit base from cd/-C and commit pathspecs', () => {
  assert.equal(parseCommand('cd /tmp/x && git commit -m "a"').commit.base, '/tmp/x');
  assert.equal(parseCommand('git -C web commit -m "a"').commit.base, 'web');
  assert.deepEqual(parseCommand('git commit -m "msg" web/app/page.tsx').commit.paths, ['web/app/page.tsx']);
  assert.deepEqual(parseCommand('git commit --author="A <a@b>" -m "m" -- "web/my file.tsx"').commit.paths, ['web/my file.tsx']);
  assert.deepEqual(parseCommand('git commit -m "$(cat <<\'EOF\'\nfeat\nEOF\n)"').commit.paths, []);
  assert.deepEqual(parseCommand('git commit -am "docs"').commit.paths, []);
});

test('bashWriteTargets: quoted target and >| clobber', () => {
  assert.deepEqual(bashWriteTargets('echo hi > "my file.txt"'), ['my file.txt']);
  assert.deepEqual(bashWriteTargets('cmd >| out.txt'), ['out.txt']);
});

test('candidateSet: cwd/base resolution, globs, quoted and outside-the-repo paths, commit pathspecs', () => {
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a', 'web/lib/x.ts': 'b', 'web/my file.tsx': 'm' });
  for (const f of ['web/app/page.tsx', 'web/lib/x.ts', 'web/my file.tsx']) fs.writeFileSync(path.join(dir, f), 'edited');
  const none = { all: false };
  assert.deepEqual(candidateSet(dir, none, [{ base: 'web', paths: ['app/page.tsx'] }], dir), ['web/app/page.tsx']);
  assert.deepEqual(candidateSet(dir, none, [{ paths: ['web/*.ts*'] }], dir).sort(), ['web/app/page.tsx', 'web/lib/x.ts', 'web/my file.tsx']);
  assert.deepEqual(candidateSet(dir, none, [{ paths: ['web/my file.tsx'] }], dir), ['web/my file.tsx']);
  assert.deepEqual(candidateSet(dir, none, [{ paths: ['../outside.txt'] }], dir), []);
  assert.deepEqual(candidateSet(dir, none, [{ paths: ['app/page.tsx'] }], path.join(dir, 'web')), ['web/app/page.tsx']);
  assert.deepEqual(candidateSet(dir, { all: false, base: null, paths: ['web/app/page.tsx'] }, [], dir), ['web/app/page.tsx']);
  assert.deepEqual(candidateSet(dir, { all: false, base: 'web', paths: ['app/page.tsx'] }, [], dir), ['web/app/page.tsx']);
});

test('null contract: a failed listing is never an empty set', () => {
  const nogit = tmpDir('nogit-');
  assert.equal(changedPaths(nogit), null);
  assert.equal(candidateSet(nogit, { all: false }, []), null);
});

test('fingerprint: staging-neutral, mode-aware, fails closed when a file cannot be hashed', () => {
  const { dir, git } = makeRepo('portfolio-html', { 'a.txt': 'aaaa', 'bad.txt': 'x' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bbbb');
  const f1 = fingerprint(dir);
  git('add', 'a.txt');
  assert.equal(fingerprint(dir), f1);
  fs.chmodSync(path.join(dir, 'a.txt'), 0o755);
  assert.notEqual(fingerprint(dir), f1);
  // An unreadable NEW file is stamped, never read, so it cannot fail the hash…
  const fresh = path.join(dir, 'fresh.txt');
  fs.writeFileSync(fresh, 'x');
  fs.chmodSync(fresh, 0o000);
  assert.equal(typeof fingerprint(dir), 'string');
  fs.chmodSync(fresh, 0o644);
  fs.unlinkSync(fresh);
  // …but a TRACKED file the hasher cannot read fails closed: no hash over less than the whole tree.
  const bad = path.join(dir, 'bad.txt');
  fs.writeFileSync(bad, 'xx');
  fs.chmodSync(bad, 0o000);
  assert.equal(fingerprint(dir), null);
  const { env } = testEnv();
  assert.deepEqual(runHook('mark-pass.mjs', null, env, ['--root', dir]).json, { ok: false, reason: 'fingerprint-failed' });
  fs.chmodSync(bad, 0o644);
  fs.writeFileSync(bad, 'x');
  const before = fingerprint(dir);
  git('mv', 'a.txt', 'b.txt');
  const after = fingerprint(dir);
  assert.equal(typeof after, 'string');
  assert.notEqual(after, before);
});

test('mark-pass: malformed --gates/--routes are errors and write nothing', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'a.txt': 'a' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'b');
  assert.deepEqual(runHook('mark-pass.mjs', null, env, ['--root', dir, '--gates', '{not json']).json, { ok: false, reason: 'bad-gates-json' });
  assert.equal(readMarker(dir), null);
  assert.deepEqual(runHook('mark-pass.mjs', null, env, ['--root', dir, '--routes', '[oops']).json, { ok: false, reason: 'bad-routes-json' });
  assert.equal(readMarker(dir), null);
});

test('parseCommand: SKIP_VERIFY is judged outside quoted strings and heredoc bodies', () => {
  assert.equal(parseCommand('git commit -m "wip; SKIP_VERIFY=1 git commit -m x"').skip, false);
  assert.equal(parseCommand("git commit -m \"$(cat <<'EOF'\nSKIP_VERIFY=1 git commit -m x\nEOF\n)\"").skip, false);
  assert.equal(parseCommand('SKIP_VERIFY=1 git commit -m "x"').skip, true);
  assert.equal(parseCommand('cd web; SKIP_VERIFY=1 git commit -m x').skip, true);
});

test('command substitution in pathspec position makes the candidate set unknown, never empty', () => {
  const { dir } = makeRepo('portfolio-html', { 'src/app.ts': 'a' });
  fs.writeFileSync(path.join(dir, 'src/app.ts'), 'b');
  const add = parseCommand('git add "$(git rev-parse --show-toplevel)/src/app.ts" && git commit -m x');
  assert.equal(add.adds[0].unknown, true);
  assert.equal(candidateSet(dir, add.commit, add.adds, dir), null);
  const c = parseCommand('git commit -m x "$(echo src/app.ts)"');
  assert.equal(c.commit.unknown, true);
  assert.equal(candidateSet(dir, c.commit, c.adds, dir), null);
  const bt = parseCommand('git add `ls src` && git commit -m x');
  assert.equal(bt.adds[0].unknown, true);
  const heredoc = parseCommand('git commit -m "$(cat <<\'EOF\'\nfeat\nEOF\n)"');
  assert.equal(heredoc.isCommit, true);
  assert.deepEqual(heredoc.commit.paths, []);
  assert.ok(!heredoc.commit.unknown);
});

test('fingerprint: new files are stamped by size+mtime, tracked files by content', () => {
  const { dir, git } = makeRepo('portfolio-html', { 'a.txt': 'aaaa' });
  const u = path.join(dir, 'u.txt');
  fs.writeFileSync(u, 'cccc');
  const f0 = fingerprint(dir);
  fs.writeFileSync(u, 'dddd'); // same size, later mtime
  const f1 = fingerprint(dir);
  assert.notEqual(f1, f0);
  git('add', 'u.txt'); // staging a new file is not a tree change
  assert.equal(fingerprint(dir), f1);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bbbb'); // tracked, same size: the blob hash moves it
  const f2 = fingerprint(dir);
  assert.notEqual(f2, f1);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bbbbb');
  assert.notEqual(fingerprint(dir), f2);
});

test('parseCommand: subshell parens, -C composed with cd, pathspec-from-file, heredoc bodies', () => {
  const sub = parseCommand('(cd /tmp/x && git commit -am "m")');
  assert.equal(sub.isCommit, true);
  assert.equal(sub.commit.base, '/tmp/x');
  assert.equal(sub.commit.all, true);
  assert.deepEqual(parseCommand('(cd /tmp/x && git commit -m "m" app/page.tsx)').commit.paths, ['app/page.tsx']);
  assert.deepEqual(parseCommand('cd "/tmp/my repo" && git commit -m x').commit.base, '/tmp/my repo');
  // `git -C` is relative to the shell's cwd, so a preceding `cd` composes with it.
  assert.equal(parseCommand('cd /tmp/x && git -C . commit -m m').commit.base, '/tmp/x');
  assert.equal(parseCommand('cd /tmp/x/web && git -C .. commit -m m').commit.base, '/tmp/x');
  assert.equal(parseCommand('cd /tmp/x && git -C /other add a.ts && git commit -m m').adds[0].base, '/other');
  assert.equal(parseCommand('cd web && git -C lib add a.ts && git commit -m m').adds[0].base, path.join('web', 'lib'));
  // A file of pathspecs the hook cannot read: unknown, never an empty (silently allowed) set.
  assert.equal(parseCommand('git commit --pathspec-from-file=paths.txt -m m').commit.unknown, true);
  assert.equal(parseCommand('git add --pathspec-from-file paths.txt && git commit -m m').adds[0].unknown, true);
  // A commit inside a heredoc body is documentation, not a command.
  const doc = parseCommand('cat > web/app/note.md <<EOF\nRun this to ship:\ngit commit -m "example"\nEOF');
  assert.equal(doc.isCommit, false);
  const many = parseCommand('cat > a.md <<A\ngit commit -m x\nA\ncat > b.md <<B\ngit commit -m y\nB\ngit commit -m real');
  assert.equal(many.isCommit, true);
  assert.deepEqual(many.commit.paths, []);
});

test('parseCommand: an unquoted heredoc body cannot grant SKIP_VERIFY', () => {
  const doc = parseCommand('cat > notes.md <<EOF\nSKIP_VERIFY=1 git commit -m x\nEOF\ngit commit -m y');
  assert.equal(doc.skip, false);
  assert.equal(doc.isCommit, true);
  const dash = parseCommand('cat > notes.md <<-EOF\n\tSKIP_VERIFY=1 git commit -m x\n\tEOF\ngit commit -m y');
  assert.equal(dash.skip, false);
  assert.equal(dash.isCommit, true);
});

test('bashWriteTargetsWithBase: each target carries the cd it was written under', () => {
  assert.deepEqual(bashWriteTargetsWithBase('cd /tmp/scratch && cat > web/app/x.tsx <<EOF\nx\nEOF'), [{ target: 'web/app/x.tsx', base: '/tmp/scratch' }]);
  assert.deepEqual(bashWriteTargetsWithBase('printf x >> notes.md'), [{ target: 'notes.md', base: null }]);
  assert.deepEqual(bashWriteTargetsWithBase('cd web && npm test | tee out.log'), [{ target: 'out.log', base: 'web' }]);
  assert.deepEqual(bashWriteTargetsWithBase('echo hi > /dev/null'), []);
  assert.deepEqual(bashWriteTargets('cd /tmp/scratch && cat > web/app/x.tsx <<EOF\nx\nEOF'), ['web/app/x.tsx']);
});

test('mark-pass: --routes takes a bare comma list, --gates stays strict JSON', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'a.txt': 'a' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'b');
  const one = runHook('mark-pass.mjs', null, env, ['--root', dir, '--routes', '/']);
  assert.equal(one.json.ok, true);
  assert.deepEqual(readMarker(dir).routes, ['/']);
  runHook('mark-pass.mjs', null, env, ['--root', dir, '--routes', '/,/work/x']);
  assert.deepEqual(readMarker(dir).routes, ['/', '/work/x']);
  runHook('mark-pass.mjs', null, env, ['--root', dir, '--routes', '["/","/work/x"]']);
  assert.deepEqual(readMarker(dir).routes, ['/', '/work/x']);
  // Nothing usable, and anything that meant to be JSON, are still errors.
  assert.deepEqual(runHook('mark-pass.mjs', null, env, ['--root', dir, '--routes', ' , ']).json, { ok: false, reason: 'bad-routes-json' });
  assert.deepEqual(runHook('mark-pass.mjs', null, env, ['--root', dir, '--gates', 'git=PASS']).json, { ok: false, reason: 'bad-gates-json' });
});

test('parseCommand: a herestring or a quoted mention of << is not a heredoc opener', () => {
  // A bogus opener never finds its terminator, so every following line disappears and a real
  // commit becomes invisible: a silent allow. Guard `<<<`, quoted mentions, and shift operators.
  assert.equal(parseCommand('jq -r . <<< "$payload"\ngit commit -am x').isCommit, true);
  assert.equal(parseCommand('grep q <<<hello\ngit commit -am x').isCommit, true);
  assert.equal(parseCommand('echo "use << EOF here" > n.txt\ngit commit -am x').isCommit, true);
  assert.equal(parseCommand('echo "<< EOF"; git commit -am x').isCommit, true);
  assert.equal(parseCommand('$(( a << 2 ))\ngit commit -am x').isCommit, true);
  // …while a real heredoc still swallows its body, and only its body.
  assert.equal(parseCommand('cat > n.md <<EOF\ngit commit -m "in body"\nEOF').isCommit, false);
  assert.equal(parseCommand('cat > n.md <<EOF\nx\nEOF\ngit commit -am y').isCommit, true);
  assert.equal(parseCommand("cat > n.md <<'EOF'\ngit commit -m x\nEOF").isCommit, false);
});
