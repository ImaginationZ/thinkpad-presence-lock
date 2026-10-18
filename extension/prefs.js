// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Zeng Huang

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PresenceLockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const delay = new Adw.SpinRow({
            title: 'Lock delay (seconds)',
            subtitle: 'Extra wait after the radar stops seeing you. The radar itself already takes about 10 seconds.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 300, step_increment: 1, page_increment: 10}),
        });
        settings.bind('lock-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);

        const inhibited = new Adw.SwitchRow({
            title: 'Lock even when the screensaver is blocked',
            subtitle: 'By default, it won’t lock while an app is playing video or presenting.',
        });
        settings.bind('lock-when-inhibited', inhibited, 'active', Gio.SettingsBindFlags.DEFAULT);

        const stayAwake = new Adw.SwitchRow({
            title: 'Stay awake while you’re here',
            subtitle: 'While the radar sees you, the screen won’t blank, lock or suspend on its own.',
        });
        settings.bind('stay-awake', stayAwake, 'active', Gio.SettingsBindFlags.DEFAULT);

        const indicator = new Adw.SwitchRow({
            title: 'Show top bar icon',
            subtitle: 'Shows whether the radar sees you. Errors are shown even when this is off.',
        });
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);

        const group = new Adw.PreferencesGroup();
        group.add(delay);
        group.add(inhibited);
        group.add(stayAwake);
        group.add(indicator);

        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);
    }
}
