#!/data/data/com.termux/files/usr/bin/sh
# Installs or updates the ʻOhana home hub in Termux.
set -e
BASE=https://raw.githubusercontent.com/mkpro808/my-dashboard/main/hub
curl -fsSL "$BASE/kasa_hub.py" -o "$HOME/kasa_hub.py"
[ -f "$HOME/.ohana-hub.env" ] || { : > "$HOME/.ohana-hub.env"; }
chmod 600 "$HOME/.ohana-hub.env"
cat > "$PREFIX/bin/ohana-hub" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
# Starts the hub; restarts it if it ever stops.
termux-wake-lock 2>/dev/null || true
[ -f "$HOME/.ohana-hub.env" ] && . "$HOME/.ohana-hub.env"
export KASA_USERNAME KASA_PASSWORD
if curl -fs http://127.0.0.1:8738/ >/dev/null 2>&1; then echo "The hub is already running."; exit 0; fi
while true; do
  python "$HOME/kasa_hub.py"
  echo "hub stopped; restarting in 10 seconds"; sleep 10
done
RUN
chmod 700 "$PREFIX/bin/ohana-hub"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/ohana-hub" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
ohana-hub >> "$HOME/hub.log" 2>&1
BOOT
chmod 700 "$HOME/.termux/boot/ohana-hub"
echo "Installed. Start it with:  ohana-hub"
