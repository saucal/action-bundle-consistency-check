# Bring act's runner image up to what the steps assume a GitHub runner already has:
# apt package lists (deploy-ssh's pre step installs sshpass), rsync, PHP + Composer
# (bundle-prepare's composer auth runs before any setup-php step in the check workflow),
# and the gh CLI (reconcile opens its PR with it). php8.3-dev ships php-config, which setup-php
# needs to accept the installed PHP as found (as on GitHub's image) instead of reinstalling it
# every job; the harness pins PHP_VERSION=8.3 to match.
FROM catthehacker/ubuntu:act-latest
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends sshpass rsync unzip gh \
      php-cli php-curl php-mbstring php-xml php-zip php8.3-dev composer \
 && rm -rf /var/lib/apt/lists/*
