// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Zeng Huang

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const SYSFS_DIR = '/sys/bus/platform/devices';
const SENSOR_PREFIX = 'HID-SENSOR-2000e1.';
const SENSOR_NAME = 'Xethru Presence Sensor';

// Each sample read from /dev/HID-SENSOR-*: usage (u32), timestamp (u64),
// raw length (u32), then the raw report. Byte 26 of the report is the
// presence flag (0/1), bytes 27-30 the distance in mm.
const HEADER_LEN = 16;
const PRESENCE_OFFSET = 26;

// The radar sends about 4 samples a second, even when nothing changes, so
// a long silence means it stopped working.
const STALL_TIMEOUT = 10;
const WATCHDOG_INTERVAL = 5;

const IDLE_INHIBIT_FLAG = 8;

function callSessionManager(method, params, replyType, cancellable, callback) {
    Gio.DBus.session.call(
        'org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', method,
        params, replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE, -1, cancellable, callback);
}

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes).trim();
}

function writeText(path, text) {
    try {
        const stream = Gio.File.new_for_path(path).append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(text), null);
        stream.close(null);
    } catch {
        // The kernel returns EINVAL when the sensor is already in that state.
    }
}

function listDir(path) {
    const names = [];
    const enumerator = Gio.File.new_for_path(path).enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (const info of enumerator)
        names.push(info.get_name());
    return names;
}

// Sensor numbering can change between boots, so find it by its friendly name.
function findSensor() {
    for (const sensor of listDir(SYSFS_DIR).filter(n => n.startsWith(SENSOR_PREFIX))) {
        const dir = `${SYSFS_DIR}/${sensor}`;
        for (const feature of listDir(dir).filter(n => n.startsWith('feature-'))) {
            try {
                if (readText(`${dir}/${feature}/${feature}-name`) !== 'property-friendly-name')
                    continue;
                const codes = readText(`${dir}/${feature}/${feature}-value`)
                    .split(/\s+/).map(Number).filter(c => c > 0);
                if (String.fromCharCode(...codes).startsWith(SENSOR_NAME))
                    return sensor;
            } catch {
                // Unreadable feature, keep looking.
            }
        }
    }
    return null;
}

function isLidClosed() {
    try {
        return listDir('/proc/acpi/button/lid').some(lid =>
            readText(`/proc/acpi/button/lid/${lid}/state`).includes('closed'));
    } catch {
        return false;
    }
}

const TITLE = 'Presence Lock';
// The tile is too narrow for the full name.
const TILE_TITLE = 'Presence';

// Behavior options in the tile's menu, worded shorter than in Settings
// to fit.
const MENU_OPTIONS = [
    ['auto-lock', 'Lock when away'],
    ['lock-when-inhibited', 'Lock during playback'],
    ['stay-awake', 'Stay awake when present'],
];

// Quick Settings tile: click to switch the radar on or off (like Wi-Fi or
// Bluetooth), arrow for the on/off options (checkmarked like Power Mode)
// and Settings.
const PresenceToggle = GObject.registerClass(
class PresenceToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, settings) {
        super._init({title: TILE_TITLE, toggleMode: true});
        settings.bind('radar', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        for (const [key, label] of MENU_OPTIONS) {
            const item = this.menu.addAction(label,
                () => settings.set_boolean(key, !settings.get_boolean(key)));
            const sync = () => item.setOrnament(settings.get_boolean(key)
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            settings.connectObject(`changed::${key}`, sync, item);
            sync();
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => extension.openPreferences());
    }

    // Errors also go out as a notification; the subtitle just flags them.
    setStatus(gicon, status) {
        this.set({gicon, subtitle: status});
        this.menu.setHeader(gicon, TITLE, status ?? '');
    }
});

// The top bar icon, shown next to the system indicators (Wi-Fi, battery...).
const PresenceIndicator = GObject.registerClass(
class PresenceIndicator extends QuickSettings.SystemIndicator {
    _init(extension, settings) {
        super._init();
        this._icon = this._addIndicator();
        this.toggle = new PresenceToggle(extension, settings);
        this.quickSettingsItems.push(this.toggle);
    }

    setStatus(gicon, status, showIcon, showToggle) {
        this._icon.gicon = gicon;
        this._icon.visible = showIcon;
        this.toggle.setStatus(gicon, status);
        this.toggle.visible = showToggle;
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class PresenceLockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._error = null;
        this._present = null;
        const fileIcon = name => Gio.FileIcon.new(this.dir.get_child('icons').get_child(`${name}-symbolic.svg`));
        this._icons = {
            present: fileIcon('presence-present'),
            away: fileIcon('presence-away'),
            off: fileIcon('presence-off'),
            paused: Gio.ThemedIcon.new('changes-allow-symbolic'),
            error: Gio.ThemedIcon.new('dialog-warning-symbolic'),
        };

        const quickSettings = Main.panel.statusArea.quickSettings;
        this._indicator = new PresenceIndicator(this, this._settings);
        quickSettings.addExternalIndicator(this._indicator);
        this._settings.connectObject(
            'changed::show-indicator', () => this._updateStatus(),
            'changed::auto-lock', () => this._onAutoLockChanged(),
            'changed::stay-awake', () => this._updateStatus(),
            'changed::radar', () => this._onRadarChanged(),
            this);
        Main.sessionMode.connectObject('updated', () => this._updateStatus(), this);
        this._updateStatus();

        if (this._settings.get_boolean('radar'))
            this._startRadar();
    }

    // The extension keeps running on the lock screen ("unlock-dialog"
    // session mode) so it can wake the screen when you come back, and so
    // the radar is switched off when the extension is disabled there.
    disable() {
        this._stopRadar();
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._updateInhibit();
        this._indicator.destroy();
        this._indicator = null;
        this._notificationSource?.destroy();
        this._notificationSource = null;
        this._icons = null;
    }

    _onRadarChanged() {
        if (this._settings.get_boolean('radar'))
            this._startRadar();
        else
            this._stopRadar();
    }

    _startRadar() {
        this._sensor = findSensor();
        if (!this._sensor) {
            this._setError('No radar found', 'This laptop has no Xethru presence sensor.');
            return;
        }

        writeText(`${SYSFS_DIR}/${this._sensor}/enable_sensor`, '1');

        try {
            this._fileStream = Gio.File.new_for_path(`/dev/${this._sensor}`).read(null);
        } catch (e) {
            this._setError('Can’t read the radar', `Is the udev rule installed? ${e.message}`);
            return;
        }
        // Wrap the fd in a pollable stream so reads never block a thread
        // and cancel cleanly in _stopRadar().
        this._stream = GioUnix.InputStream.new(this._fileStream.get_fd(), false);
        this._cancellable = new Gio.Cancellable();
        this._readNext();

        this._lastSampleTime = GLib.get_monotonic_time();
        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCHDOG_INTERVAL, () => {
            if (GLib.get_monotonic_time() - this._lastSampleTime < STALL_TIMEOUT * 1e6)
                return GLib.SOURCE_CONTINUE;
            this._watchdogId = 0;
            this._setError('The radar stopped', 'It stopped sending data. Turn the radar off and on to retry.');
            return GLib.SOURCE_REMOVE;
        });
    }

    // Stops reading and switches the sensor off. With no presence known,
    // nothing is scheduled to lock and the idle inhibitor is released, so
    // GNOME's own blanking, locking and suspend take over.
    _closeRadar() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = 0;
        }
        this._cancelLock();
        this._stream = null;
        try {
            this._fileStream?.close(null);
        } catch {
            // The device may already be gone.
        }
        this._fileStream = null;
        if (this._sensor)
            writeText(`${SYSFS_DIR}/${this._sensor}/enable_sensor`, '0');
        this._sensor = null;
        this._present = null;
    }

    // Also clears any radar error, so turning the radar off and on retries.
    _stopRadar() {
        this._closeRadar();
        this._error = null;
        this._updateStatus();
    }

    // Radar errors stop it, falling back to GNOME's own behavior.
    _setError(summary, detail) {
        console.warn(`${this.metadata.name}: ${summary}. ${detail}`);
        this._closeRadar();
        this._error = summary;
        this._updateStatus();

        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: TITLE,
                iconName: 'dialog-warning-symbolic',
            });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }
        this._notificationSource.addNotification(new MessageTray.Notification({
            source: this._notificationSource,
            title: summary,
            body: detail,
            urgency: MessageTray.Urgency.HIGH,
        }));
    }

    _updateStatus() {
        const radar = this._settings.get_boolean('radar');
        let icon;
        if (this._error)
            icon = this._icons.error;
        else if (!radar)
            icon = this._icons.off;
        else if (!this._settings.get_boolean('auto-lock'))
            icon = this._icons.paused;
        else if (this._present === false)
            icon = this._icons.away;
        else
            icon = this._icons.present;

        // Errors show even when the icon is turned off, so they don't go
        // unnoticed. Nothing shows on the lock screen.
        const locked = Main.sessionMode.isLocked;
        const showIcon = !locked && (!!this._error || this._settings.get_boolean('show-indicator'));
        // No subtitle when off, like the built-in tiles. Kept short so it
        // fits the tile with larger fonts.
        let status = this._error;
        if (!status && radar)
            status = this._settings.get_boolean('auto-lock') ? 'Lock active' : 'Lock paused';
        this._indicator.setStatus(icon, status, showIcon, !locked);
        this._updateInhibit();
    }

    // With stay-awake on, hold an idle inhibitor while the radar sees you,
    // so the screen doesn't blank, lock or suspend on its own. It's
    // released as soon as you leave, before _maybeLock() checks for
    // inhibitors.
    _updateInhibit() {
        const want = !!this._settings && this._settings.get_boolean('stay-awake') &&
            this._present === true && !this._error && !Main.sessionMode.isLocked;

        if (want && !this._inhibitCookie && !this._inhibitPending) {
            // Not cancellable: the inhibitor would still be created, so
            // wait for the cookie and release it here instead.
            this._inhibitPending = true;
            callSessionManager('Inhibit',
                new GLib.Variant('(susu)', [this.uuid, 0, 'You’re at the computer', IDLE_INHIBIT_FLAG]),
                '(u)', null, (connection, result) => {
                    this._inhibitPending = false;
                    try {
                        [this._inhibitCookie] = connection.call_finish(result).deepUnpack();
                    } catch (e) {
                        console.warn(`${this.metadata.name}: Can’t inhibit idle. ${e.message}`);
                        return;
                    }
                    this._updateInhibit();
                });
        } else if (!want && this._inhibitCookie) {
            callSessionManager('Uninhibit', new GLib.Variant('(u)', [this._inhibitCookie]), null, null, null);
            this._inhibitCookie = 0;
        }
    }

    _readNext() {
        this._stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._setError('Lost the radar', `${e.message}. Turn the radar off and on to retry.`);
                return;
            }
            if (bytes.get_size() === 0) {
                this._setError('The radar stopped', 'It stopped sending data. Turn the radar off and on to retry.');
                return;
            }
            this._lastSampleTime = GLib.get_monotonic_time();
            this._parse(bytes.toArray());
            this._readNext();
        });
    }

    _parse(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        while (offset + HEADER_LEN <= data.length) {
            const rawLen = view.getUint32(offset + 12, true);
            const raw = data.subarray(offset + HEADER_LEN, offset + HEADER_LEN + rawLen);
            if (raw.length > PRESENCE_OFFSET) {
                const present = raw[PRESENCE_OFFSET] === 1;
                if (present !== this._present)
                    this._setPresent(present);
            }
            offset += HEADER_LEN + rawLen;
        }
    }

    _setPresent(present) {
        this._present = present;
        if (present) {
            this._cancelLock();
            // Someone approached: turn the lock screen back on so they can
            // unlock (no-op if the screen isn't blanked).
            if (Main.screenShield?.locked)
                Main.screenShield._wakeUpScreen?.();
        } else {
            this._scheduleLock();
        }
        this._updateStatus();
    }

    _onAutoLockChanged() {
        if (!this._settings.get_boolean('auto-lock'))
            this._cancelLock();
        else if (this._present === false)
            this._scheduleLock();
        this._updateStatus();
    }

    _scheduleLock() {
        if (this._lockTimeoutId || !this._settings.get_boolean('auto-lock'))
            return;
        // The radar itself already waits ~10 s before reporting
        // "nobody there"; lock-delay is extra grace on top of that.
        const delay = this._settings.get_uint('lock-delay');
        this._lockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._lockTimeoutId = 0;
            this._maybeLock();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLock() {
        if (this._lockTimeoutId) {
            GLib.source_remove(this._lockTimeoutId);
            this._lockTimeoutId = 0;
        }
    }

    _maybeLock() {
        // A closed lid usually means a docked laptop with the user still at
        // the desk, and the radar can't see through it.
        if (this._present || !Main.screenShield || Main.screenShield.locked || isLidClosed())
            return;

        if (this._settings.get_boolean('lock-when-inhibited')) {
            Main.screenShield.lock(true);
            return;
        }

        // Respect idle inhibitors (video playback, presentations, ...).
        callSessionManager('IsInhibited',
            new GLib.Variant('(u)', [IDLE_INHIBIT_FLAG]), '(b)',
            this._cancellable, (connection, result) => {
                let inhibited = false;
                try {
                    [inhibited] = connection.call_finish(result).deepUnpack();
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
                if (this._present || Main.screenShield.locked || !this._settings.get_boolean('auto-lock'))
                    return;
                if (!inhibited)
                    Main.screenShield.lock(true);
            });
    }
}
