#!/bin/sh
# List the Lenovo custom HID sensors on this machine, to check whether it has
# a presence radar the extension can use. Please include the output when
# reporting a model as working or not working.

printf 'Model: %s %s\n\n' "$(cat /sys/class/dmi/id/sys_vendor)" "$(cat /sys/class/dmi/id/product_version)"

found=0
for dir in /sys/bus/platform/devices/HID-SENSOR-2000e1.*; do
    [ -d "$dir" ] || continue
    found=1
    for name in "$dir"/feature-*/feature-*-name; do
        [ "$(cat "$name")" = property-friendly-name ] || continue
        friendly=$(awk '{ for (i = 1; i <= NF; i++) if ($i > 0) printf "%c", $i }' "${name%-name}-value")
        printf '%-28s %s\n' "${dir##*/}" "$friendly"
    done
done

[ "$found" = 1 ] || echo "No Lenovo custom sensors found."
