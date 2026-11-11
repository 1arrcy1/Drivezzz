#!/usr/bin/env bash
# The test server's setup, as root, run by deploy-test.sh. Safe to run again. It never touches the live service, its data or its keys.
set -euo pipefail
NODE=/opt/drivezzz/node/bin/node
id drivezzz-test >/dev/null 2>&1 || useradd --system --home /var/lib/drivezzz-test --shell /usr/sbin/nologin drivezzz-test
mkdir -p /var/lib/drivezzz-test/driver/devnet
chown -R drivezzz-test:drivezzz-test /var/lib/drivezzz-test
chmod 700 /var/lib/drivezzz-test
chown -R root:root /opt/drivezzz-test
chmod -R go+rX /opt/drivezzz-test
cp /opt/drivezzz-test/server/deploy/drivezzz-test.service /opt/drivezzz-test/server/deploy/drivezzz-test-driver.service /etc/systemd/system/
# An admin login of its own. The password is only to get in, the panel asks for a new one; it's in a file only root can read.
if [ ! -f /root/drivezzz-test-admin.txt ]; then
  pass=$("$NODE" -e "console.log(require('node:crypto').randomBytes(18).toString('base64url'))")
  (cd /opt/drivezzz-test/server && ADMIN_EMAIL=admin@test.local ADMIN_PASSWORD="$pass" DATA_DIR=/var/lib/drivezzz-test \
    runuser -u drivezzz-test -- "$NODE" --disable-warning=ExperimentalWarning src/make-admin.js >/dev/null)
  (umask 077; printf 'http://your-server:8090/admin\nadmin@test.local\n%s\n' "$pass" > /root/drivezzz-test-admin.txt)
fi
# Three more around Den Haag Centraal, each asking something else, so the map has a market to show.
cp /opt/drivezzz-test/server/deploy/drivezzz-test-driver@.service /etc/systemd/system/
another_driver() { # key, name, cents per km, lat, lng
  printf 'TEST_DRIVER_NAME="%s"\nTEST_DRIVER_PER_KM=%s\nTEST_DRIVER_LAT=%s\nTEST_DRIVER_LNG=%s\n' "$2" "$3" "$4" "$5" > "/etc/default/drivezzz-test-driver-$1"
}
another_driver a "Test driver A" 60 52.0805 4.3160
another_driver b "Test driver B" 120 52.0780 4.3195
another_driver c "Test driver C" 180 52.0770 4.3140
systemctl daemon-reload
systemctl enable drivezzz-test drivezzz-test-driver drivezzz-test-driver@a drivezzz-test-driver@b drivezzz-test-driver@c >/dev/null 2>&1
systemctl restart drivezzz-test
systemctl restart drivezzz-test-driver drivezzz-test-driver@a drivezzz-test-driver@b drivezzz-test-driver@c
