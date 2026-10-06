#!/bin/sh
# Builds 'Ash Log.app' (into scripts/desktop/build/) and installs it in
# ~/Applications, replacing an older copy. Run it with: npm run app:install
#
# The app remembers the project folder, the node that runs this script and the port
# (APP_PORT in .env), so run it again after changing any of those.
#
# Override: ASHENFALL_INSTALL_DIR (default ~/Applications).
set -eu

DESKTOP_DIR=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
PROJECT_DIR=$(CDPATH='' cd -- "$DESKTOP_DIR/../.." && pwd -P)
APP_NAME="Ash Log.app"
BUILT="$DESKTOP_DIR/build/$APP_NAME"
TARGET_DIR=${ASHENFALL_INSTALL_DIR:-"$HOME/Applications"}
TARGET="$TARGET_DIR/$APP_NAME"

NODE=$(command -v node) || {
  echo "Node niet gevonden in PATH. Draai dit via: npm run app:install" >&2
  exit 1
}

# The executable of this app (Contents/MacOS/AshLog), or of the older AppleScript version
# (Contents/MacOS/applet): replacing a running app breaks it.
if /usr/bin/pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  echo "Ash Log draait nog. Stop de app eerst (rechtsklik op het Dock-icoon, Stop) en probeer het opnieuw." >&2
  exit 1
fi

cd "$PROJECT_DIR"
"$NODE" --import tsx "$DESKTOP_DIR/build-app.ts"

/bin/mkdir -p "$TARGET_DIR"
/bin/rm -rf "$TARGET"
/usr/bin/ditto --noextattr --norsrc "$BUILT" "$TARGET"
# Sign again in place: the build folder may live in iCloud Drive (see build-app.ts).
/usr/bin/xattr -cr "$TARGET"
/usr/bin/codesign --force --deep --sign - "$TARGET"
/usr/bin/codesign --verify --deep --strict "$TARGET"

# Let Launchpad and Spotlight know about the (new) app.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$TARGET" || true
fi

echo "Geinstalleerd: $TARGET"
echo "Open de app via Spotlight of Launchpad, of sleep hem vanuit Finder naar je Dock."
