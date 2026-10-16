// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Zeng Huang

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SYSFS_DIR = '/sys/bus/platform/devices';
const SENSOR_PREFIX = 'HID-SENSOR-2000e1.';
const SENSOR_NAME = 'Xethru Presence Sensor';

// Each sample read from /dev/HID-SENSOR-*: usage (u32), timestamp (u64),
// raw length (u32), then the raw report. Byte 26 of the report is the
// presence flag (0/1), bytes 27-30 the distance in mm.
const HEADER_LEN = 16;
const PRESENCE_OFFSET = 26;

const IDLE_INHIBIT_FLAG = 8;

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

export default class PresenceLockExtension extends Extension {
    enable() {
        this._sensor = findSensor();
        if (!this._sensor) {
            console.warn(`${this.metadata.name}: no presence sensor found`);
            return;
        }

        this._settings = this.getSettings();
        writeText(`${SYSFS_DIR}/${this._sensor}/enable_sensor`, '1');

        try {
            this._fileStream = Gio.File.new_for_path(`/dev/${this._sensor}`).read(null);
        } catch (e) {
            console.warn(`${this.metadata.name}: cannot open sensor, is the udev rule installed? ${e.message}`);
            return;
        }
        // Wrap the fd in a pollable stream so reads never block a thread
        // and cancel cleanly on disable().
        this._stream = GioUnix.InputStream.new(this._fileStream.get_fd(), false);
        this._cancellable = new Gio.Cancellable();
        this._present = null;
        this._readNext();
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._lockTimeoutId) {
            GLib.source_remove(this._lockTimeoutId);
            this._lockTimeoutId = 0;
        }
        this._stream = null;
        this._fileStream?.close(null);
        this._fileStream = null;
        if (this._sensor)
            writeText(`${SYSFS_DIR}/${this._sensor}/enable_sensor`, '0');
        this._sensor = null;
        this._settings = null;
    }

    _readNext() {
        this._stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`${this.metadata.name}: sensor read failed: ${e.message}`);
                return;
            }
            if (bytes.get_size() === 0)
                return;
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
            if (raw.length > PRESENCE_OFFSET)
                this._setPresent(raw[PRESENCE_OFFSET] === 1);
            offset += HEADER_LEN + rawLen;
        }
    }

    _setPresent(present) {
        if (present === this._present)
            return;
        this._present = present;

        if (present) {
            if (this._lockTimeoutId) {
                GLib.source_remove(this._lockTimeoutId);
                this._lockTimeoutId = 0;
            }
            // Someone approached: turn the lock screen back on so they can
            // unlock (no-op if the screen isn't blanked).
            if (Main.screenShield?.locked)
                Main.screenShield._wakeUpScreen?.();
        } else if (!this._lockTimeoutId) {
            // The radar itself already waits ~10 s before reporting
            // "nobody there"; lock-delay is extra grace on top of that.
            const delay = this._settings.get_uint('lock-delay');
            this._lockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._lockTimeoutId = 0;
                this._maybeLock();
                return GLib.SOURCE_REMOVE;
            });
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
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'IsInhibited',
            new GLib.Variant('(u)', [IDLE_INHIBIT_FLAG]), new GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                let inhibited = false;
                try {
                    [inhibited] = connection.call_finish(result).deepUnpack();
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
                if (!inhibited && !this._present && !Main.screenShield.locked)
                    Main.screenShield.lock(true);
            });
    }
}
