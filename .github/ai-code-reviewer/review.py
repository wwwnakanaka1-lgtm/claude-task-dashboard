#!/usr/bin/env python3
"""
自動コードレビューボット
GitHub PRの差分をGroq API（Llama）でレビューし、結果をPRコメントとして投稿する
"""

import os
import sys
import json
import subprocess
from groq import Groq


def get_pr_number() -> str:
    """GitHub Actions環境からPR番号を取得する"""
    # GITHUB_EVENT_PATHからPR番号を取得
    event_path = os.environ.get('GITHUB_EVENT_PATH')
    if event_path and os.path.exists(event_path):
        with open(event_path, 'r') as f:
            event = json.load(f)
            if 'pull_request' in event:
                return str(event['pull_request']['number'])
            if 'number' in event:
                return str(event['number'])

    # GITHUB_REFから取得を試みる (refs/pull/123/merge)
    ref = os.environ.get('GITHUB_REF', '')
    if '/pull/' in ref:
        parts = ref.split('/')
        for i, part in enumerate(parts):
            if part == 'pull' and i + 1 < len(parts):
                return parts[i + 1]

    raise ValueError("PR番号を取得できませんでした")

# レビュー対象のファイル拡張子
CODE_EXTENSIONS = {
    '.py', '.js', '.ts', '.tsx', '.jsx',
    '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.h', '.hpp',
    '.rb', '.php', '.swift',
    '.cs', '.scala', '.clj',
    '.sh', '.bash', '.zsh',
}

# 除外するパス（部分一致）
EXCLUDED_PATHS = [
    'node_modules/',
    'vendor/',
    '__pycache__/',
    '.git/',
    'dist/',
    'build/',
    '.next/',
]

REVIEW_PROMPT = """あなたは経験豊富なシニアソフトウェアエンジニアです。
以下のコード変更をレビューしてください。

## レビュー観点
1. **バグの可能性**: ロジックエラー、エッジケースの見落とし、null/undefined問題
2. **セキュリティ問題**: インジェクション、認証・認可の問題、機密情報の露出
3. **パフォーマンス問題**: N+1クエリ、不要なループ、メモリリーク
4. **コードスタイル/可読性**: 命名、複雑さ、コードの重複
5. **ベストプラクティス**: 言語固有のイディオム、設計パターン

## 出力形式
以下のMarkdown形式で出力してください:

### 🔍 レビューサマリー
（全体的な評価を1-2文で）

### 🚨 重要な問題
（もしあれば、修正が必要な問題をリストアップ）

### 💡 改善提案
（もしあれば、より良くするための提案をリストアップ）

### ✅ 良い点
（もしあれば、良い実装をリストアップ）

問題がない場合は「特に問題は見つかりませんでした」と記載してください。
建設的で具体的なフィードバックを心がけてください。

---

## コード変更（diff）:
"""


def get_repo() -> str:
    """リポジトリ名を取得する (owner/repo形式)"""
    return os.environ.get('GITHUB_REPOSITORY', '')


def get_pr_diff(pr_number: str) -> str:
    """PRの差分を取得する"""
    repo = get_repo()

    # まずgh pr diffを試す
    cmd = ['gh', 'pr', 'diff', pr_number]
    if repo:
        cmd.extend(['--repo', repo])

    print(f"   実行コマンド: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode == 0:
        return result.stdout

    # 差分が大きすぎる場合はgit diffを使用
    if 'too_large' in result.stderr or '406' in result.stderr:
        print("   ⚠️ PRが大きすぎるためgit diffを使用します")

        # PRのベースブランチを取得
        pr_info_cmd = ['gh', 'pr', 'view', pr_number, '--json', 'baseRefName,headRefName']
        if repo:
            pr_info_cmd.extend(['--repo', repo])

        pr_info_result = subprocess.run(pr_info_cmd, capture_output=True, text=True, check=True)
        pr_info = json.loads(pr_info_result.stdout)
        base = pr_info['baseRefName']
        head = pr_info['headRefName']

        # git diffで差分を取得
        diff_cmd = ['git', 'diff', f'origin/{base}...origin/{head}']
        print(f"   実行コマンド: {' '.join(diff_cmd)}")
        diff_result = subprocess.run(diff_cmd, capture_output=True, text=True, check=True)
        return diff_result.stdout

    print(f"   stderr: {result.stderr}")
    raise subprocess.CalledProcessError(result.returncode, cmd)


def filter_diff(diff: str) -> str:
    """コードファイルのみをフィルタリングする"""
    filtered_lines = []
    include_file = False

    for line in diff.split('\n'):
        # 新しいファイルの開始を検出
        if line.startswith('diff --git'):
            # ファイルパスを抽出 (例: diff --git a/path/to/file.py b/path/to/file.py)
            parts = line.split(' ')
            if len(parts) >= 4:
                file_path = parts[2][2:]  # 'a/' を除去

                # 除外パスのチェック
                is_excluded = any(excluded in file_path for excluded in EXCLUDED_PATHS)

                # 拡張子のチェック
                _, ext = os.path.splitext(file_path)
                is_code = ext.lower() in CODE_EXTENSIONS

                include_file = is_code and not is_excluded

        if include_file:
            filtered_lines.append(line)

    return '\n'.join(filtered_lines)


def review_code(diff: str) -> str:
    """Groq API（Llama）でコードをレビューする"""
    api_key = os.environ.get('GROQ_API_KEY')
    if not api_key:
        raise ValueError("GROQ_API_KEY environment variable is not set")

    client = Groq(api_key=api_key)

    # 差分が大きすぎる場合は警告（Llamaのコンテキスト制限を考慮）
    if len(diff) > 30000:
        diff = diff[:30000] + "\n\n... (差分が大きいため一部省略されました)"

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {
                "role": "user",
                "content": REVIEW_PROMPT + diff
            }
        ],
        max_tokens=4096,
        temperature=0.3,
    )

    return response.choices[0].message.content


def post_comment(pr_number: str, review: str) -> None:
    """PRにコメントを投稿する"""
    comment = f"## 🤖 自動コードレビュー\n\n{review}\n\n---\n*このレビューはLlama 3.3（Groq）によって自動生成されました*"

    repo = get_repo()
    cmd = ['gh', 'pr', 'comment', pr_number, '--body', comment]
    if repo:
        cmd.extend(['--repo', repo])

    subprocess.run(cmd, check=True)


def main():
    print("🔢 PR番号を取得中...")
    pr_number = get_pr_number()
    print(f"   PR #{pr_number}")

    print("📥 PRの差分を取得中...")
    diff = get_pr_diff(pr_number)

    if not diff.strip():
        print("⚠️ 差分がありません")
        return

    print("🔍 コードファイルをフィルタリング中...")
    filtered_diff = filter_diff(diff)

    if not filtered_diff.strip():
        print("⚠️ レビュー対象のコードファイルがありません")
        return

    print(f"📝 フィルタ後の差分: {len(filtered_diff)} 文字")
    print("🤖 Groq API（Llama）でレビュー中...")
    review = review_code(filtered_diff)

    print("💬 PRにコメントを投稿中...")
    post_comment(pr_number, review)

    print("✅ レビュー完了!")


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as e:
        print(f"❌ コマンド実行エラー: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ エラー: {e}")
        sys.exit(1)
