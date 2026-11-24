#!/data/data/com.termux/files/usr/bin/sh
# Installs or updates the ʻOhana home hub in Termux.
set -e
BASE=https://raw.githubusercontent.com/mkpro808/my-dashboard/main/hub
curl -fsSL "$BASE/kasa_hub.py" -o "$HOME/kasa_hub.py"
[ -f "$HOME/.ohana-hub.env" ] || { : > "$HOME/.ohana-hub.env"; }
chmod 600 "$HOME/.ohana-hub.env"
cat > "$PREFIX/bin/ohana-hub" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
# Starts the hub, restarts it if it ever stops, and checks for a newer
# version every 6 hours (installs it and restarts the hub when there is one).
BASE=https://raw.githubusercontent.com/mkpro808/my-dashboard/main/hub
termux-wake-lock 2>/dev/null || true
[ -f "$HOME/.ohana-hub.env" ] && . "$HOME/.ohana-hub.env"
export KASA_USERNAME KASA_PASSWORD
if curl -fs http://127.0.0.1:8738/ >/dev/null 2>&1; then echo "The hub is already running."; exit 0; fi
update() {
  curl -fsSL "$BASE/kasa_hub.py" -o "$HOME/.kasa_hub.new" 2>/dev/null || return 1
  python -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$HOME/.kasa_hub.new" 2>/dev/null || { rm -f "$HOME/.kasa_hub.new"; return 1; }
  if [ "$(cksum < "$HOME/.kasa_hub.new")" != "$(cksum < "$HOME/kasa_hub.py")" ]; then
    mv "$HOME/.kasa_hub.new" "$HOME/kasa_hub.py"; echo "$(date +%H:%M:%S) helper updated to the newest version"; return 0
  fi
  rm -f "$HOME/.kasa_hub.new"; return 1
}
PID=""
trap '[ -n "$PID" ] && kill $PID 2>/dev/null; exit 0' INT TERM
update
while true; do
  python "$HOME/kasa_hub.py" &
  PID=$!
  n=0
  while kill -0 $PID 2>/dev/null; do
    sleep 60; n=$((n+1))
    if [ $n -ge 360 ]; then
      n=0
      if update; then kill $PID 2>/dev/null; wait $PID 2>/dev/null; break; fi
    fi
  done
  wait $PID 2>/dev/null
  PID=""
  echo "hub stopped; restarting in 10 seconds"; sleep 10
done
RUN
chmod 700 "$PREFIX/bin/ohana-hub"
cat > "$PREFIX/bin/ohana-login" <<'LOGIN'
#!/data/data/com.termux/files/usr/bin/bash
# Saves the Kasa (TP-Link) login the hub uses. Special characters are kept exactly.
printf "Kasa email: "; read -r U
printf "Kasa password (hidden as you type): "; stty -echo; read -r P; stty echo; echo
umask 077
{ printf "export KASA_USERNAME=%q\n" "$U"; printf "export KASA_PASSWORD=%q\n" "$P"; } > "$HOME/.ohana-hub.env"
unset U P
echo "Saved. Now start the helper again with:  ohana-hub"
LOGIN
chmod 700 "$PREFIX/bin/ohana-login"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/ohana-hub" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
ohana-hub >> "$HOME/hub.log" 2>&1
BOOT
chmod 700 "$HOME/.termux/boot/ohana-hub"
echo "Installed. Start it with:  ohana-hub"
