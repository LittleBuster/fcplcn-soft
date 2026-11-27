"""Immutable, secret-free software snapshots and exact GitHub revisions."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile

from .common import DeploymentError

EXCLUDED_DIRECTORIES = {
    ".git", "node_modules", "dist", "runtime", ".venv", "venv", "data",
    "__pycache__", ".pytest_cache", "test-results", "playwright-report",
    "managed_components", ".build", ".artifacts", ".deployment-lock",
}


def github_repository(remote):
    """Accept GitHub remotes without embedded credentials or shell evaluation."""
    if not remote:
        return None
    match = re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?",
        remote,
    )
    if not match or any(value in (".", "..") for value in match.groups()):
        raise DeploymentError("Укажите GitHub URL без токенов: https://github.com/owner/repository.git.")
    return match.group(1).lower(), match.group(2)


def software_root(path):
    path = Path(path).resolve()
    for candidate in (path, path / "fcplcn-soft"):
        if (candidate / "config/product.json").is_file() and (candidate / "hub/deploy/compose.yaml").is_file():
            return candidate
    raise DeploymentError("В исходниках не найдены config/product.json и hub/deploy/compose.yaml.")


def safe_files(root):
    """Never follow symlinks, runtime directories or local environment files."""
    root = Path(root)
    for directory, names, files in os.walk(root, followlinks=False):
        names[:] = sorted(name for name in names if name not in EXCLUDED_DIRECTORIES
                          and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or name == ".DS_Store":
                continue
            if (name == ".env" or name.startswith(".env.")) and name != ".env.example":
                continue
            if name.endswith((".pyc", ".pyo")):
                continue
            yield path, path.relative_to(root)


def tree_digest(root):
    digest = hashlib.sha256()
    for path, relative in safe_files(root):
        digest.update(str(relative).encode("utf-8") + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def schema_digest(source, role):
    digest = hashlib.sha256()
    source = Path(source)
    if role == "cloud":
        paths = sorted((source / "cloud/server/migrations").glob("*.sql"))
    else:
        # The hub used files prior to this Compose startup script. New SQL migrations
        # extend the digest while older hub records keep the empty legacy digest.
        paths = sorted((source / "hub/server/migrations").glob("*.sql"))
        bootstrap = source / "hub/deploy/postgres-init.sh"
        if bootstrap.is_file():
            paths.insert(0, bootstrap)
    for path in paths:
        digest.update(path.name.encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def git_details(runner, root):
    commit = runner.run(["git", "-C", root, "rev-parse", "--verify", "HEAD"], check=False)
    sha = (commit.stdout or b"").decode().strip() if commit.returncode == 0 else None
    remote_result = runner.run(["git", "-C", root, "remote", "get-url", "origin"], check=False)
    remote = (remote_result.stdout or b"").decode().strip() if remote_result.returncode == 0 else None
    if sha:
        dirty = runner.output(["git", "-C", root, "status", "--porcelain", "--untracked-files=normal", "--", "."])
        if dirty:
            sha = None
    return sha, remote


def fetch_source(runner, remote, ref, destination):
    github_repository(remote)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,180}", ref) or ".." in ref or "//" in ref:
        raise DeploymentError("Некорректное имя Git ветки, тега или commit.")
    runner.run(["git", "clone", "--quiet", "--no-checkout", "--", remote, destination],
               label="Получение исходников GitHub")
    runner.run(["git", "-C", destination, "fetch", "--quiet", "--depth", "1", "origin", ref],
               label="Получение выбранной версии")
    sha = runner.output(["git", "-C", destination, "rev-parse", "--verify", "FETCH_HEAD"])
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise DeploymentError("Git не вернул точный commit исходников.")
    runner.run(["git", "-C", destination, "checkout", "--quiet", "--detach", sha],
               label="Подготовка выбранной версии")
    return software_root(destination), sha


def prepare_source(runner, state, checkout, *, role, repo=None, ref="main", fetch=False):
    """Make a content-addressed snapshot; never reset the user's checkout."""
    state = Path(state)
    temporary = Path(tempfile.mkdtemp(prefix=".prepare-", dir=state))
    try:
        if fetch:
            root, sha = fetch_source(runner, repo, ref, temporary / "checkout")
            remote = repo
        else:
            root = software_root(checkout)
            sha, discovered = git_details(runner, root)
            remote = repo or discovered
            if remote:
                github_repository(remote)
        content = tree_digest(root)
        revision = sha or ("local-" + content[:24])
        release = state / "releases" / revision
        if not release.exists():
            snapshot = temporary / "release" / "source"
            snapshot.mkdir(parents=True)
            for path, relative in safe_files(root):
                target = snapshot / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
            release.parent.mkdir(parents=True, exist_ok=True)
            os.replace(snapshot.parent, release)
        elif tree_digest(release / "source") != content:
            raise DeploymentError("Существующий неизменяемый релиз был изменён. Сохраните его для проверки.")
        return {
            "revision": revision, "commit": sha, "content": content,
            "repo": remote, "ref": ref, "schema": schema_digest(release / "source", role),
        }
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def default_image(role, record, architecture):
    if architecture not in ("linux/amd64", "linux/arm64"):
        raise DeploymentError("FCPLCn поддерживает только 64-битные системы amd64 и arm64.")
    if record.get("repo") and record.get("commit"):
        owner, _ = github_repository(record["repo"])
        return f"ghcr.io/{owner}/fcplcn-{role}:sha-{record['commit']}"
    return f"fcplcn-{role}:local-{record['content'][:24]}"
