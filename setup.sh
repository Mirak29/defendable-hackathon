#!/usr/bin/env bash
# Rebuilds the whole app in ./app:
#   1. the pre-event extract, downloaded at its pinned commit (see README)
#   2. the hackathon work on top: patches/pre-event.patch, then the new files
# Needs git and bash (Git Bash on Windows). Run it again to start from scratch.
set -euo pipefail

PRE_EVENT_REPO="${PRE_EVENT_REPO:-https://github.com/Mirak29/defendable-pre-event.git}"
PRE_EVENT_COMMIT="${PRE_EVENT_COMMIT:-3593096b6113231bc4028b12d137ae3b07e82db2}"

cd "$(dirname "$0")"
rm -rf app

if [ -n "${PRE_EVENT_DIR:-}" ]; then
  # a local copy of the extract (used to check this script before publishing)
  cp -r "$PRE_EVENT_DIR" app
else
  # files exactly as stored: no line-ending conversion (Windows)
  git clone --quiet -c core.autocrlf=false "$PRE_EVENT_REPO" app
  git -C app checkout --quiet "$PRE_EVENT_COMMIT"
fi
rm -rf app/.git app/README.md

# the changes made during the event to the pre-event files
# applied from here, into app/: the same inside a clone of this repository or not
git -c core.autocrlf=false apply --binary --directory=app patches/pre-event.patch

# the files created during the event (this repository's own files stay out)
tar --exclude=./app --exclude=./patches --exclude=./setup.sh --exclude=./.git \
  --exclude=./.gitignore --exclude=./.gitattributes --exclude=./.github \
  -cf - . | tar -xf - -C app

echo "The app is ready in ./app: cd app && deno task dev (or docker compose up -d --build)"
