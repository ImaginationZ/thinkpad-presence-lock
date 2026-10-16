# ThinkPad Presence Lock

A small GNOME Shell extension that **locks the screen when you walk away** and
**wakes the lock screen when you come back**, using the presence radar built
into some ThinkPads. It's the Linux version of Lenovo's Windows-only "Zero
Touch Lock" / "lock on leave".

No camera, no phone, no background service: the extension reads the radar
directly (about 4 readings per second, negligible CPU).

![The extension's icon in the top bar, next to Wi-Fi, sound and battery, in its four states](docs/top-bar.png)

## Supported hardware

This extension was written for, and tested on, the **ThinkPad X1 Nano Gen 1**
(GNOME 48, Debian 13, kernel 6.12).

| Model | Radar | Status |
|---|---|---|
| ThinkPad X1 Nano Gen 1 | Novelda XeThru | Tested, works |
| ThinkPad X1 Carbon Gen 9 | Novelda XeThru ([write-up][carbon9]) | Not tested yet |
| ThinkPad X1 Yoga (2021, likely Gen 6) | Novelda XeThru ([Novelda][ces2021]) | Not tested yet |

The untested models use the same Novelda radar, so they will likely work,
but Lenovo may have set the sensor up differently on them. Other ThinkPads
use different presence technology (for example ultrasound on the P1 Gen 6),
so they won't work with this extension.

[carbon9]: https://jussiroine.com/2021/11/a-look-at-the-human-presence-detection-sensor-in-the-lenovo-thinkpad-x1-carbon-gen-9
[ces2021]: https://medium.com/novelda-news/two-new-lenovo-laptops-with-the-novelda-hpd-sensor-launched-at-ces-2021-c82fc67f3ee7

To check yours, run:

```sh
./tools/list-sensors.sh
```

If the list includes `Xethru Presence Sensor`, it should work. Please open an
issue with the output, whether or not it works, so the table above can grow.

## Install

```sh
git clone https://github.com/ImaginationZ/thinkpad-presence-lock
cd thinkpad-presence-lock
./install.sh
```

Then log out and back in, and enable it:

```sh
gnome-extensions enable thinkpad-presence-lock@imaginationz.github.io
```

`install.sh` does two things:

1. Installs `udev/70-thinkpad-presence.rules` into `/etc/udev/rules.d/`
   (needs your password). Out of the box only root can use the sensor. The
   rule lets the logged-in user read it and switch it on and off. This is the
   only part that needs root.
2. Installs the extension for your user.

## How it behaves

- **Walk away:** the radar reports "nobody there" about 10 s after you leave.
  The extension waits another 5 s (configurable), then locks the screen.
- **Come back:** the moment the radar sees you, a blanked lock screen turns
  back on, ready for your password or fingerprint.
- **It won't lock** when:
  - the lid is closed (docked with an external monitor);
  - an app is blocking the screensaver (video playback, presentations), unless
    you turn that on in the settings;
  - the screen is already locked.
- The radar is only switched on while the extension is enabled, so turning
  the extension off also saves the power the radar uses.

## Top bar and Quick Settings

The icon sits with the system icons in the top-right corner:

| Icon | Meaning |
|---|---|
| Person at a laptop | The radar sees you |
| Laptop only | You walked away; the screen is about to lock |
| Open padlock | Auto-lock is paused |
| Warning sign | Something went wrong (see the notification) |

Quick Settings also gets a **Presence Lock** tile. Click it to pause or
resume auto-locking (the choice is kept across logins). Its arrow opens a
menu with a link to the settings.

Problems such as a missing udev rule or a lost radar connection are shown as
a notification, and the icon turns into a warning sign, even if you've
hidden the icon.

## Settings

Open them from the Extensions app, or with
`gnome-extensions prefs thinkpad-presence-lock@imaginationz.github.io`:

| Setting | Default | Meaning |
|---|---|---|
| Lock delay | 5 s | Extra wait (0–300 s) after the radar stops seeing you |
| Lock even when the screensaver is blocked | Off | Also lock during video playback or presentations |
| Show top bar icon | On | Hide the icon; the Quick Settings tile stays, and errors still show the icon |

## How it works

The Intel Sensor Hub exposes Lenovo's sensors as HID "custom" sensors
(`/sys/bus/platform/devices/HID-SENSOR-2000e1.*`, handled by the kernel's
`hid-sensor-custom` driver). The extension:

1. finds the one whose friendly name is `Xethru Presence Sensor`;
2. writes `1` to its `enable_sensor`;
3. reads samples from `/dev/HID-SENSOR-2000e1.N.auto`.

In each sample's raw report, byte 26 is the presence flag (0/1) and bytes
27–30 are the distance in millimetres. Lenovo doesn't document this; it was
worked out by watching the data while walking away from the laptop.

## Uninstall

```sh
gnome-extensions uninstall thinkpad-presence-lock@imaginationz.github.io
pkexec rm /etc/udev/rules.d/70-thinkpad-presence.rules
```

## License

GPL-2.0-or-later. Copyright 2026 Zeng Huang.
