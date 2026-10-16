#!/bin/sh
# Install the udev rule (needs root) and the GNOME extension (current user).
set -e
cd "$(dirname "$0")"

UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' extension/metadata.json)
RULE=udev/70-thinkpad-presence.rules

echo "Installing udev rule (asks for your password)..."
pkexec sh -c "install -m 0644 '$PWD/$RULE' /etc/udev/rules.d/ && \
    udevadm control --reload && \
    udevadm trigger --action=add --sysname-match='HID-SENSOR-2000e1.*'"

echo "Installing extension $UUID..."
gnome-extensions pack --force --out-dir="${TMPDIR:-/tmp}" extension
gnome-extensions install --force "${TMPDIR:-/tmp}/$UUID.shell-extension.zip"

echo
echo "Done. Log out and back in, then run:  gnome-extensions enable $UUID"
