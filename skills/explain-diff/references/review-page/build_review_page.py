#!/usr/bin/env python3
"""Build the explain-diff review page: one self-contained HTML file.

Usage:
    python3 build_review_page.py <notes.json> <out.html>

The page has a left rail (brand, section nav, compare base), an overview with
stat cards, section 01 = one before / after / meaning card per logical change
(searchable, verdict pill, evidence path:line), section 02 = the real unified
diff per file behind file buttons, then numbered prose sections and an optional
closing question. CSS, JS and data are inlined; nothing loads from the network.

The script reads the diff itself (git diff / log / rev-parse / show only) for
the range <before>..<after>; the caller never supplies diff data.

Input JSON (unknown fields are an error):

    repo        str   required  absolute path of the git repository
    before      str   required  base ref; the range is before..after
    after       str   required  head ref
    title       str   required  page headline (h1)
    changes     list  required  one entry per logical change, see below
    subtitle    str   optional  one or two sentences under the headline
    lang        str   optional  "ko" or "en" (default "en"); UI label set
    brand       str   optional  rail label (default "Review")
    eyebrow     str   optional  small caps line above the page (default: date + "REVIEWED CHANGES")
    ticket      str   optional  short label such as an issue key; shown as a pill and in the rail
    remote_url  str   optional  e.g. https://github.com/<owner>/<repo>; when present, `path:line`
                                evidence and diff line numbers link to <remote_url>/blob/<ref>/<path>#L<n>;
                                when absent they render as <code> / plain numbers only
    glossary    str   optional  markdown (pipe table or list), shown in the overview
    sections    list  optional  ordered free prose sections after the diff, numbered 03, 04, ...
                                { id: "checks" (lowercase, a-z 0-9 -), heading: str, markdown: str }
    question    str   optional  closing callout (inline markdown)
    stats       list  optional  overview cards { label, value, sub? }; derived when absent
                                (number of changes, verdict counts, files changed)

    changes[]:
      id        str   required  short unique id, e.g. "1", "H3", "F1"
      group     str   required  file path or topic the card is grouped under
      title     str   required  one line
      verdict   str   required  "keep" | "cut" | "trim" | "ask"
      before    str   required  inline markdown: behaviour before the change
      after     str   required  inline markdown: behaviour after the change
      why       str   required  inline markdown: what it means and why it exists (evidence)
      files     list  required  paths in the diff; each becomes a button opening that file's diff
      evidence  list  optional  "path:line" or "path:start-end" labels
      followup  bool  optional  true = a change made after a review; shown with its own tag

Markdown (prose fields): ## / ### headings, paragraphs, pipe tables, - / * / 1.
lists, fenced code, `inline code`, **bold**, [text](https://...). Everything is
HTML-escaped. A backticked `path:line` becomes an evidence link when remote_url
is set.

Minimal example:

    {
      "repo": "/abs/path/to/repo", "before": "main", "after": "HEAD", "lang": "en",
      "title": "Retry the flaky upload once",
      "changes": [
        {"id": "1", "group": "src/upload.ts", "title": "One retry on network error",
         "verdict": "keep", "before": "A dropped connection failed the upload.",
         "after": "`upload` retries once after 500 ms.",
         "why": "Requested in the task. See `src/upload.ts:42`.",
         "files": ["src/upload.ts"], "evidence": ["src/upload.ts:42"]}
      ]
    }

Fails loudly (exit 1) on an unknown field, a missing required field, a bad
verdict, a malformed evidence label, a files[] path not in the diff, or a
template placeholder that is missing or left unreplaced.
"""
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
import html
import json
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent

LABELS = {
    'ko': {
        'skip': '본문으로 이동',
        'nav': '읽을 범위',
        'rail_suffix': 'EXPLAIN DIFF',
        'compare_base': '비교 기준',
        'commits_n': '{n}개 커밋',
        'files_n': '{n}개 파일',
        'remote_compare': '원격 비교 ↗',
        'overview_nav': '먼저 볼 변경',
        'changes_nav': '바뀐 동작과 이유',
        'code_nav': '파일별 실제 diff',
        'reading_guide': '먼저 <strong>이전 → 현재 → 의미</strong>를 읽고, 파일 버튼으로 실제 diff를 확인하세요. 식별자와 코드는 원문 그대로입니다.',
        'search_label': '설명 검색',
        'search_placeholder': '예: 파일 이름, 식별자, 판정',
        'change_count': '{n} / {total}개 항목',
        'changes_note': '논리적 변경 하나당 카드 하나이며, 파일이나 주제별로 묶었습니다. 카드의 파일 버튼은 해당 파일의 실제 diff를 엽니다.',
        'changes_note_followup': '리뷰 이후 수정 카드는 맨 아래에 따로 모았습니다.',
        'no_matches': '검색 조건에 맞는 설명이 없습니다.',
        'reset_search': '검색 초기화',
        'before': '이전',
        'after': '현재',
        'after_followup': '현재 · 리뷰 이후 수정',
        'meaning': '의미',
        'followup_tag': '리뷰 이후 수정',
        'followup_heading': '리뷰 이후 수정',
        'evidence_basis': '근거: {ref}',
        'evidence_title': '근거 · {ref}',
        'verdicts': {'keep': '✅ 유지', 'cut': '✂️ 제거', 'trim': '🔻 축소', 'ask': '❓ 확인'},
        'whole_range': '전체 범위의 변경',
        'diff_basis': '{before} → {after} · {n}파일 · +{added} / −{removed}',
        'download_patch': '전체 비교 patch ↓',
        'version_note': '파일 버튼을 누르면 실제 unified diff가 열립니다. 새 파일은 전체 추가로 표시합니다.',
        'version_note_links': '줄 번호는 해당 커밋의 소스로 연결됩니다.',
        'file_search_label': '파일·설명·코드 검색',
        'file_search_placeholder': '예: 파일 이름, 함수 이름',
        'kind_label': '종류',
        'kind_all': '전체',
        'kinds': {'code': '코드', 'test': '테스트', 'config': '설정', 'docs': '문서'},
        'file_count': '{n} / {total} 파일 표시',
        'file_group': '변경 파일',
        'file_empty': '현재 조건에 맞는 파일이 없습니다.',
        'diff_placeholder': '{n}개 파일 중 확인할 파일을 선택하세요. 설명 카드의 파일 버튼에서도 바로 열 수 있습니다.',
        'wrap': '줄바꿈',
        'file_region': '선택 파일의 실제 코드 diff',
        'file_stat': '+{added} / −{removed} · 전체 범위',
        'new_file': '이전 커밋에 없던 새 파일 · 전체 추가',
        'deleted_file': '이 범위에서 삭제된 파일',
        'old_source': '이전 소스 {ref}',
        'new_source': '현재 소스 {ref}',
        'line_old': '이전 {n}번째 줄',
        'line_new': '현재 {n}번째 줄',
        'question_label': '❓ 리뷰어에게 남은 한 가지 결정',
        'glossary_summary': '용어 · 이 페이지를 읽는 데 필요한 뜻',
        'map_heading': '변경 지도',
        'map_col_section': '읽을 범위',
        'map_col_content': '확인할 내용',
        'map_changes': '{n}개 변경의 이전 / 현재 / 의미 카드',
        'map_code': '{n}개 파일의 실제 unified diff와 줄 번호',
        'quick_text': '<strong>카드를 먼저 읽으세요.</strong><br>✅가 아닌 판정부터 확인하면 승인 결정이 빨라집니다.',
        'quick_changes': '{n}개 변경 읽기',
        'quick_first_ask': '첫 번째 ❓ 변경으로',
        'quick_followup': '리뷰 이후 수정부터 읽기',
        'quick_code': '파일별 diff',
        'basis_text': '전체 diff는 {before} → {after}입니다. ✅는 변경의 필요성에 관한 판정이며 동작이 완벽하다는 보증은 아닙니다.',
        'timeline_base': '기준',
        'stat_changes': '논리적 변경',
        'stat_changes_followup': '리뷰 이후 수정 {n}개 포함',
        'stat_verdicts': '판정',
        'stat_verdicts_sub': '유지 · 제거 · 축소 · 확인',
        'stat_files': '변경 파일',
        'eyebrow_default': 'REVIEWED CHANGES',
        'footer_range': '고정된 비교: {before} → {after} · {generated} 생성 · 원격 저장소의 실시간 상태를 조회한 결과가 아닙니다.',
        'footer_diff': '원본 git diff에 이전·현재 줄 번호를 붙였습니다. 이 페이지는 저장소를 수정하지 않았습니다.',
        'noscript': '범위 전환과 검색에는 JavaScript가 필요합니다.',
        'scroll_hint': '표를 좌우로 밀어 전체 내용을 읽을 수 있습니다',
    },
    'en': {
        'skip': 'Skip to content',
        'nav': 'Sections',
        'rail_suffix': 'EXPLAIN DIFF',
        'compare_base': 'Compare base',
        'commits_n': '{n} commits',
        'files_n': '{n} files',
        'remote_compare': 'Compare on remote ↗',
        'overview_nav': 'Start here',
        'changes_nav': 'What changed and why',
        'code_nav': 'Diff by file',
        'reading_guide': 'Read <strong>before → after → meaning</strong> first, then open the real diff from the file buttons. Identifiers and code are quoted as they are.',
        'search_label': 'Search changes',
        'search_placeholder': 'e.g. a file name, an identifier, a verdict',
        'change_count': '{n} of {total} changes',
        'changes_note': 'One card per logical change, grouped by file or topic. The file buttons on a card open that file’s real diff.',
        'changes_note_followup': 'Cards for changes made after the review are collected at the bottom.',
        'no_matches': 'No change matches this search.',
        'reset_search': 'Clear search',
        'before': 'Before',
        'after': 'After',
        'after_followup': 'After · changed after review',
        'meaning': 'Meaning',
        'followup_tag': 'Changed after review',
        'followup_heading': 'Changed after the review',
        'evidence_basis': 'Evidence at {ref}',
        'evidence_title': 'Evidence · {ref}',
        'verdicts': {'keep': '✅ keep', 'cut': '✂️ cut', 'trim': '🔻 trim', 'ask': '❓ ask'},
        'whole_range': 'Whole range',
        'diff_basis': '{before} → {after} · {n} files · +{added} / −{removed}',
        'download_patch': 'Full patch ↓',
        'version_note': 'A file button opens the real unified diff. A new file shows as all added lines.',
        'version_note_links': 'Line numbers link to the source at that commit.',
        'file_search_label': 'Search files, notes and code',
        'file_search_placeholder': 'e.g. a path or a function name',
        'kind_label': 'Kind',
        'kind_all': 'All',
        'kinds': {'code': 'Code', 'test': 'Tests', 'config': 'Config', 'docs': 'Docs'},
        'file_count': 'Showing {n} of {total} files',
        'file_group': 'Changed files',
        'file_empty': 'No file matches the current filter.',
        'diff_placeholder': 'Pick one of the {n} files. The file buttons on the change cards open them too.',
        'wrap': 'Wrap lines',
        'file_region': 'Diff of the selected file',
        'file_stat': '+{added} / −{removed} · whole range',
        'new_file': 'New file, not in the base · all lines added',
        'deleted_file': 'File deleted in this range',
        'old_source': 'Before at {ref}',
        'new_source': 'After at {ref}',
        'line_old': 'before, line {n}',
        'line_new': 'after, line {n}',
        'question_label': '❓ One decision left for the reviewer',
        'glossary_summary': 'Glossary · terms this page relies on',
        'map_heading': 'Map of this page',
        'map_col_section': 'Section',
        'map_col_content': 'What is there',
        'map_changes': 'Before / after / meaning cards for {n} changes',
        'map_code': 'Real unified diff with line numbers for {n} files',
        'quick_text': '<strong>Read the cards first.</strong><br>Start with anything not marked ✅; that is where the approval decision sits.',
        'quick_changes': 'Read the {n} changes',
        'quick_first_ask': 'Jump to the first ❓',
        'quick_followup': 'Start with the changes made after review',
        'quick_code': 'Diff by file',
        'basis_text': 'The whole diff is {before} → {after}. ✅ judges whether a change needed to exist; it does not certify that the code is correct.',
        'timeline_base': 'base',
        'stat_changes': 'logical changes',
        'stat_changes_followup': 'includes {n} changed after review',
        'stat_verdicts': 'verdicts',
        'stat_verdicts_sub': 'keep · cut · trim · ask',
        'stat_files': 'files changed',
        'eyebrow_default': 'REVIEWED CHANGES',
        'footer_range': 'Fixed comparison: {before} → {after} · generated {generated} · not a live read of the remote.',
        'footer_diff': 'Before and after line numbers are added to the original git diff. This page changed nothing in the repository.',
        'noscript': 'Switching sections and searching need JavaScript.',
        'scroll_hint': 'Swipe the table sideways to read all of it',
    },
}
assert LABELS['ko'].keys() == LABELS['en'].keys()

TOP_REQUIRED = {'repo', 'before', 'after', 'title', 'changes'}
TOP_OPTIONAL = {'subtitle', 'lang', 'brand', 'eyebrow', 'ticket', 'remote_url', 'glossary', 'sections', 'question', 'stats'}
CHANGE_REQUIRED = {'id', 'group', 'title', 'verdict', 'before', 'after', 'why', 'files'}
CHANGE_OPTIONAL = {'evidence', 'followup'}
VERDICTS = ('keep', 'cut', 'trim', 'ask')
RESERVED_SECTIONS = {'overview', 'changes', 'code'}
EVIDENCE_RE = re.compile(r'([^\s:`]+):(\d+)(?:-(\d+))?')
# Inside prose, only a backticked token that looks like a path (has / or .) becomes a link.
INLINE_EVIDENCE_RE = re.compile(r'([^\s:`]*[/.][^\s:`]*):(\d+)(?:-(\d+))?')


def fail(message):
    print('build_review_page: ERROR: ' + message, file=sys.stderr)
    sys.exit(1)


def check_fields(obj, required, optional, where):
    if not isinstance(obj, dict):
        fail(f'{where} must be an object')
    unknown = sorted(set(obj) - required - optional)
    if unknown:
        fail(f'unknown field(s) in {where}: {", ".join(unknown)} (allowed: {", ".join(sorted(required | optional))})')
    missing = sorted(required - set(obj))
    if missing:
        fail(f'missing required field(s) in {where}: {", ".join(missing)}')


# ---- git (read-only: diff, log, rev-parse, show) ----

def git(repo, *args):
    assert args[0] in ('diff', 'log', 'rev-parse', 'show'), args[0]
    try:
        return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as err:
        fail(f'git {" ".join(args)} failed: {err.stderr.strip()}')


def kind(path):
    name = path.rsplit('/', 1)[-1]
    if re.search(r'(\.test\.|\.spec\.|_test\.|(^|/)__tests__/|(^|/)tests?/)', path) or name.startswith('test_'):
        return 'test'
    if re.search(r'\.(md|mdx|rst|txt|adoc)$', name) or path.startswith('docs/'):
        return 'docs'
    if (re.search(r'\.(json|ya?ml|toml|ini|cfg|conf|lock|env)$', name) or name.startswith('.')
            or path.startswith('.github/') or name in ('Dockerfile', 'Makefile')):
        return 'config'
    return 'code'


def count(patch):
    lines = patch.splitlines()
    added = sum(line.startswith('+') and not line.startswith('+++') for line in lines)
    removed = sum(line.startswith('-') and not line.startswith('---') for line in lines)
    return added, removed


# ---- markdown ----

class Renderer:
    def __init__(self, remote_url, ref, labels):
        self.remote_url, self.ref, self.labels = remote_url, ref, labels

    def evidence(self, label, pattern=EVIDENCE_RE):
        match = pattern.fullmatch(label)
        code = '<code>' + html.escape(label) + '</code>'
        if not match or not self.remote_url:
            return code
        path, start, end = match.groups()
        href = self.remote_url + '/blob/' + self.ref + '/' + quote(path, safe='/') + '#L' + start + ('-L' + end if end else '')
        title = self.labels['evidence_title'].format(ref=self.ref[:7])
        return f'<a class="evidence" href="{html.escape(href)}" target="_blank" rel="noopener" title="{html.escape(title)}">{code}</a>'

    def inline(self, s):
        tokens = []

        def hold(value):
            tokens.append(value)
            return '\x00' + str(len(tokens) - 1) + '\x00'
        s = re.sub(r'`([^`]+)`', lambda m: hold(self.evidence(m.group(1), INLINE_EVIDENCE_RE)), s)
        s = re.sub(r'\[([^\]]+)\]\((https?://[^)\s]+)\)',
                   lambda m: hold('<a href="' + html.escape(m[2], quote=True) + '" target="_blank" rel="noopener">' + html.escape(m[1]) + '</a>'), s)
        s = html.escape(s)
        s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
        return re.sub(r'\x00(\d+)\x00', lambda m: tokens[int(m[1])], s)

    @staticmethod
    def cells(line):
        body = line.strip()
        body = body[1:] if body.startswith('|') else body
        body = body[:-1] if body.endswith('|') and not body.endswith('\\|') else body
        return [c.strip().replace('\\|', '|') for c in re.split(r'(?<!\\)\|', body)]

    def markdown(self, src):
        lines = src.splitlines()
        out = []
        i = 0
        item = re.compile(r'^\s*(?:\d+\.|[-*])\s+')
        block_start = ('|', '#', '```')
        while i < len(lines):
            line = lines[i]
            if not line.strip():
                i += 1
                continue
            if line.startswith('```'):
                code = []
                i += 1
                while i < len(lines) and not lines[i].startswith('```'):
                    code.append(lines[i])
                    i += 1
                out.append('<pre class="example-code">' + html.escape('\n'.join(code)) + '</pre>')
                i += 1
                continue
            if line.startswith('|'):
                table = []
                while i < len(lines) and lines[i].startswith('|'):
                    table.append(self.cells(lines[i]))
                    i += 1
                has_rule = len(table) > 1 and all(re.fullmatch(r':?-{2,}:?', c) for c in table[1])
                head, body = table[0], table[2:] if has_rule else table[1:]
                aria = html.escape(' · '.join(head).replace('`', ''), quote=True)
                out.append(f'<div class="paper matrix" tabindex="0" role="region" aria-label="{aria}"><table><thead><tr>'
                           + ''.join('<th scope="col">' + self.inline(c) + '</th>' for c in head) + '</tr></thead><tbody>')
                for row in body:
                    out.append('<tr>' + ''.join('<td>' + self.inline(c) + '</td>' for c in row) + '</tr>')
                out.append('</tbody></table></div>')
                continue
            heading = re.match(r'^(#{2,3}) (.*)', line)
            if heading:
                tag = 'h3' if len(heading[1]) == 2 else 'h4'
                out.append(f'<{tag}>' + self.inline(heading[2]) + f'</{tag}>')
                i += 1
                continue
            if item.match(line):
                ordered = bool(re.match(r'^\s*\d+\.', line))
                tag = 'ol' if ordered else 'ul'
                items = []
                while i < len(lines) and item.match(lines[i]):
                    items.append('<li>' + self.inline(item.sub('', lines[i], count=1)) + '</li>')
                    i += 1
                out.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
                continue
            para = [line]
            i += 1
            while (i < len(lines) and lines[i].strip() and not lines[i].startswith(block_start)
                   and not item.match(lines[i])):
                para.append(lines[i])
                i += 1
            out.append('<p>' + self.inline(' '.join(para)) + '</p>')
        return '\n'.join(out)


def main():
    if len(sys.argv) != 3:
        fail('usage: python3 build_review_page.py <notes.json> <out.html>')
    notes_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        notes = json.loads(notes_path.read_text())
    except (OSError, json.JSONDecodeError) as err:
        fail(f'cannot read notes JSON {notes_path}: {err}')

    check_fields(notes, TOP_REQUIRED, TOP_OPTIONAL, 'notes')
    lang = notes.get('lang', 'en')
    if lang not in LABELS:
        fail(f'lang must be one of {", ".join(LABELS)}, got {lang!r}')
    L = LABELS[lang]
    repo = notes['repo']
    if not Path(repo).is_absolute():
        fail(f'repo must be an absolute path, got {repo!r}')
    remote_url = (notes.get('remote_url') or '').rstrip('/') or None
    if remote_url and not re.match(r'https?://', remote_url):
        fail(f'remote_url must start with http:// or https://, got {remote_url!r}')

    before_sha = git(repo, 'rev-parse', '--verify', notes['before'] + '^{commit}').strip()
    after_sha = git(repo, 'rev-parse', '--verify', notes['after'] + '^{commit}').strip()
    before, after = before_sha[:7], after_sha[:7]
    rng = f'{before_sha}..{after_sha}'

    # ---- the diff, read by this script ----
    stat = git(repo, 'diff', '--no-ext-diff', '--no-renames', '--stat', rng)
    paths = git(repo, 'diff', '--no-ext-diff', '--no-renames', '--name-only', rng).splitlines()
    if not paths:
        fail(f'the range {notes["before"]}..{notes["after"]} has no changes')
    commits = git(repo, 'log', '--reverse', '--format=%h%x09%s', rng).splitlines()
    delta = []
    for path in paths:
        patch = git(repo, 'diff', '--no-ext-diff', '--no-color', '--no-renames', rng, '--', path)
        if patch.count('\ndiff --git ') + patch.startswith('diff --git ') != 1:
            fail(f'expected exactly one file patch for {path}')
        added, removed = count(patch)
        delta.append(dict(path=path, added=added, removed=removed, kind=kind(path), patch=patch))
    full = git(repo, 'diff', '--no-ext-diff', '--no-color', '--no-renames', rng)
    if ''.join(f['patch'] for f in delta) != full:
        fail('per-file patches do not add up to the full diff')
    in_diff = set(paths)

    # ---- changes ----
    changes = notes['changes']
    if not isinstance(changes, list) or not changes:
        fail('changes must be a non-empty list')
    render = Renderer(remote_url, after_sha, L)
    seen = set()
    cards = []
    for n, c in enumerate(changes):
        where = f'changes[{n}]' + (f' (id {c.get("id")!r})' if isinstance(c, dict) and 'id' in c else '')
        check_fields(c, CHANGE_REQUIRED, CHANGE_OPTIONAL, where)
        for key in ('id', 'group', 'title', 'before', 'after', 'why'):
            if not isinstance(c[key], str) or not c[key].strip():
                fail(f'{where}.{key} must be a non-empty string')
        if c['id'] in seen:
            fail(f'duplicate change id {c["id"]!r}')
        seen.add(c['id'])
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', c['id']):
            fail(f'{where}.id may only contain letters, digits, _ . -')
        if c['verdict'] not in VERDICTS:
            fail(f'{where}.verdict must be one of {", ".join(VERDICTS)}, got {c["verdict"]!r}')
        if not isinstance(c['files'], list) or not c['files']:
            fail(f'{where}.files must be a non-empty list of paths')
        for path in c['files']:
            if path not in in_diff:
                fail(f'{where}.files path is not in the diff {notes["before"]}..{notes["after"]}: {path!r}')
        evidence = c.get('evidence', [])
        if not isinstance(evidence, list):
            fail(f'{where}.evidence must be a list')
        for label in evidence:
            if not isinstance(label, str) or not EVIDENCE_RE.fullmatch(label):
                fail(f'{where}.evidence entry is not "path:line" or "path:start-end": {label!r}')
        followup = c.get('followup', False)
        if not isinstance(followup, bool):
            fail(f'{where}.followup must be true or false')
        cards.append(dict(
            id=c['id'], group=c['group'], title=c['title'], verdict=c['verdict'], files=c['files'], followup=followup,
            before_html=render.inline(c['before']), after_html=render.inline(c['after']), why_html=render.inline(c['why']),
            evidence_html=[render.evidence(label).replace('</code></a>', '</code> ↗</a>') for label in evidence],
            search=' '.join([c['id'], c['group'], c['title'], L['verdicts'][c['verdict']], c['before'], c['after'], c['why'],
                             *c['files'], *evidence, L['followup_tag'] if followup else '']),
        ))
    # Follow-up cards sit at the bottom under their own heading; order is otherwise the caller's.
    cards = [c for c in cards if not c['followup']] + [c for c in cards if c['followup']]
    for f in delta:
        f['explanation'] = ' / '.join(c['title'] for c in cards if f['path'] in c['files'])

    # ---- prose sections ----
    prose = notes.get('sections', [])
    if not isinstance(prose, list):
        fail('sections must be a list')
    sections = {'overview': {'nav': L['overview_nav']}, 'changes': {'nav': L['changes_nav'], 'number': '01'},
                'code': {'nav': L['code_nav'], 'number': '02'}}
    prose_html = []
    for n, s in enumerate(prose):
        check_fields(s, {'id', 'heading', 'markdown'}, set(), f'sections[{n}]')
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', s['id']):
            fail(f'sections[{n}].id must be lowercase letters, digits and -: {s["id"]!r}')
        if s['id'] in sections or s['id'] in RESERVED_SECTIONS:
            fail(f'sections[{n}].id {s["id"]!r} is reserved or duplicated')
        number = f'{n + 3:02d}'
        sections[s['id']] = {'nav': s['heading'], 'number': number}
        prose_html.append(f'<section class="section prose" id="{s["id"]}-section"><div class="section-head"><span class="section-number">{number}</span>'
                          f'<h2>{html.escape(s["heading"])}</h2></div>{render.markdown(s["markdown"])}</section>')

    # ---- overview ----
    counts = {v: sum(c['verdict'] == v for c in cards) for v in VERDICTS}
    followups = sum(c['followup'] for c in cards)
    total_added, total_removed = sum(f['added'] for f in delta), sum(f['removed'] for f in delta)
    stats = notes.get('stats')
    if stats is None:
        stats = [
            {'value': str(len(cards)), 'label': L['stat_changes'],
             'sub': L['stat_changes_followup'].format(n=followups) if followups else ''},
            {'value': ' · '.join(L['verdicts'][v].split(' ')[0] + ' ' + str(counts[v]) for v in VERDICTS),
             'label': L['stat_verdicts'], 'sub': L['stat_verdicts_sub']},
            {'value': str(len(delta)), 'label': L['stat_files'], 'sub': f'+{total_added} / −{total_removed}'},
        ]
    else:
        if not isinstance(stats, list):
            fail('stats must be a list')
        for n, s in enumerate(stats):
            check_fields(s, {'label', 'value'}, {'sub'}, f'stats[{n}]')
    stat_html = '<div class="headline-stats">' + ''.join(
        f'<div class="headline-stat"><strong>{html.escape(str(s["value"]))}</strong><span>{html.escape(s["label"])}</span>'
        + (f'<small>{html.escape(s["sub"])}</small>' if s.get('sub') else '') + '</div>' for s in stats) + '</div>'

    quick = [f'<button data-section="changes">{html.escape(L["quick_changes"].format(n=len(cards)))}</button>']
    first_ask = next((c for c in cards if c['verdict'] == 'ask'), None)
    if first_ask:
        quick.append(f'<button data-change="{html.escape(first_ask["id"])}">{html.escape(L["quick_first_ask"])}</button>')
    first_followup = next((c for c in cards if c['followup']), None)
    if first_followup:
        quick.append(f'<button data-change="{html.escape(first_followup["id"])}">{html.escape(L["quick_followup"])}</button>')
    quick.append(f'<button data-section="code">{html.escape(L["quick_code"])}</button>')
    overview = stat_html + f'<div class="quick-guide"><p>{L["quick_text"]}</p><div class="quick-links">{"".join(quick)}</div></div>'

    timeline = [f'<div><b>{before} · {html.escape(L["timeline_base"])}</b>{html.escape(notes["before"])}</div>']
    for line in commits:
        sha, _, subject = line.partition('\t')
        timeline.append(f'<div><b>{html.escape(sha)}</b>{html.escape(subject)}</div>')
    overview += (f'<div class="basis"><strong>{html.escape(L["compare_base"])}</strong><br>'
                 f'{html.escape(L["basis_text"].format(before=before, after=after))}'
                 f'<div class="timeline-strip">{"".join(timeline)}</div></div>')

    def first_text(markdown_src):
        for para in re.split(r'\n\s*\n', markdown_src):
            para = para.strip()
            if para and not para.startswith(('|', '#', '```')):
                plain = re.sub(r'[`*]|\[([^\]]+)\]\([^)]+\)', lambda m: m.group(1) or '', ' '.join(para.split()))
                plain = re.sub(r'^(?:\d+\.|[-*])\s+', '', plain)
                return plain if len(plain) <= 140 else plain[:139].rstrip() + '…'
        return ''
    rows = [('changes', L['map_changes'].format(n=len(cards))), ('code', L['map_code'].format(n=len(delta)))]
    rows += [(s['id'], first_text(s['markdown'])) for s in prose]
    overview += (f'<div class="section"><h2>{html.escape(L["map_heading"])}</h2><div class="paper matrix"><table><thead><tr>'
                 f'<th>{html.escape(L["map_col_section"])}</th><th>{html.escape(L["map_col_content"])}</th></tr></thead><tbody>')
    for key, desc in rows:
        overview += (f'<tr><td><button data-section="{key}">{sections[key]["number"]} {html.escape(sections[key]["nav"])}</button></td>'
                     f'<td>{html.escape(desc)}</td></tr>')
    overview += '</tbody></table></div></div>'
    if notes.get('glossary'):
        overview += (f'<details class="paper glossary" open><summary>{html.escape(L["glossary_summary"])}</summary>'
                     f'<div class="prose">{render.markdown(notes["glossary"])}</div></details>')

    # ---- head, rail, footer ----
    ticket = notes.get('ticket')
    pills = (f'<span class="pill green">{html.escape(ticket)}</span>' if ticket else '') + \
        f'<span class="pill">{before} → {after} · {html.escape(L["commits_n"].format(n=len(commits)))}</span>'
    intro = (f'<div class="tag-line">{pills}</div><h1 id="review-title">{html.escape(notes["title"])}</h1>'
             + (f'<p class="intro-copy">{render.inline(notes["subtitle"])}</p>' if notes.get('subtitle') else '')
             + f'<p class="commit-meta">{" → ".join([before] + [line.split(chr(9))[0] for line in commits])} · '
             f'{html.escape(L["files_n"].format(n=len(delta)))}</p>')
    compare_url = f'{remote_url}/compare/{before_sha}...{after_sha}' if remote_url else None
    remote_link = (f'<a href="{html.escape(compare_url)}" target="_blank" rel="noopener">{html.escape(L["remote_compare"])}</a>'
                   if compare_url else '')
    brand = notes.get('brand') or 'Review'
    now = datetime.now(timezone.utc)
    eyebrow = notes.get('eyebrow') or f'{now.strftime("%B").upper()} {now.day}, {now.year} · {L["eyebrow_default"]}'
    rail_bottom = (f'<p>{html.escape(L["compare_base"])}<br><b>{before} → {after}</b><br>'
                   f'{html.escape(L["commits_n"].format(n=len(commits)))} · {html.escape(L["files_n"].format(n=len(delta)))}</p>' + remote_link)
    question = ''
    if notes.get('question'):
        question = (f'<div class="core-question" id="reviewer-question"><span>{html.escape(L["question_label"])}</span>'
                    f'<strong>{render.inline(notes["question"])}</strong></div>')
    footer = (f'<p>{html.escape(L["footer_range"].format(before=before, after=after, generated=now.strftime("%Y-%m-%d %H:%M UTC")))}</p>'
              f'<p>{html.escape(L["footer_diff"])}</p>')
    changes_note = L['changes_note'] + (' ' + L['changes_note_followup'] if followups else '')
    kind_options = f'<option value="all">{html.escape(L["kind_all"])}</option>' + ''.join(
        f'<option value="{k}">{html.escape(v)}</option>' for k, v in L['kinds'].items())

    order = list(sections)
    data = dict(lang=lang, before=before, after=after, before_sha=before_sha, after_sha=after_sha, remote_url=remote_url,
                labels={k: L[k] for k in ('change_count', 'followup_heading', 'followup_tag', 'verdicts', 'before', 'after',
                                          'after_followup', 'meaning', 'evidence_basis', 'no_matches', 'reset_search',
                                          'diff_basis', 'version_note', 'version_note_links', 'file_count', 'kinds',
                                          'file_stat', 'new_file', 'deleted_file', 'old_source', 'new_source',
                                          'line_old', 'line_new')},
                sections=sections, order=order, changes=cards, delta=delta)

    css = ((HERE / 'base.css').read_text() + '\n' + (HERE / 'review.css').read_text()
           + '\n:root{--scroll-hint:' + json.dumps(L['scroll_hint'], ensure_ascii=False) + '}')
    esc = html.escape
    title = (ticket + ' · ' if ticket else '') + notes['title']
    values = {
        '@@LANG@@': lang, '@@PAGE_TITLE@@': esc(title), '@@CSS@@': css,
        '@@L_SKIP@@': esc(L['skip']), '@@MARK@@': esc(brand[0].upper()), '@@BRAND@@': esc(brand),
        '@@RAIL_LABEL@@': esc((ticket + ' · ' if ticket else '') + L['rail_suffix']), '@@L_NAV@@': esc(L['nav']),
        '@@RAIL_BOTTOM@@': rail_bottom, '@@EYEBROW@@': esc(eyebrow), '@@HEAD_LINK@@': remote_link,
        '@@L_READING_GUIDE@@': L['reading_guide'], '@@INTRO@@': intro, '@@OVERVIEW@@': overview,
        '@@L_CHANGES_NAV@@': esc(L['changes_nav']), '@@L_SEARCH_LABEL@@': esc(L['search_label']),
        '@@L_SEARCH_PLACEHOLDER@@': esc(L['search_placeholder']), '@@CHANGES_NOTE@@': esc(changes_note),
        '@@L_CODE_NAV@@': esc(L['code_nav']), '@@L_WHOLE_RANGE@@': esc(L['whole_range']),
        '@@PATCH_NAME@@': esc(f'{before}..{after}.patch'), '@@L_DOWNLOAD_PATCH@@': esc(L['download_patch']),
        '@@REMOTE_COMPARE@@': remote_link, '@@L_FILE_SEARCH_LABEL@@': esc(L['file_search_label']),
        '@@L_FILE_SEARCH_PLACEHOLDER@@': esc(L['file_search_placeholder']), '@@L_KIND_LABEL@@': esc(L['kind_label']),
        '@@KIND_OPTIONS@@': kind_options, '@@L_FILE_GROUP@@': esc(L['file_group']), '@@L_FILE_EMPTY@@': esc(L['file_empty']),
        '@@L_RESET_SEARCH@@': esc(L['reset_search']), '@@DIFF_PLACEHOLDER@@': esc(L['diff_placeholder'].format(n=len(delta))),
        '@@L_WRAP@@': esc(L['wrap']), '@@L_FILE_REGION@@': esc(L['file_region']), '@@PROSE@@': ''.join(prose_html),
        '@@QUESTION@@': question, '@@FOOTER@@': footer, '@@L_NOSCRIPT@@': esc(L['noscript']),
        '@@DATA@@': json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'),
        '@@JS@@': (HERE / 'review.js').read_text(),
    }
    template = (HERE / 'template.html').read_text()
    found = set(re.findall(r'@@[A-Z_]+@@', template))
    if found - set(values):
        fail(f'template placeholder(s) with no value: {", ".join(sorted(found - set(values)))}')
    if set(values) - found:
        fail(f'template is missing placeholder(s): {", ".join(sorted(set(values) - found))}')
    # One pass, so text inside the notes is never read as a placeholder.
    page = re.sub(r'@@[A-Z_]+@@', lambda m: values[m.group(0)], template)

    out_path.write_text(page)
    size = len(page.encode())
    print(f'build_review_page: wrote {out_path}')
    print(f'  range   {notes["before"]}..{notes["after"]} ({before}..{after}), {len(commits)} commits')
    print(f'  files   {len(delta)} (+{total_added} −{total_removed}); git --stat: {stat.strip().splitlines()[-1].strip()}')
    print(f'  changes {len(cards)} (keep {counts["keep"]}, cut {counts["cut"]}, trim {counts["trim"]}, ask {counts["ask"]}; followup {followups})')
    print(f'  sections {len(prose)} prose, glossary {"yes" if notes.get("glossary") else "no"}, question {"yes" if question else "no"}')
    print(f'  bytes   {size}')


if __name__ == '__main__':
    main()
